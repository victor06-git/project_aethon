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
  "source": "model | rules"
}
```

The UI shows `figure` large, `range` small, a bar chart for `rows`, a send-it-yourself letter for `letter`,
"View in 3D City →" when `scenarioId` is set, and tappable `examples` for `clarify`.

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
