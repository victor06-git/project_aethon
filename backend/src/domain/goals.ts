// Goal and scenario simulator: what a purchase really costs (price, then running costs),
// the savings path to it, and what changes when the user tries a "what if". Pure, no I/O.
import { round2 } from './money';
import { addMonths, longDate } from './dates';
import { basketMonthly } from './cashflow';
import {
  CUT_GROUPS, LIMITS, eur,
  type Cashflow, type CostItem, type GapFix, type GoalDraft, type GoalKind, type LoanTerms, type GoalScenario, type PlanChoice, type SpendingCut, type CashLine
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
  name?: string;                            // change the public purchase description
  months?: number;                          // "in 18 months"
  addMonths?: number;                       // "wait 3 more months"
  price?: number;
  cut?: SpendingCut;                        // "cut eating out by 20%"
  loan?: Partial<LoanTerms> | false;        // take a loan, or drop it
  keepSpending?: boolean;                   // "keep my current spending": drop the cuts
  cost?: { id: string; monthly: number };   // "insurance is €80 a month"
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** The loan rate Exa found for this goal, if any, with its source. */
function researchedRate(goal: GoalDraft): Partial<LoanTerms> {
  const found = goal.benchmarks.find((b) => b.topic === 'loan_rate' && b.unit === 'percent' && b.value !== undefined && b.url);
  return found ? { ratePct: found.value, rateSource: 'research', rateUrl: found.url } : {};
}

function nextLoan(goal: GoalDraft, change: WhatIf['loan']): LoanTerms | null {
  if (change === false) return null;
  if (!change) return goal.loan;
  const base: LoanTerms = goal.loan ?? { ...DEFAULT_LOAN, rateSource: 'assumption', ...researchedRate(goal) };
  const { rateUrl: oldUrl, ...rest } = base;
  const next: LoanTerms = { ...rest, ...change };
  // A rate the user typed is theirs; one that came with the loan keeps its source.
  if (change.ratePct !== undefined) return { ...next, rateSource: 'user' };
  return oldUrl ? { ...next, rateUrl: oldUrl } : next;
}

export function applyWhatIf(goal: GoalDraft, change: WhatIf): GoalDraft {
  if (change.name && change.name.toLowerCase() !== goal.name.toLowerCase()) {
    const updated = newGoal(goal.kind, change.name, goal.priceSource === 'user' ? goal.price : undefined, goal.months, goal.note);
    goal = { ...updated, cuts: goal.cuts, loan: goal.loan?.rateSource === 'user' ? goal.loan : null };
  }
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
    ...(change.price ? { price: change.price, priceSource: 'user' as const, selectedOptionUrl: undefined } : {})
  };
}

/** Euros a month freed by the cuts. A line matched by several cuts counts once, at the largest cut. */
/** Does a cut apply to this payment line? All everyday spending, a named group, or one category of the user's own data. */
export function cutApplies(group: string, line: CashLine): boolean {
  if (group === 'everyday') return true;
  if (CUT_GROUPS[group]) return CUT_GROUPS[group].match.test(`${line.label} ${line.category}`);
  const name = group.toLowerCase();
  return line.category.toLowerCase() === name || line.label.toLowerCase() === name;
}

export function cutGain(cuts: SpendingCut[], cashflow: Cashflow): number {
  const everyday = cashflow.baskets.find((b) => b.basket === 'everyday')?.lines ?? [];
  const gain = everyday.reduce((total, line) => {
    const pct = Math.max(0, ...cuts.filter((c) => cutApplies(c.group, line)).map((c) => c.pct));
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
  // With a loan the user borrows the amount they chose, or else saves what they can and borrows the rest.
  const chosen = goal.loan?.amount;
  const borrowed = !goal.loan ? 0
    : chosen !== undefined ? Math.min(chosen, toSave)
      : Math.max(0, toSave - Math.min(Math.max(0, capacity), perMonth) * goal.months);
  const needed = goal.loan ? (toSave - borrowed) / goal.months : perMonth;
  const payment = goal.loan && borrowed > 0 ? loanPayment(borrowed, goal.loan) : 0;
  const loan = goal.loan && borrowed > 0
    ? { ...goal.loan, amount: round2(borrowed), payment: round2(payment), totalInterest: round2(round2(payment) * goal.loan.years * 12 - borrowed) }
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
  fixes: GapFix[];               // ways to close the monthly gap, when there is one
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
  return { scenarios, start, cushion, capacity, fixes: plan.feasible ? [] : gapFixes(goal, plan, { cashflow, start, capacity, asOf }) };
}

const MAX_CUT_FIX_PCT = 50;       // asking for more than half of everyday spending is not a real suggestion
const MIN_PRICE_FIX_SHARE = 0.3;  // a price far below the goal is a different goal
const MAX_FIXES = 4;

/** Concrete ways to close the monthly gap. Each carries the what-if that applies it. */
function gapFixes(goal: GoalDraft, plan: GoalScenario, { cashflow, start, capacity, asOf }: Basis & { cashflow: Cashflow }): GapFix[] {
  const fixes: GapFix[] = [];
  if (capacity > 0) {
    const months = Math.min(LIMITS.months, Math.ceil((goal.price - start) / capacity));
    if (months > goal.months) {
      fixes.push({ id: 'wait', label: `Wait until ${longDate(addMonths(asOf, months))}`, args: { months },
        detail: `Save ${eur((goal.price - start) / months)} a month for ${months} months. Nothing else changes.` });
    }
  }
  const everyday = basketMonthly(cashflow, 'everyday');
  if (!goal.cuts.length && plan.gap > 0 && everyday > 0) {
    const pct = Math.ceil((plan.gap / everyday) * 20) * 5;
    if (pct <= MAX_CUT_FIX_PCT) {
      fixes.push({ id: 'cut', label: `Spend ${pct}% less on everyday things`, args: { cut_group: 'everyday', cut_pct: pct },
        detail: `That frees about ${eur((everyday * pct) / 100)} of the ${eur(everyday)} you spend each month. Afterwards you choose what to cut.` });
    }
  }
  const fits = Math.floor((start + capacity * goal.months) / 100) * 100;
  if (capacity > 0 && fits >= goal.price * MIN_PRICE_FIX_SHARE && fits < goal.price) {
    fixes.push({ id: 'price', label: `Aim for about ${eur(fits)}`, args: { price: fits },
      detail: `That is what ${eur(capacity)} a month saves in ${goal.months} months.` });
  }
  const loan = goal.loan ? null : scenario('loan', 'loan', { ...goal, loan: nextLoan(goal, {}) }, { capacity, start, asOf }).loan;
  if (loan) {
    fixes.push({ id: 'loan', label: 'Borrow part of it', args: { loan: true },
      detail: `About ${eur(loan.amount)} over ${loan.years} years: ${eur(loan.payment)} a month and ${eur(loan.totalInterest)} in interest.` });
  }
  return fixes.slice(0, MAX_FIXES);
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
