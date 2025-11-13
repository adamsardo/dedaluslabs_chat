<!-- be8bb3dc-fcf2-43bc-ba4d-3be8ffdd7202 9e7100f8-002a-4ed3-b237-171b947fca20 -->
# Chatbot Example Build

## Summary

Implement the chatbot demo from AI Elements by replacing the landing page with the interactive chat UI and exposing the `/api/chat` streaming endpoint.

## Implementation Steps

- update-client: Replace the placeholder home page in [src/app/page.tsx](src/app/page.tsx) with the client-side `ChatBotDemo` component, wiring up `PromptInput`, `Conversation`, model picker, web search toggle, and regenerate/copy actions.
- add-api-route: Create [src/app/api/chat/route.ts](src/app/api/chat/route.ts) that uses `streamText` to proxy chat requests, switching to `perplexity/sonar` when web search is enabled and returning reasoning and source parts.
- note-config: Confirm `.env.local` instructions for the AI Gateway key so the user can run the example locally once the code is in place.

## Todos

- update-client: Implement the ChatBotDemo UI in the home page using AI Elements components.
- add-api-route: Add the streaming chat route handling model selection, optional web search, and attachments.
- note-config: Document the required AI Gateway key in `.env.local` for running the demo.

### To-dos

- [ ] Implement the ChatBotDemo UI in the home page using AI Elements components.
- [ ] Add the streaming chat route handling model selection, optional web search, and attachments.
- [ ] Document the required AI Gateway key in .env.local for running the demo.