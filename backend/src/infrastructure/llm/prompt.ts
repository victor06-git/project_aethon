// Shared instruction for every model adapter. The model classifies only; it never writes figures.
// Supported ids come from domain/intents.ts, so the prompt never drifts from what the app can answer.
import { INTENTS } from '../../domain/intents';

const list = Object.entries(INTENTS)
  .map(([intent, ids]) => `- ${intent}: ${Object.entries(ids).map(([id, what]) => `${id} (${what})`).join(', ')}`)
  .join('\n');

export const SYSTEM_PROMPT = [
  "You route questions about a user's money to one supported item.",
  'Reply with JSON only: {"intent": "fact"|"forecast"|"action"|"clarify", "id": string|null}.',
  'Supported ids:',
  list,
  'If the question does not clearly match one of these, use {"intent":"clarify","id":null}.',
  'Never invent numbers.'
].join('\n');
