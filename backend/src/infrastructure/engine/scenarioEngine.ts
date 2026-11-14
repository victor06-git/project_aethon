// ForecastEngine adapter: hand-set scenarios from fixtures/coach.json.
// The real echo engine (causal graph, learned effects, ranges) replaces this file
// and must keep the same methods (application/ports.ts → ForecastEngine).
import { round2 } from '../../domain/money';
import { httpError, type CityKey, type CityValues, type Scenario, type Suggestion } from '../../domain/types';
import type { Expenses, ForecastEngine } from '../../application/ports';
import coach from '../fixtures/coach.json';
import expenses from '../fixtures/expenses.json';

const scenarios = coach.scenarios as unknown as Record<string, Scenario>;

export function createScenarioEngine(): ForecastEngine {
  function getScenario(id: string): Scenario {
    const sc = scenarios[id];
    if (!sc) throw httpError(404, 'Scenario not found');
    return sc;
  }
  return {
    listScenarios: () => Object.values(scenarios),
    getScenario,
    // Linear between today and the horizon. Confidence: 1 today, 0.25 from six months on.
    valuesAt(id, day) {
      const sc = getScenario(id);
      const d = Math.max(0, Math.min(365, Math.round(day)));
      const f = Math.min(1, d / (sc.horizonMonths * 30));
      const values = {} as CityValues;
      for (const k of Object.keys(sc.city.start) as CityKey[]) values[k] = round2(sc.city.start[k] + (sc.city.later[k] - sc.city.start[k]) * f);
      return { id, day: d, values, confidence: round2(1 - 0.75 * Math.min(1, d / 180)) };
    },
    // The three suggested questions: a predefined list (project brief, section 3).
    suggestions: () => coach.suggestions as Suggestion[],
    safeToSpend: () => coach.safeToSpend,
    rule: (id) => (coach.rules as Record<string, { text: string; letter?: { subject: string; body: string } }>)[id] ?? null,
    expenses: () => expenses as Expenses
  };
}
