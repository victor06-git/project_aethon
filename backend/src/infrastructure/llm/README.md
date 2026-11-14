# Model adapters (owned by the model / prompts / chat teammate)

This folder is the model's side of the `QuestionClassifier` port (see `backend/src/application/ports.ts`).
Change prompts, models and providers here freely: nothing else in the project imports these files
except `interfaces/http/server.ts`, through `createLlm(config)`.

Contract the rest of the app relies on:

- `createLlm(config)` returns `null` (model off) or an object with `classify(question)`.
- `classify(question)` resolves to `{ intent: 'fact'|'forecast'|'action'|'clarify', id: string|null }`.
- The model never returns figures. Numbers come from the engine and the user's transactions.
- Supported ids are listed in `prompt.ts`; the application ignores anything else and falls back to the rules.
- Throwing is fine: the app logs `[revi] model failed, using rules: ...` and answers with the rules.

Files:
- `prompt.ts` — system prompt shared by every adapter.
- `geminiClassifier.ts` — Gemini `generateContent`, key in the `x-goog-api-key` header.
- `httpClassifier.ts` — any OpenAI-compatible endpoint (e.g. a self-hosted Gemma).
- `index.ts` — picks the adapter from config.

To go further than classification (your own chat flow, tools, RAG), implement the whole coach
behind the same HTTP contract (`POST /api/coach/messages`, see `docs/API.md`) and wire it in
`backend/src/container.ts`. The frontend only depends on that contract.
