// Cash-flow clarity: sorts what the user pays into regular commitments, necessary but
// irregular expenses and everyday spending, and derives a weekly safe-to-spend amount with
// its math. Pure, no I/O. Every cash-flow figure the app shows is computed here.
import { round2 } from './money';
import { addDays, addMonths, daysBetween } from './dates';
import type { Account, Transaction } from './types';
import { BASKETS, type Basket, type CashLine, type Cashflow, type Correction, type LineBasis, type LineBasket, type MathStep, type WeeklySafe } from './trainer';

const PERIOD_DAYS = 365;            // history used for averages
const MIN_PERIOD_DAYS = 14;         // shorter histories are not scaled up further
const MONTH_DAYS = 30.44;
const WEEK_DAYS = 7;
const RECURRING_TOLERANCE = 0.25;   // a monthly bill may vary this much around its median
const STALE_DAYS = 45;              // a monthly bill not seen for this long has ended
const PAYDAY_FALLBACK_DAYS = 30;
const NAMED_BILLS = 3;

// Vocabulary from domain/categories.ts (coach keys) and merchant labels.
const COMMITMENT_KEYS = new Set(['housing', 'loan', 'subscriptions', 'utilities', 'fitness', 'phone']);
const EVERYDAY_KEYS = new Set(['groceries', 'food_delivery', 'restaurants', 'taxi', 'leisure', 'fuel', 'shopping']);
const IRREGULAR = /insurance|health|pharmacy|doctor|dentist|repair|hardware|home supplies|maintenance|\btax\b/i;
const ASSUMED_MONTHLY = /transfer/i;
const INVESTMENT = /^invest/i;      // moving money into your own investments is saving, not spending

export interface CashflowInput {
  transactions: Transaction[];
  accounts: Account[];
  asOf: string;
  corrections?: Correction[];
  planMonthly?: number;             // set aside for an agreed plan before anything is "safe to spend"
}

interface Group { id: string; label: string; category: string; key: string; amounts: number[]; dates: string[] }   // newest first

const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);
export const lineIdOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One group per payee, payments newest first. */
function groupByPayee(transactions: Transaction[]): Group[] {
  const groups = new Map<string, Group>();
  for (const t of transactions) {
    const id = lineIdOf(t.merchant);
    const group = groups.get(id) ?? { id, label: t.merchant, category: t.category, key: t.coachKey, amounts: [], dates: [] };
    group.amounts.push(Math.abs(t.amount));
    group.dates.push(t.date);
    groups.set(id, group);
  }
  return [...groups.values()];
}

/** Paid once a month, in at least two months, for about the same amount, and still running. */
function isRecurring(group: Group, asOf: string): boolean {
  const monthsSeen = new Set(group.dates.map((d) => d.slice(0, 7)));
  if (monthsSeen.size < 2 || monthsSeen.size !== group.dates.length) return false;
  if (daysBetween(group.dates[0], asOf) > STALE_DAYS) return false;
  const mid = median(group.amounts);
  return group.amounts.every((a) => Math.abs(a - mid) <= mid * RECURRING_TOLERANCE);
}

function classify(group: Group, asOf: string, correction?: Correction): { basket: LineBasket; basis: LineBasis } {
  if (correction) return { basket: correction.as, basis: 'corrected' };
  const words = `${group.key} ${group.label} ${group.category}`;
  if (!EVERYDAY_KEYS.has(group.key) && isRecurring(group, asOf)) return { basket: 'regular', basis: 'recurring' };
  if (COMMITMENT_KEYS.has(group.key) || ASSUMED_MONTHLY.test(words)) return { basket: 'regular', basis: 'assumed' };
  if (IRREGULAR.test(words)) return { basket: 'irregular', basis: 'average' };
  return { basket: 'everyday', basis: 'average' };
}

function monthlyCost(group: Group, basket: LineBasket, basis: LineBasis, months: number): number {
  if (basket === 'oneoff') return 0;
  if (basket !== 'regular') return sum(group.amounts) / months;
  return basis === 'recurring' ? median(group.amounts) : group.amounts[0];
}

function toLine(group: Group, months: number, asOf: string, correction?: Correction): CashLine {
  const { basket, basis } = classify(group, asOf, correction);
  return {
    id: group.id, label: group.label, category: group.category, basket, basis,
    monthly: round2(monthlyCost(group, basket, basis, months)),
    total: round2(sum(group.amounts)), count: group.amounts.length,
    lastDate: group.dates[0], lastAmount: group.amounts[0]
  };
}

