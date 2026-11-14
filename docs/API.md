# HTTP API

JSON over HTTP. The same router runs in the Node server and inside the standalone file.
Errors: `{ "message": string }` with status 400/404/500.

## Personal Economic Trainer

The trainer API is stateless (it runs as a Vercel function). The client keeps the trainer `state`
(corrections, goal in progress, agreed plan, multi-bank switch) in `localStorage`, sends it with each
request and stores the `state` that comes back. The server validates it every time.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/trainer/status` | | `{ model, research, data, starters[] }`: is Gemini on, is Exa on, data source |
| GET, POST | `/api/trainer/cashflow` | `{ state? }` | three baskets, `safe` (weekly safe-to-spend with `steps`), `safeToSave`, `free`, `income` |
| POST | `/api/trainer/chat` | `{ messages: [{ role: "user"\|"assistant", text }], state? }` | `{ answer, state }` |
| POST | `/api/trainer/action` | `{ action: { name, args }, state? }` | `{ answer, state }`: one tool, for buttons, toggles and sliders |

`answer` is the coach answer below plus optional cards: `steps` (math), `baskets`, `review` (assumptions to
confirm), `goal` (with `options` found on the web and `benchmarks` with their source), `scenarios` (comparison,
each with `upfront`), `sources` (web citations), `plan`, `choices` (after a change), `nextStep`, `followUps`.
`type` is also `cashflow | brief | scenario | plan | research | chat`. A goal starts as a `brief` and is simulated
only after `confirm_brief`. `source` is `model` when Gemini wrote the text, `rules` otherwise.

Tools (the `name` of an action, and what Gemini calls): `get_safe_to_spend`, `get_baskets`, `query_spending`,
`get_spending_profile`, `reclassify`, `simulate_goal`, `confirm_brief`, `what_if`, `research_goal`, `choose_option`,
`search_web`, `apply_benchmark`, `agree_plan`, `set_monitoring`, `set_recheck_permission`, `recheck_plan`,
`choose_path`, `get_plan`, `ask_coach`, `set_multibank`. Arguments: `backend/src/application/trainerTools.ts`.

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
