# Project Aethon · Revi Finance

Revi is a mobile financial coach that helps people understand their spending and plan a purchase.
The same prototype supports two separate Junction 2026 submissions: S-Pankki's Personal Economic
Trainer and Exa's Internet Butler. See the [two demo scripts](docs/JUNCTION-DEMO.md).
This is an unofficial S-mobiili preview with synthetic banking data.

Stack: React + TypeScript (Vite) frontend, TypeScript backend on Node 22, Python for the model side.

## Run

```bash
npm install            # once
npm start              # app + API with live reload → http://localhost:3000
npm run build          # dist/revi-preview.html: one file, opens by double-click (demo data)
npm test               # contract tests
npm run typecheck      # TypeScript check
npm run check:llm      # test the Gemini key
```

To use the sponsor's synthetic data, download `tx_junction_transactions.csv` from the
[official dataset repository](https://github.com/hackjunction/Junction-2026-S-pankki) into
`data/`. The large CSV uses Git LFS; use the actual CSV, rather than the pointer file.
Put service credentials in `.env` (see `.env.example`).

## Structure

Backend: clean architecture with ports and adapters. Frontend: MVC in React.
Python model work: `src/project_aethon/` and `notebook/`.
Details and who owns which folder: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). HTTP contract: [`docs/API.md`](docs/API.md).

## What is real and what is demo

| Supplied synthetic data (CSV mode) | Illustrative demo fixtures |
|---|---|
| Account balance, transaction history, investment flows, personal spending breakdown, and inputs to the trainer's affordability calculation | Cards, loans, bonus, offers, upcoming/recurring payments and the legacy City scenarios |

Figures come from the data and calculation engine. Gemini interprets the conversation and calls the engine's tools.
When Gemini is unavailable, built-in rules cover the main questions and the app's buttons still call the same tools.

## Personal Economic Trainer

Revi sorts every payment into S-Pankki's three baskets (mandatory & regular, mandatory & irregular, everyday),
shows a weekly safe-to-spend with its math, lets you correct its assumptions, simulates big decisions
("Could I buy a car next year?") with what-ifs, and keeps an agreed plan it can re-check.

- **Gemini** (`GEMINI_API_KEY`, `gemini-3.8-flash`, `@google/genai`) answers by function calling: it picks tools,
  the app computes every figure, and a reply with a figure no tool returned is replaced by the computed text.
- **Exa** (`EXA_API_KEY`) does the outside research. `research_goal` searches for current options and typical prices, running costs and loan conditions. A figure enters the plan only when a source passage supports it. `search_web` handles public questions and returns the passages and links.
- A goal starts as a brief you confirm. After agreeing a plan you choose what is monitored (prices, conditions, your spending);
  monitoring runs when you open the plan, not in the background. When something changed you choose: contribute less, reach the goal sooner, or keep a larger buffer.
- The standalone file uses illustrative data and built-in rules, with no live integrations.
- Deploy: Vercel services in `vercel.json` (`app` = Vite frontend, `api` = `backend/src/interfaces/http/vercel.ts`). Set `GEMINI_API_KEY` and `EXA_API_KEY` for the intended environment. The default deployment uses illustrative data; see the [demo runbook](docs/JUNCTION-DEMO.md#before-submitting) for an access-controlled preview with one sponsor customer. `?embed` opens the phone layout without the preview frame.
