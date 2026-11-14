# Project Aethon · Revi Finance

Revi · S-mobiili preview: a clickable S-mobiili banking app with the Revi coach built in.
Three modes: bank only, bank + Revi, side by side. Unofficial hackathon prototype
(Junction 2026, S-Pankki challenge); not the bank's software.

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

Setup for real data: put the dataset CSVs in `data/` (`tx_junction_transactions.csv` from
github.com/hackjunction/Junction-2026-S-pankki). The key goes in `.env` (see `.env.example`).

## Structure

Backend: clean architecture with ports and adapters. Frontend: MVC in React.
Python model work: `src/project_aethon/` and `notebook/`.
Details and who owns which folder: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). HTTP contract: [`docs/API.md`](docs/API.md).

## What is real and what is demo

| Real (server mode, from the S-Pankki dataset) | Demo fixtures |
|---|---|
| Account balance, transactions, invested amount, "where is my money going", taxi total | Cards, loans, bonus, offers, upcoming/recurring payments, scenarios and City values, safe-to-spend |

The model only classifies questions; figures come from the data and the engine. Without a key, or if the
model fails, keyword rules answer and the app keeps working.

## Personal Economic Trainer

Revi sorts every payment into S-Pankki's three baskets (mandatory & regular, mandatory & irregular, everyday),
shows a weekly safe-to-spend with its math, lets you correct its assumptions, simulates big decisions
("Could I buy a car next year?") with what-ifs, and keeps an agreed plan it can re-check.

- **Gemini** (`GEMINI_API_KEY`, `gemini-2.5-flash`, `@google/genai`) answers by function calling: it picks tools,
  the app computes every figure, and a reply with a figure no tool returned is replaced by the computed text.
- **Exa** (`EXA_API_KEY`) does the outside research. `research_goal` runs structured Exa searches for a goal (current options
  and typical price, running costs beyond the price, loan conditions) and uses a figure only when Exa names a source for it
  with medium or high confidence, or a returned passage states the number. `search_web` answers open questions with passages and sources.
- A goal starts as a brief you confirm. After agreeing a plan you choose what is monitored (prices, conditions, your spending);
  monitoring runs when you open the plan, not in the background. When something changed you choose: contribute less, reach the goal sooner, or keep a larger buffer.
- Without keys, keyword rules call the same tools. The standalone file works the same way.
- Deploy: Vercel services in `vercel.json` (`app` = Vite frontend, `api` = `backend/src/interfaces/http/vercel.ts`).
  Set `GEMINI_API_KEY` and `EXA_API_KEY` in the Vercel project. `?embed` or a phone-width window shows the app without the preview frame.
