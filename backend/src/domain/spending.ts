// Free exploration of the user's own data: "how much did I spend on X" and "what kind of
// spender am I". Pure, no I/O. The model asks; these functions compute.
import { round2 } from './money';
import { addDays } from './dates';
import { lineIdOf } from './cashflow';
import { CUT_GROUPS, type Basket, type Cashflow } from './trainer';
import type { Transaction } from './types';

export type Period = 'last_30_days' | 'last_90_days' | 'this_month' | 'last_month';
export const PERIOD_LABEL: Record<Period, string> = {
  last_30_days: 'in the last 30 days', last_90_days: 'in the last 90 days', this_month: 'this month', last_month: 'last month'
};
export const PERIODS = Object.keys(PERIOD_LABEL) as Period[];

const TOP_PAYEES = 5;
const TOP_CATEGORIES = 3;
const MIN_TERM = 3;
const INVESTMENT = /^invest/i;
// Share of income left over each month → a plain description of the user's style.
const STYLES: { minPct: number; text: string }[] = [
  { minPct: 20, text: 'A saver: a good part of every pay stays with you' },
  { minPct: 5, text: 'Balanced: everything is covered and a little is left' },
  { minPct: 0, text: 'Living close to the edge: almost everything that comes in goes out' },
  { minPct: -Infinity, text: 'Stretched: more goes out than comes in' }
];

export interface SpendingQuery {
  search: string; period: Period; from: string; to: string;
  total: number; count: number;
  payees: { label: string; amount: number }[];
}

export interface SpendingProfile {
  style: string;
  savingRatePct: number;                                            // share of income left each month
  shares: { basket: Basket; label: string; pct: number }[];         // share of income per basket
  topEveryday: { label: string; amount: number }[];                 // per month, by category
  everydayLast30: number;
  everydayPrevious30: number;
}

/** Inclusive date range of a period that ends at (or before) `asOf`. */
function rangeOf(period: Period, asOf: string): { from: string; to: string } {
  const monthStart = `${asOf.slice(0, 7)}-01`;
  if (period === 'this_month') return { from: monthStart, to: asOf };
  if (period === 'last_month') {
    const to = addDays(monthStart, -1);
    return { from: `${to.slice(0, 7)}-01`, to };
  }
  return { from: addDays(asOf, period === 'last_90_days' ? -89 : -29), to: asOf };
}

/** Matches a payment by a spending group ("eating out") or by words in its payee and category. */
function matcherFor(search: string): (t: Transaction) => boolean {
  const query = search.trim().toLowerCase();
  const group = Object.entries(CUT_GROUPS).find(([key, g]) => key !== 'everyday' && (query.includes(key) || query.includes(g.label)));
  const terms = query.split(/[^a-z0-9äöå]+/).filter((w) => w.length >= MIN_TERM).map((w) => (w.length > 4 ? w.replace(/s$/, '') : w));
  const wordsOf = (t: Transaction) => `${t.merchant} ${t.category} ${t.coachKey.replace(/_/g, ' ')}`.toLowerCase();
  if (group) return (t) => group[1].match.test(wordsOf(t));
  return (t) => terms.some((term) => wordsOf(t).includes(term));
}

const isSpending = (t: Transaction) => t.amount < 0 && !INVESTMENT.test(t.category);

function totalsBy<T>(items: T[], key: (x: T) => string, amount: (x: T) => number): { label: string; amount: number }[] {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(key(item), (totals.get(key(item)) ?? 0) + amount(item));
  return [...totals].map(([label, value]) => ({ label, amount: round2(value) })).sort((a, b) => b.amount - a.amount);
}

export function querySpending(transactions: Transaction[], asOf: string, search: string, period: Period = 'last_30_days'): SpendingQuery {
  const { from, to } = rangeOf(period, asOf);
  const matches = matcherFor(search);
  const found = transactions.filter((t) => isSpending(t) && t.date >= from && t.date <= to && matches(t));
  return {
    search, period, from, to, count: found.length,
    total: round2(found.reduce((s, t) => s - t.amount, 0)),
    payees: totalsBy(found, (t) => t.merchant, (t) => -t.amount).slice(0, TOP_PAYEES)
  };
}

export function spendingProfile(cashflow: Cashflow, transactions: Transaction[], asOf: string): SpendingProfile {
  const pctOfIncome = (amount: number) => (cashflow.income > 0 ? Math.round((amount / cashflow.income) * 100) : 0);
  const savingRatePct = pctOfIncome(cashflow.free);
  const everyday = cashflow.baskets.find((b) => b.basket === 'everyday')?.lines ?? [];
  const everydayIds = new Set(everyday.map((l) => l.id));
  const everydayBetween = (from: string, to: string) => round2(transactions
    .filter((t) => isSpending(t) && t.date >= from && t.date <= to && everydayIds.has(lineIdOf(t.merchant)))
    .reduce((s, t) => s - t.amount, 0));
  return {
    style: STYLES.find((s) => savingRatePct >= s.minPct)!.text,
    savingRatePct,
    shares: cashflow.baskets.map((b) => ({ basket: b.basket, label: b.label, pct: pctOfIncome(b.monthly) })),
    topEveryday: totalsBy(everyday, (l) => l.category, (l) => l.monthly).slice(0, TOP_CATEGORIES),
    everydayLast30: everydayBetween(addDays(asOf, -29), asOf),
    everydayPrevious30: everydayBetween(addDays(asOf, -59), addDays(asOf, -30))
  };
}
