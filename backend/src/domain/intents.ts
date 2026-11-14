// Single source of truth for what the coach can answer.
// The model prompt, the rules classifier and the coach service all read this list:
// add a question type here first, then teach the engine/rules to answer it.
import type { Intent } from './types';

export const INTENTS: Record<Exclude<Intent, 'clarify'>, Record<string, string>> = {
  fact: {
    safe_to_spend: 'how much the user can safely spend now',
    taxi_total: 'how much the user spent on taxis',
    breakdown: "where the user's money is going, by category"
  },
  forecast: {
    stop_food: 'what happens if the user stops ordering food delivery',
    mortgage_rate: 'what happens if the mortgage interest rate changes',
    cut_leisure: 'what happens if the user skips cinema, theatre or football'
  },
  action: {
    rent_increase: 'help with a rent increase: legality and a letter to the landlord'
  }
};

export function isSupported(intent: Intent, id?: string | null): boolean {
  if (intent === 'clarify' || !id) return false;
  return Object.prototype.hasOwnProperty.call(INTENTS[intent], id);
}
