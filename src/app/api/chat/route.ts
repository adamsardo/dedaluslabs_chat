import {
  createUIMessageStreamResponse,
  type FinishReason,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

const SYSTEM_PROMPT =
  "You are a helpful assistant that can answer questions and help with tasks";
const WEB_SEARCH_MCP_SERVERS = [
  "joerup/exa-mcp",
  "windsor/brave-search-mcp",
];
const DEDALUS_DEFAULT_BASE_URL = "https://api.dedaluslabs.ai";

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const {
    messages,
    model,
    webSearch,
  }: {
    messages: UIMessage[];
    model: string;
    webSearch: boolean;
  } = await req.json();

  try {
    const stream = await runDedalusChat({
      messages,
      requestedModel: model,
      webSearch,
    });

    return createUIMessageStreamResponse({
      stream,
      sendSources: webSearch,
    });
  } catch (error) {
    console.error("Dedalus request failed", error);

    if (isDedalusAPIError(error)) {
      return error.response;
    }

    return new Response(
      JSON.stringify({ error: "Unable to complete request at this time." }),
      {
        status: 502,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

function resolveDedalusModel(requestedModel: string | undefined): string {
  if (!requestedModel || requestedModel === "perplexity/sonar") {
    return "openai/gpt-4.1";
  }
  return requestedModel;
}

type TextMessagePart = Extract<UIMessage["parts"][number], { type: "text" }>;

function isTextPart(part: UIMessage["parts"][number]): part is TextMessagePart {
  return part.type === "text";
}

function toDedalusMessages(
  messages: UIMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => {
      const text = message.parts
        .filter(isTextPart)
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join("\n");

      return {
        role: message.role,
        content: text,
      };
    })
    .filter((message) => message.content.length > 0);
}

function collectCitations(
  choice: DedalusCompletionChoice | null,
): Array<{ url: string; title?: string | null }> {
  const annotations = choice?.message?.annotations ?? [];
  const unique = new Map<string, { url: string; title?: string | null }>();

  for (const annotation of annotations) {
    if (annotation?.type !== "url_citation") {
      continue;
    }

    const citation = annotation.url_citation;
    if (!citation || typeof citation.url !== "string" || !citation.url) {
      continue;
    }

    unique.set(citation.url, {
      url: citation.url,
      title:
        typeof citation.title === "string" && citation.title.length > 0
          ? citation.title
          : citation.url,
    });
  }

  return Array.from(unique.values());
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
    case "length":
      return reason;
    case "content_filter":
      return "content-filter";
    case "tool_calls":
    case "function_call":
      return "tool-calls";
    case null:
    case undefined:
      return "stop";
    default:
      return "other";
  }
}

function createDedalusStream({
  text,
  citations,
  finishReason,
}: {
  text: string;
  citations: Array<{ url: string; title?: string | null }>;
  finishReason: FinishReason;
}): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      const messageId = crypto.randomUUID();
      const textId = crypto.randomUUID();

      controller.enqueue({ type: "start", messageId });
      controller.enqueue({ type: "text-start", id: textId });

      if (text.length > 0) {
        controller.enqueue({ type: "text-delta", id: textId, delta: text });
      }

      controller.enqueue({ type: "text-end", id: textId });

      citations.forEach(({ url, title }, index) => {
        controller.enqueue({
          type: "source-url",
          sourceId: `citation-${index}`,
          url,
          title: title ?? url,
        });
      });

      controller.enqueue({ type: "finish", finishReason });
      controller.close();
    },
  });
}

