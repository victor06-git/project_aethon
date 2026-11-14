// Goal and scenario simulator: what a purchase really costs (price, then running costs),
// the savings path to it, and what changes when the user tries a "what if". Pure, no I/O.
import { round2 } from './money';
import { addMonths, longDate } from './dates';
import { basketMonthly } from './cashflow';
import {
  CUT_GROUPS, LIMITS, eur,
  type Cashflow, type CostItem, type GoalDraft, type GoalKind, type LoanTerms, type GoalScenario, type PlanChoice, type SpendingCut
} from './trainer';

// Starting assumptions. They are shown to the user as assumptions and replaced by
// researched or user-given figures (source: 'research' | 'user').
export const CAR_PRICE = { used: 15_000, new: 30_000 };
const CAR_RUNNING: Omit<CostItem, 'source'>[] = [
  { id: 'insurance', label: 'Insurance', monthly: 60 },
  { id: 'fuel', label: 'Fuel or charging', monthly: 110 },
  { id: 'maintenance', label: 'Maintenance and tyres', monthly: 60 },
  { id: 'tax', label: 'Vehicle tax', monthly: 25 }
];
export const RUNNING_COST_IDS = CAR_RUNNING.map((c) => c.id);
export const DEFAULT_LOAN: LoanTerms = { years: 5, ratePct: 6 };
export const DEFAULT_MONTHS = 12;
const CHOICE_MIN_EUR = 5;           // less room than this is not worth a decision
const CUSHION_MONTHS = 1;           // savings worth this many months of commitments stay untouched

export function newGoal(kind: GoalKind, name: string, price?: number, months = DEFAULT_MONTHS, note = ''): GoalDraft {
  const assumed = kind === 'car' ? (/\bnew\b/i.test(name) ? CAR_PRICE.new : CAR_PRICE.used) : 0;
  return {
    kind, name, months, note, confirmed: false,
    price: price ?? assumed, priceSource: price ? 'user' : 'assumption',
    running: kind === 'car' ? CAR_RUNNING.map((c) => ({ ...c, source: 'assumption' as const })) : [],
    cuts: [], loan: null, benchmarks: [], options: []
  };
}

