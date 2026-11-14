// QuestionClassifier adapter: deterministic keyword rules. The fallback when the model
// is off, unavailable or unsure.
import type { Route } from '../../domain/types';
import type { QuestionClassifier } from '../../application/ports';

export function classifyByRules(question: string): Route {
  const q = String(question ?? '').trim().toLowerCase();
  if (!q) return { intent: 'clarify' };
  const has = (...words: string[]) => words.some((w) => q.includes(w));

  if (has('safely spend', 'safe to spend', 'how much can i spend')) return { intent: 'fact', id: 'safe_to_spend' };
  if (has('rent') && has('increase', 'went up', 'raised', 'legal', 'letter', 'higher')) return { intent: 'action', id: 'rent_increase' };
  if (has('taxi')) return { intent: 'fact', id: 'taxi_total' };
  if (has('where') && has('money')) return { intent: 'fact', id: 'breakdown' };
  if (has('food delivery', 'wolt', 'foodora', 'delivery') && has('stop', 'cut', 'less', 'reduce', 'no longer')) return { intent: 'forecast', id: 'stop_food' };
  if (has('mortgage', 'interest rate', 'loan rate')) return { intent: 'forecast', id: 'mortgage_rate' };
  if (has('cinema', 'theatre', 'theater', 'football') && has('stop', 'cut', 'less', 'skip')) return { intent: 'forecast', id: 'cut_leisure' };
  return { intent: 'clarify' };
}

export const createRulesClassifier = (): QuestionClassifier => ({ classify: classifyByRules });