async function runDedalusChat({
  messages,
  requestedModel,
  webSearch,
}: {
  messages: UIMessage[];
  requestedModel: string | undefined;
  webSearch: boolean;
}): Promise<ReadableStream<UIMessageChunk>> {
  const apiKey = process.env.DEDALUS_API_KEY;
  if (!apiKey) {
    throw new DedalusAPIError(
      500,
      "Missing DEDALUS_API_KEY environment variable.",
      JSON.stringify({
        error:
          "Missing DEDALUS_API_KEY environment variable. Set it in your environment or .env.local file.",
      }),
    );
  }

  const baseURL =
    process.env.DEDALUS_BASE_URL ?? DEDALUS_DEFAULT_BASE_URL;
  const dedalusMessages = toDedalusMessages(messages);
  const messagePayload: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [
    { role: "system", content: SYSTEM_PROMPT },
    ...dedalusMessages,
  ];
  const payload = {
    model: resolveDedalusModel(requestedModel),
    messages: messagePayload,
    mcp_servers: webSearch ? WEB_SEARCH_MCP_SERVERS : undefined,
    stream: false,
  };

  let response: Response;
  try {
    response = await fetch(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new DedalusAPIError(
      502,
      "Failed to reach Dedalus API.",
      JSON.stringify({
        error:
          "Failed to reach Dedalus API. Please check your network connection and try again.",
      }),
    );
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw createDedalusAPIError(response.status, bodyText);
  }

  let completion: DedalusCompletionResponse;
  try {
    completion = JSON.parse(bodyText) as DedalusCompletionResponse;
  } catch {
    throw new DedalusAPIError(
      502,
      "Invalid JSON response from Dedalus.",
      JSON.stringify({
        error: "Invalid JSON response from Dedalus.",
      }),
    );
  }

  const choice = completion.choices?.[0] ?? null;
  const text = normalizeMessageContent(choice?.message?.content);
  const citations = webSearch ? collectCitations(choice) : [];
  const finishReason = mapFinishReason(choice?.finish_reason);

  return createDedalusStream({ text, citations, finishReason });
}

function normalizeMessageContent(
  content: DedalusMessage["content"] | undefined,
): string {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part?.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }

  return "";
}

function createDedalusAPIError(
  status: number,
  bodyText: string,
): DedalusAPIError {
  if (status === 402) {
    return new DedalusAPIError(
      status,
      "Your Dedalus account balance is negative. Please top up credits before using web search.",
      JSON.stringify({
        error:
          "Your Dedalus account balance is negative. Please top up credits before using web search.",
      }),
    );
  }

  try {
    const parsed = bodyText ? JSON.parse(bodyText) : null;
    const detail =
      typeof parsed?.detail === "string"
        ? parsed.detail
        : parsed?.detail && typeof parsed.detail === "object"
        ? JSON.stringify(parsed.detail)
        : undefined;

    const message =
      detail ??
      (typeof parsed?.error === "string"
        ? parsed.error
        : "Unexpected error from Dedalus.");

    return new DedalusAPIError(
      status,
      message,
      JSON.stringify({ error: message }),
    );
  } catch {
    const fallback = bodyText || "Unexpected error from Dedalus.";
    return new DedalusAPIError(
      status,
      fallback,
      JSON.stringify({ error: fallback }),
    );
  }
}

class DedalusAPIError extends Error {
  constructor(
    public status: number,
    message: string,
    private body: string,
  ) {
    super(message);
  }

  get response(): Response {
    return new Response(this.body, {
      status: this.status,
      headers: { "content-type": "application/json" },
    });
  }
}

function isDedalusAPIError(error: unknown): error is DedalusAPIError {
  return error instanceof DedalusAPIError;
}

type DedalusCompletionResponse = {
  choices?: DedalusCompletionChoice[];
};

type DedalusCompletionChoice = {
  finish_reason?: string | null;
  message?: DedalusMessage | null;
};

type DedalusMessage = {
  content?: string | DedalusMessagePart[] | null;
  annotations?: DedalusAnnotation[] | null;
};

type DedalusMessagePart = {
  type?: string;
  text?: string | null;
};

type DedalusAnnotation = {
  type?: string;
  url_citation?: {
    url?: string;
    title?: string | null;
  } | null;
};