/** A change the user wants to try on the current goal. */
export interface WhatIf {
  months?: number;                          // "in 18 months"
  addMonths?: number;                       // "wait 3 more months"
  price?: number;
  cut?: SpendingCut;                        // "cut eating out by 20%"
  loan?: Partial<LoanTerms> | false;        // take a loan, or drop it
  keepSpending?: boolean;                   // "keep my current spending": drop the cuts
  cost?: { id: string; monthly: number };   // "insurance is €80 a month"
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function researchedRate(goal: GoalDraft): Partial<LoanTerms> {
  const found = goal.benchmarks.find((b) => b.topic === 'loan' && b.unit === 'percent' && b.value !== undefined);
  return found ? { ratePct: found.value } : {};
}

function nextLoan(goal: GoalDraft, change: WhatIf['loan']): LoanTerms | null {
  if (change === false) return null;
  if (!change) return goal.loan;
  return { ...DEFAULT_LOAN, ...researchedRate(goal), ...goal.loan, ...change };
}

export function applyWhatIf(goal: GoalDraft, change: WhatIf): GoalDraft {
  // A cut of 0% removes that cut (a slider moved back to the start).
  const others = change.cut ? goal.cuts.filter((c) => c.group !== change.cut!.group) : goal.cuts;
  const cuts = change.keepSpending ? [] : change.cut && change.cut.pct > 0 ? [...others, change.cut] : others;
  const running = change.cost
    ? goal.running.map((c) => (c.id === change.cost!.id ? { id: c.id, label: c.label, monthly: change.cost!.monthly, source: 'user' as const } : c))
    : goal.running;
  return {
    ...goal, cuts, running,
    months: clamp(Math.round(change.months ?? goal.months + (change.addMonths ?? 0)), 1, LIMITS.months),
    loan: nextLoan(goal, change.loan),
    ...(change.price ? { price: change.price, priceSource: 'user' as const } : {})
  };
}

/** Euros a month freed by the cuts. A line matched by several cuts counts once, at the largest cut. */
export function cutGain(cuts: SpendingCut[], cashflow: Cashflow): number {
  const everyday = cashflow.baskets.find((b) => b.basket === 'everyday')?.lines ?? [];
  const gain = everyday.reduce((total, line) => {
    const words = `${line.label} ${line.category}`;
    const pct = Math.max(0, ...cuts.filter((c) => CUT_GROUPS[c.group]?.match.test(words)).map((c) => c.pct));
    return total + (line.monthly * pct) / 100;
  }, 0);
  return round2(gain);
}

function loanPayment(amount: number, { years, ratePct }: LoanTerms): number {
  const months = years * 12;
  const rate = ratePct / 100 / 12;
  return rate === 0 ? amount / months : (amount * rate) / (1 - (1 + rate) ** -months);
}

interface Basis { capacity: number; start: number; asOf: string }

function scenarioNotes(s: Pick<GoalScenario, 'gap' | 'monthlyNeeded' | 'monthlyCapacity' | 'afterMonthly' | 'afterFree' | 'loan'>): string[] {
  const notes: string[] = [];
  if (s.gap > 0) notes.push(`Short by ${eur(s.gap)} a month while saving.`);
  else if (s.monthlyNeeded > 0) notes.push(`Leaves ${eur(s.monthlyCapacity - s.monthlyNeeded)} a month unplanned while you save.`);
  if (s.loan) notes.push(`Loan of ${eur(s.loan.amount)} over ${s.loan.years} years at ${s.loan.ratePct}%: ${eur(s.loan.payment)} a month.`);
  if (s.afterMonthly > 0) {
    notes.push(s.afterFree >= 0
      ? `After buying: ${eur(s.afterMonthly)} a month in costs, ${eur(s.afterFree)} left.`
      : `After buying: ${eur(s.afterMonthly)} a month in costs, ${eur(-s.afterFree)} more than you free up.`);
  }
  return notes;
}

function scenario(id: string, label: string, goal: GoalDraft, { capacity, start, asOf }: Basis): GoalScenario {
  const toSave = Math.max(0, goal.price - start);
  const perMonth = toSave / goal.months;
  // With a loan the user saves what they can and borrows the rest.
  const needed = goal.loan ? Math.min(Math.max(0, capacity), perMonth) : perMonth;
  const borrowed = goal.loan ? Math.max(0, toSave - needed * goal.months) : 0;
  const loan = goal.loan && borrowed > 0
    ? { ...goal.loan, amount: round2(borrowed), payment: round2(loanPayment(borrowed, goal.loan)) }
    : undefined;
  const afterMonthly = round2(goal.running.reduce((s, c) => s + c.monthly, 0) + (loan?.payment ?? 0));
  const figures = {
    monthlyNeeded: round2(needed), monthlyCapacity: round2(capacity),
    gap: round2(Math.max(0, needed - capacity)), afterMonthly, afterFree: round2(capacity - afterMonthly), loan
  };
  return {
    id, label, months: goal.months, readyDate: addMonths(asOf, goal.months), ...figures,
    upfront: round2(goal.price - (loan?.amount ?? 0)),
    feasible: figures.gap === 0 && figures.afterFree >= 0,
    notes: scenarioNotes(figures)
  };
}

export interface Simulation {
  scenarios: GoalScenario[];     // the user's plan first, then alternatives to compare
  start: number;             // savings that can go into the goal
  cushion: number;           // savings left untouched
  capacity: number;          // freed up each month, cuts included
}

export function simulate(goal: GoalDraft, { cashflow, savings, asOf }: { cashflow: Cashflow; savings: number; asOf: string }): Simulation {
  const cushion = round2(Math.min(savings, basketMonthly(cashflow, 'regular') * CUSHION_MONTHS));
  const start = round2(savings - cushion);
  const capacity = round2(cashflow.free + cutGain(goal.cuts, cashflow));
  const plan = scenario('plan', 'Your plan', goal, { capacity, start, asOf });
  const scenarios = [plan];
  if (goal.cuts.length || goal.loan) {
    scenarios.push(scenario('current', 'Current spending, no loan', { ...goal, cuts: [], loan: null }, { capacity: cashflow.free, start, asOf }));
  }
  if (!goal.loan && plan.gap > 0 && capacity > 0) {
    const months = Math.min(LIMITS.months, Math.ceil((goal.price - start) / capacity));
    if (months > goal.months) scenarios.push(scenario('wait', `Wait ${months - goal.months} more months`, { ...goal, months }, { capacity, start, asOf }));
  }
  return { scenarios, start, cushion, capacity };
}

/**
 * The user's choices when the plan has room, or is short. `now` is the agreed goal simulated on
 * today's figures. With room: contribute less, reach the goal sooner, or grow the buffer.
 * When short: reach the goal later (cutting spending is a what-if on the plan).
 */
export function planChoices(now: GoalScenario, asOf: string): PlanChoice[] {
  const capacity = now.monthlyCapacity;
  const needed = now.monthlyNeeded;
  const toSave = needed * now.months;
  if (now.loan || toSave <= 0 || capacity <= 0) return [];
  const room = round2(capacity - needed);
  const monthsAtCapacity = Math.ceil(toSave / capacity);
  const dateAtCapacity = addMonths(asOf, monthsAtCapacity);
  if (room <= -CHOICE_MIN_EUR) {
    return [{
      id: 'later', label: 'Reach the goal later', monthlySaving: capacity, bufferMonthly: 0, targetDate: dateAtCapacity,
      detail: `Save ${eur(capacity)} a month and be ready on ${longDate(dateAtCapacity)}, ${monthsAtCapacity - now.months} month${monthsAtCapacity - now.months === 1 ? '' : 's'} later.`
    }];
  }
  if (room < CHOICE_MIN_EUR) return [];
  const choices: PlanChoice[] = [{
    id: 'less', label: 'Contribute less', monthlySaving: needed, bufferMonthly: 0, targetDate: now.readyDate,
    detail: `Save ${eur(needed)} a month, keep ${longDate(now.readyDate)}, and the other ${eur(room)} a month is yours to spend.`
  }];
  if (monthsAtCapacity < now.months) {
    choices.push({
      id: 'sooner', label: 'Reach the goal sooner', monthlySaving: capacity, bufferMonthly: 0, targetDate: dateAtCapacity,
      detail: `Save ${eur(capacity)} a month and be ready on ${longDate(dateAtCapacity)}, ${now.months - monthsAtCapacity} month${now.months - monthsAtCapacity === 1 ? '' : 's'} earlier.`
    });
  }
  choices.push({
    id: 'buffer', label: 'Keep a larger buffer', monthlySaving: needed, bufferMonthly: room, targetDate: now.readyDate,
    detail: `Save ${eur(needed)} a month for the goal and ${eur(room)} a month into your buffer: ${eur(room * now.months)} extra by ${longDate(now.readyDate)}.`
  });
  return choices;
}
