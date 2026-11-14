// Coach use cases: route a question, then let the engine and the user's data answer it.
//   question → QuestionClassifier (model, optional) → rules fallback → answer built here
// The model only classifies. Every figure comes from the engine or the transactions.
import { round2 } from '../domain/money';
import { INTENTS, isSupported } from '../domain/intents';
import { httpError, type Answer, type Route } from '../domain/types';
import type { ForecastEngine, QuestionClassifier, TransactionRepository } from './ports';

const DAY = 86400000;
const daysBefore = (iso: string, n: number) => new Date(Date.parse(iso) - n * DAY).toISOString().slice(0, 10);

interface Deps {
  engine: ForecastEngine;
  transactions: TransactionRepository;
  rules: QuestionClassifier;
  model?: QuestionClassifier | null;
  log?: (msg: string) => void;
}

export function createCoachService({ engine, transactions, rules, model = null, log = () => {} }: Deps) {
  // Every forecast id the coach can route to must exist in the engine.
  const scenarioIds = new Set(engine.listScenarios().map((s) => s.id));
  const missing = Object.keys(INTENTS.forecast).filter((id) => !scenarioIds.has(id));
  if (missing.length) throw new Error(`ForecastEngine has no scenario for: ${missing.join(', ')}`);

  // Model output is trusted only if it names something supported. A model "clarify" is
  // not final: the rules get a second look. If neither understands, we ask to clarify.
  async function route(question: string): Promise<{ route: Route; source: 'model' | 'rules' }> {
    if (model) {
      try {
        const r = await model.classify(question);
        if (r && r.intent !== 'clarify' && isSupported(r.intent, r.id)) return { route: r, source: 'model' };
      } catch (err) {
        log(`model failed, using rules: ${(err as Error).message}`);
      }
    }
    const byRules = await rules.classify(question);
    if (byRules.intent !== 'clarify') return { route: byRules, source: 'rules' };
    return { route: { intent: 'clarify' }, source: model ? 'model' : 'rules' };
  }

  function lastDays(n: number) {
    const asOf = transactions.asOf();
    const from = daysBefore(asOf, n);
    return transactions.list().filter((t) => t.date > from && t.date <= asOf);
  }

  function answer({ intent, id }: Route): Answer {
    if (intent === 'clarify' || !isSupported(intent, id)) {
      return { type: 'clarify', text: "I didn't quite get that. Try one of these:", examples: engine.suggestions().map((s) => s.text) };
    }
    if (intent === 'fact' && id === 'safe_to_spend') {
      const s = engine.safeToSpend();
      return { type: 'fact', text: `Based on this month's necessary expenses and your balance, you can safely spend up to €${s.amount} until ${s.until}.`, figure: `€${s.amount}` };
    }
    if (intent === 'fact' && id === 'taxi_total') {
      const trips = lastDays(30).filter((t) => t.coachKey === 'taxi' && t.amount < 0);
      const total = round2(trips.reduce((s, t) => s - t.amount, 0));
      return { type: 'fact', text: `You took ${trips.length} taxi trip${trips.length === 1 ? '' : 's'} in the last 30 days.`, figure: `€${total.toFixed(2)}` };
    }
    if (intent === 'fact' && id === 'breakdown') {
      const totals: Record<string, number> = {};
      // Moving money into your own investments is saving, not spending.
      for (const t of lastDays(30)) if (t.amount < 0 && !/^invest/i.test(t.category)) totals[t.category] = (totals[t.category] ?? 0) - t.amount;
      const rows = Object.entries(totals).map(([label, amount]) => ({ label, amount: round2(amount) })).sort((a, b) => b.amount - a.amount);
      return { type: 'fact', text: 'Your spending in the last 30 days, by category:', rows };
    }
    if (intent === 'forecast') {
      const sc = engine.getScenario(id!);
      return { type: 'forecast', text: sc.summary, figure: sc.headline, range: sc.range, confidence: sc.confidence, scenarioId: sc.id };
    }
    const rule = engine.rule(id!)!;
    return { type: 'action', text: rule.text, letter: rule.letter };
  }

  return {
    async ask(question: unknown): Promise<Answer> {
      const q = String(question ?? '').trim();
      if (!q) throw httpError(400, 'Empty question');
      if (q.length > 500) throw httpError(400, 'Question is too long');
      const { route: r, source } = await route(q);
      return { ...answer(r), source };
    },
    /** The answer for an already decided route (the trainer routes with its own tools). */
    answerRoute: (r: Route): Answer => answer(r),
    suggestions: () => engine.suggestions(),
    safeToSpend: () => engine.safeToSpend(),
    expenses: () => engine.expenses(),
    listScenarios: () => engine.listScenarios(),
    getScenario: (id: string) => engine.getScenario(id),
    valuesAt: (id: string, day: number) => engine.valuesAt(id, day)
  };
}

export type CoachService = ReturnType<typeof createCoachService>;
