# Architecture

One repository, three parts:

- **backend/** — TypeScript on Node 22, clean architecture (domain → application → infrastructure → interfaces).
- **frontend/** — React + TypeScript (Vite), MVC: model (data, chat, City state), views (components), controller (navigation).
- **src/project_aethon/** and **notebook/** — the Python side (model, prompts, chat agent, evaluation), owned by the model teammate.

```
project_aethon/
├─ backend/src/
│  ├─ domain/                    pure rules and types, no I/O
│  │  ├─ types.ts                Transaction, Scenario, Answer… shared with the frontend
│  │  ├─ money.ts                rounding, sums
│  │  ├─ categories.ts           dataset vocabulary: MCC → merchant label, coach keys (taxi, food_delivery…)
│  │  └─ intents.ts              what the coach can answer: ONE list for prompt, rules and service
│  ├─ application/               use cases; depend only on ports
│  │  ├─ ports.ts                contracts: TransactionRepository, QuestionClassifier, ForecastEngine, Catalog
│  │  ├─ bankService.ts          accounts, balance, transactions, products
│  │  └─ coachService.ts         question → classifier → rules fallback → answer (figures from engine/data)
│  ├─ infrastructure/            adapters that implement the ports
│  │  ├─ repositories/           csvTransactions.ts (S-Pankki dataset, Node only), fixtureTransactions.ts, fixtureCatalog.ts
│  │  ├─ engine/scenarioEngine.ts    ForecastEngine: hand-set scenarios (echo engine goes here)
│  │  ├─ classifiers/rulesClassifier.ts   keyword fallback
│  │  ├─ llm/                    model adapters: Gemini, OpenAI-compatible (e.g. a Python service), prompt   ← model teammate
│  │  └─ fixtures/*.json         demo data
│  ├─ interfaces/http/           router.ts (controllers, no logic), server.ts (API + React app via Vite)
│  ├─ config/index.ts            env + .env
│  └─ container.ts               composition root: picks adapters for ports
├─ frontend/
│  ├─ index.html, styles.css
│  └─ src/
│     ├─ models/                 M: phoneModel.ts (cache, chat, City state), hooks.ts, transport/http.ts | offline.ts
│     ├─ views/                  V: React components, no state of their own beyond UI details
│     │  ├─ layout/Layout.tsx    status bar, permanent header, tab bars, modal
│     │  ├─ screens/bank/*.tsx   S-mobiili screens; screens/index.ts registry
│     │  ├─ kaiku/               CityView, city3d.ts (3D renderer), KaikuCard, Assistant, KaikuScreens
│     │  └─ components.tsx, icons.tsx, format.ts
│     ├─ controllers/            C: PhoneController.tsx (navigation, assistant), nav.ts (what views may ask for)
│     ├─ App.tsx                 modes: bank / bank + Kaiku / side by side
│     └─ main.tsx
├─ src/project_aethon/           Python package (kaiku_agent.py, kaiku_eval.py, __init__.py)   ← model teammate
├─ notebook/                     Jupyter notebooks (kaiku_test.ipynb)                          ← model teammate
├─ tests/                        contract tests (npm test)
├─ tools/check-llm.ts            tests the model key
├─ docs/                         ARCHITECTURE.md, API.md
├─ data/                         S-Pankki CSVs (git-ignored)
├─ vite.config.ts, tsconfig.json, package.json
└─ dist/kaiku-preview.html       standalone build (git-ignored)
```

## Dependency rule

`domain` ← `application` ← `infrastructure` / `interfaces`. Services never import an adapter;
`container.ts` (and `server.ts` for Node-only adapters) connects them. The frontend talks to the
backend only through the HTTP contract in `docs/API.md`; it imports backend *types* only.
The standalone build runs the same backend container inside the browser (`models/transport/offline.ts`).

## Who works where

| Area | Owner | Folders | Must keep |
|---|---|---|---|
| Model, prompts, chat agent, evaluation (Python) | Model teammate | `src/project_aethon/`, `notebook/`, `backend/src/infrastructure/llm/` | `QuestionClassifier` port, `POST /api/coach/messages` answer shape |
| Echo engine (forecasts, learning) | Model teammate | `backend/src/infrastructure/engine/` | `ForecastEngine` port |
| Data ingestion | Data / model teammate | `backend/src/infrastructure/repositories/` | `TransactionRepository` port |
| Banking UI, Kaiku UI, 3D City | UI | `frontend/` | API contract |
| Use cases, API routes | shared, change together | `backend/src/application/`, `backend/src/interfaces/http/` | API contract |

Python code reaches the app over HTTP: run it as a service and point `KAIKU_LLM_URL` at it
(`KAIKU_LLM_PROVIDER=openai`), or replace an adapter in `backend/src/infrastructure/`.

Adding a question type: add it to `domain/intents.ts` (the prompt picks it up), add a keyword rule,
then answer it in `application/coachService.ts` (fact/action) or add a scenario to the engine (forecast).
`assertPort()` checks adapters at start-up; `npm test` checks the contracts; `npm run typecheck` checks types.

## Data

- `KAIKU_DATA_SOURCE=auto` (default): uses `data/tx_junction_transactions.csv` if it exists, otherwise fixtures.
- One customer is loaded (`KAIKU_CUSTOMER_ID`, default `CUST00001`) by streaming the 360 MB file once;
  the rows are cached in `data/.cache/<id>.json` for instant restarts.
- "Today" for the coach is the last transaction date in the data, 2026-09-30 for the dataset.
- Still demo data: cards, loans, bonus, offers, upcoming and recurring payments, scenarios, safe-to-spend.
- The standalone file always uses fixtures (no file access in the browser).

## Model

- `GEMINI_API_KEY` in `.env` (git-ignored). `KAIKU_LLM_PROVIDER=auto` uses Gemini only when a key exists.
- `KAIKU_LLM_PROVIDER=none` switches the model off without removing the key.
- The model only classifies. Any failure falls back to the rules and is logged; the app keeps working.
