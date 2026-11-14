# Project Aethon · Kaiku Finance

Kaiku · S-mobiili preview: a clickable S-mobiili banking app with the Kaiku coach built in.
Three modes: bank only, bank + Kaiku, side by side. Unofficial hackathon prototype
(Junction 2026, S-Pankki challenge); not the bank's software.

Stack: React + TypeScript (Vite) frontend, TypeScript backend on Node 22, Python for the model side.

## Run

```bash
npm install            # once
npm start              # app + API with live reload → http://localhost:3000
npm run build          # dist/kaiku-preview.html: one file, opens by double-click (demo data)
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