/** The next monthly date after `asOf`, keeping the day of the month of `lastDate`. */
function nextMonthly(lastDate: string, asOf: string): string {
  let step = 1;
  while (addMonths(lastDate, step) <= asOf) step++;
  return addMonths(lastDate, step);
}

function nextPayday(inflows: Group[], asOf: string): string {
  if (!inflows.length) return addDays(asOf, PAYDAY_FALLBACK_DAYS);
  const salary = inflows.reduce((best, g) => (sum(g.amounts) > sum(best.amounts) ? g : best));
  return nextMonthly(salary.dates[0], asOf);
}

function billNames(lines: CashLine[]): string {
  const names = lines.slice(0, NAMED_BILLS).map((l) => l.label).join(', ');
  return lines.length > NAMED_BILLS ? `${names} and ${lines.length - NAMED_BILLS} more` : names;
}

interface SafeInput { accounts: Account[]; asOf: string; payday: string; commitments: CashLine[]; irregularMonthly: number; planMonthly: number }

/** Money on the account, minus what is already spoken for until payday, spread over the days left. */
function safeToSpend({ accounts, asOf, payday, commitments, irregularMonthly, planMonthly }: SafeInput): WeeklySafe {
  const current = accounts.filter((a) => a.kind === 'current');
  const balance = round2(sum((current.length ? current : accounts).map((a) => a.balance)));
  const days = Math.max(1, daysBetween(asOf, payday));
  const due = commitments.filter((l) => nextMonthly(l.lastDate, asOf) <= payday);
  const bills = round2(sum(due.map((l) => l.monthly)));
  const reserve = round2((irregularMonthly * days) / MONTH_DAYS);
  const saving = round2((planMonthly * days) / MONTH_DAYS);
  const left = round2(Math.max(0, balance - bills - reserve - saving));
  const perDay = round2(left / days);
  const week = round2(perDay * Math.min(WEEK_DAYS, days));
  const steps: MathStep[] = [
    { label: 'On your account now', amount: balance, kind: 'start' },
    { label: due.length ? `Bills due before payday: ${billNames(due)}` : 'Bills due before payday', amount: -bills, kind: 'minus' },
    { label: 'Set aside for irregular bills', amount: -reserve, kind: 'minus' },
    ...(saving > 0 ? [{ label: 'Set aside for your agreed plan', amount: -saving, kind: 'minus' as const }] : []),
    { label: `Free until payday (${days} days)`, amount: left, kind: 'equals' },
    { label: 'Safe to spend this week', amount: week, kind: 'equals' }
  ];
  return { week, perDay, days, until: payday, steps };
}

export const basketMonthly = (cashflow: Cashflow, basket: Basket): number =>
  cashflow.baskets.find((b) => b.basket === basket)?.monthly ?? 0;

export function buildCashflow({ transactions, accounts, asOf, corrections = [], planMonthly = 0 }: CashflowInput): Cashflow {
  const from = addDays(asOf, -PERIOD_DAYS);
  const period = transactions
    .filter((t) => t.date > from && t.date <= asOf && !INVESTMENT.test(t.category))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const periodDays = period.length ? daysBetween(period[period.length - 1].date, asOf) + 1 : 0;
  const months = Math.max(periodDays, MIN_PERIOD_DAYS) / MONTH_DAYS;
  const correctionFor = new Map(corrections.map((c) => [c.lineId, c]));

  const lines = groupByPayee(period.filter((t) => t.amount < 0)).map((g) => toLine(g, months, asOf, correctionFor.get(g.id)));
  const inflows = groupByPayee(period.filter((t) => t.amount > 0));
  const income = round2(sum(inflows.map((g) => (isRecurring(g, asOf) ? median(g.amounts) : sum(g.amounts) / months))));
  const baskets = BASKETS.map((b) => {
    const own = lines.filter((l) => l.basket === b.basket).sort((x, y) => y.monthly - x.monthly);
    return { ...b, monthly: round2(sum(own.map((l) => l.monthly))), lines: own };
  });
  const [commitments, irregular] = baskets;
  const free = round2(income - sum(baskets.map((b) => b.monthly)));

  return {
    asOf, periodDays, income, baskets, free,
    oneOffs: lines.filter((l) => l.basket === 'oneoff'),
    safeToSave: round2(Math.max(0, free - planMonthly)),
    safe: safeToSpend({
      accounts, asOf, payday: nextPayday(inflows, asOf),
      commitments: commitments.lines, irregularMonthly: irregular.monthly, planMonthly
    })
  };
}
