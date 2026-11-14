# HTTP API

JSON over HTTP. The same router runs in the Node server and inside the standalone file.
Errors: `{ "message": string }` with status 400/404/500.

## Coach (Revi)

### `POST /api/coach/messages`
Request: `{ "question": string }` (1–500 characters).

Response (one answer; fields beyond `type` and `text` are optional):

```json
{
  "type": "fact | forecast | action | clarify",
  "text": "Short explanation",
  "figure": "+€540 in your cushion after six months",
  "range": "Range €430–€650",
  "confidence": "low | medium | high",
  "scenarioId": "stop_food",
  "rows": [{ "label": "Groceries", "amount": 379.79 }],
  "letter": { "subject": "…", "body": "…" },
  "examples": ["Suggested question", "…"],
  "source": "model | rules",
  "sources": [{ "k": 1, "official": true, "domain": "kela.fi", "title": "…", "url": "https://…", "published": "2026-01-02", "fragment": "quoted text…" }],
  "dataUsed": { "period": "2026-10-01 to 2026-10-31", "transactions": 2, "note": "synthetic sample transactions" },
  "trace": { "route": "web", "decidedBy": "model", "llmCalls": 2, "tokens": 1120, "seconds": 9.6 },
  "noEvidence": false
}
```

The UI shows `figure` large, `range` small, a bar chart for `rows`, a send-it-yourself letter for `letter`,
"View in 3D City →" when `scenarioId` is set, and tappable `examples` for `clarify`.

`sources`, `dataUsed`, `trace` and `noEvidence` come from the **Kaiku coach** (the Python service in
`src/project_aethon/kaiku_service.py`, enabled with `REVI_KAIKU_URL`): numbered citations tagged
OFFICIAL/WEB with the quoted fragment, date and link, rendered under "Sources" in the assistant.
When Kaiku is on, it answers letters and every question outside the local intent list; if it fails,
the local coach answers and the app keeps working.

### Other coach routes
| Method | Path | Returns |
|---|---|---|
| GET | `/api/coach/suggestions` | `[{ id, text, note }]` |
| GET | `/api/coach/expenses` | `{ mandatory[], priority[], flexible[] }` |
| GET | `/api/coach/scenarios` | scenarios: `{ id, title, headline, range, summary, horizonMonths, events[], city: { start, later } }` |
| GET | `/api/coach/scenarios/:id` | one scenario |
| GET | `/api/coach/scenarios/:id/at?day=N` | `{ id, day, values: { mandatory, unexpected, small, cushion, debt }, confidence: 0..1 }` |

## Banking
| Method | Path | Returns |
|---|---|---|
| GET | `/api/bootstrap` | bank, profile, data source, suggestions, safe-to-spend |
| GET | `/api/home` | first name, total balance, invested, bonus, upcoming count, recent transactions, `asOf` |
| GET | `/api/accounts`, `/api/accounts/:id` | accounts with balances; one account with recent transactions |
| GET | `/api/transactions?limit=N` | newest first: `{ id, date, merchant, category, coachKey, amount, balanceAfter?, mcc? }` |
| GET | `/api/cards`, `/api/loans`, `/api/loans/mortgage`, `/api/investments` | products |
| GET | `/api/purchases`, `/api/receipts`, `/api/receipts/:id`, `/api/offers`, `/api/stores`, `/api/bonus` | shopping and Bonus |
| GET | `/api/payments/upcoming`, `/api/payments/recurring`, `/api/messages`, `/api/profile` | other |
| POST | `/api/payments`, `/api/transfers`, `/api/letters/send` | demo only: nothing is sent |
