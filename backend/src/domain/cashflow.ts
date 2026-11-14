// Cash-flow estimates from the observed accounts and transactions. No I/O.
import { round2 } from './money';
import { addDays, addMonths, daysBetween } from './dates';
import { transactionFlow } from './transactionFlow';
import type { Account, Transaction } from './types';
import { BASKETS, type Basket, type CashLine, type Cashflow, type Correction, type LineBasis, type LineBasket, type MathStep, type WeeklySafe } from './trainer';

const PERIOD_DAYS = 365;
const MIN_PERIOD_DAYS = 14;
const MONTH_DAYS = 30.44;
const WEEK_DAYS = 7;
const RECURRING_TOLERANCE = 0.25;
const STALE_DAYS = 45;
const PAYDAY_FALLBACK_DAYS = 30;
const NAMED_BILLS = 3;

const COMMITMENT_KEYS = new Set(['housing', 'loan', 'subscriptions', 'utilities', 'fitness', 'phone']);
const EVERYDAY_KEYS = new Set(['groceries', 'food_delivery', 'restaurants', 'taxi', 'leisure', 'fuel', 'shopping']);
const IRREGULAR = /insurance|health|pharmacy|doctor|dentist|repair|hardware|home supplies|maintenance|\btax\b/i;
const ASSUMED_MONTHLY = /transfer/i;

export interface CashflowInput {
  transactions: Transaction[];
  accounts: Account[];
  asOf: string;
  corrections?: Correction[];
  planMonthly?: number;
}

interface Group { id: string; label: string; category: string; key: string; entries: Transaction[] }
interface MonthlyGroup { month: string; total: number; payments: Transaction[] }

const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);
export const lineIdOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Group newest-first entries by display payee. The sponsor export only supplies merchant IDs and types. */
function groupByPayee(transactions: Transaction[]): Group[] {
  const groups = new Map<string, Group>();
  for (const t of transactions) {
    const id = lineIdOf(t.merchant);
    const group = groups.get(id) ?? { id, label: t.merchant, category: t.category, key: t.coachKey, entries: [] };
    group.entries.push(t);
    groups.set(id, group);
  }
  return [...groups.values()];
}

/** The input includes refunds with their original sign so they reduce the corresponding month's spending. */
function spendingMonths(entries: Transaction[]): MonthlyGroup[] {
  const groups = new Map<string, MonthlyGroup>();
  for (const t of entries) {
    const month = t.date.slice(0, 7);
    const group = groups.get(month) ?? { month, total: 0, payments: [] };
    group.total -= t.amount;
    if (t.amount < 0) group.payments.push(t);
    groups.set(month, group);
  }
  return [...groups.values()];
}

/** The payments are monthly when there is one per month and amounts stay close to their median. */
function isRecurring(payments: Transaction[], asOf: string): boolean {
  if (payments.length < 2 || daysBetween(payments[0].date, asOf) > STALE_DAYS) return false;
  const lastMonth = `${payments[0].date.slice(0, 7)}-01`;
  if (!payments.every((t, index) => t.date.startsWith(addMonths(lastMonth, -index).slice(0, 7)))) return false;
  const amounts = payments.map((t) => Math.abs(t.amount));
  const mid = median(amounts);
  return amounts.every((a) => Math.abs(a - mid) <= mid * RECURRING_TOLERANCE);
}

function classify(group: Group, payments: Transaction[], asOf: string, correction?: Correction): { basket: LineBasket; basis: LineBasis } {
  if (correction) return { basket: correction.as, basis: 'corrected' };
  const words = `${group.key} ${group.label} ${group.category}`;
  if (!EVERYDAY_KEYS.has(group.key) && isRecurring(payments, asOf)) return { basket: 'regular', basis: 'recurring' };
  if (COMMITMENT_KEYS.has(group.key) || ASSUMED_MONTHLY.test(words)) return { basket: 'regular', basis: 'assumed' };
  if (IRREGULAR.test(words)) return { basket: 'irregular', basis: 'average' };
  return { basket: 'everyday', basis: 'average' };
}

function completeMonth(asOf: string): string {
  const month = asOf.slice(0, 7);
  return addDays(asOf, 1).slice(0, 7) !== month ? month : addDays(`${month}-01`, -1).slice(0, 7);
}

function commitmentCost(groups: MonthlyGroup[], asOf: string): number {
  const latestComplete = completeMonth(asOf);
  const observed = groups.filter((g) => g.month <= latestComplete && g.payments.length);
  if (!observed.length) return Math.max(0, groups[0].total);
  return Math.max(0, median(observed.map((g) => g.total)));
}

function toLine(group: Group, months: number, asOf: string, correction?: Correction): CashLine | undefined {
  const payments = group.entries.filter((t) => t.amount < 0);
  if (!payments.length) return undefined;
  const { basket, basis } = classify(group, payments, asOf, correction);
  const total = round2(sum(group.entries.map((t) => -t.amount)));
  const monthly = basket === 'regular' ? commitmentCost(spendingMonths(group.entries), asOf)
    : basket === 'oneoff' ? 0 : Math.max(0, total) / months;
  return {
    id: group.id, label: group.label, category: group.category, basket, basis,
    monthly: round2(monthly), total, count: payments.length,
    lastDate: payments[0].date, lastAmount: -payments[0].amount
  };
}

/** The next monthly date after `asOf`, keeping the day of the month of `lastDate`. */
function nextMonthly(lastDate: string, asOf: string): string {
  let step = 1;
  while (addMonths(lastDate, step) <= asOf) step++;
  return addMonths(lastDate, step);
}

function nextPayday(income: Transaction[], asOf: string): { date: string; inferred: boolean } {
  const salary = income.find((t) => t.type === 'salary' || t.coachKey === 'salary');
  if (!salary || daysBetween(salary.date, asOf) > STALE_DAYS) return { date: addDays(asOf, PAYDAY_FALLBACK_DAYS), inferred: false };
  return { date: nextMonthly(salary.date, asOf), inferred: true };
}

function billNames(lines: CashLine[]): string {
  const names = lines.slice(0, NAMED_BILLS).map((l) => l.label).join(', ');
  return lines.length > NAMED_BILLS ? `${names} and ${lines.length - NAMED_BILLS} more` : names;
}

/** Estimate which monthly instalments fall before payday from the last observed schedule. */
function dueBefore(line: CashLine, entries: Transaction[], asOf: string, payday: string): number {
  const byMonth = spendingMonths(entries).filter((g) => g.payments.length);
  const schedule = byMonth.find((g) => g.month <= completeMonth(asOf)) ?? byMonth[0];
  if (!schedule) return 0;
  // A single commitment uses its latest date. Several debits use the last complete month as a schedule.
  if (schedule.payments.length === 1) return nextMonthly(line.lastDate, asOf) <= payday ? line.monthly : 0;
  const due = schedule.payments.filter((t) => nextMonthly(t.date, asOf) <= payday);
  return line.monthly * sum(due.map((t) => t.amount)) / sum(schedule.payments.map((t) => t.amount));
}

interface SafeInput {
  accounts: Account[];
  asOf: string;
  payday: string;
  commitments: CashLine[];
  transfers: CashLine[];
  entriesById: Map<string, Transaction[]>;
  irregularMonthly: number;
  planMonthly: number;
}

/** Money in current accounts minus the estimated amounts needed before the next pay date. */
function safeToSpend({ accounts, asOf, payday, commitments, transfers, entriesById, irregularMonthly, planMonthly }: SafeInput): WeeklySafe {
  const current = accounts.filter((a) => a.kind === 'current');
  const balance = round2(sum(current.map((a) => a.balance)));
  const days = Math.max(1, daysBetween(asOf, payday));
  const amountsDue = (lines: CashLine[]) => lines.map((line) => ({ line, amount: dueBefore(line, entriesById.get(line.id) ?? [], asOf, payday) }));
  const due = amountsDue(commitments).filter((item) => item.amount > 0);
  const bills = round2(sum(due.map((item) => item.amount)));
  const scheduled = round2(sum(amountsDue(transfers).map((item) => item.amount)));
  const reserve = round2((irregularMonthly * days) / MONTH_DAYS);
  const saving = round2((planMonthly * days) / MONTH_DAYS);
  const left = round2(Math.max(0, balance - bills - scheduled - reserve - saving));
  const perDay = round2(left / days);
  const week = round2(left * Math.min(WEEK_DAYS, days) / days);
  const steps: MathStep[] = [
    { label: 'In your current accounts as of the statement date', amount: balance, kind: 'start' },
    { label: due.length ? `Bills due by the estimated payday (${billNames(due.map((item) => item.line))})` : 'Bills due by the estimated payday', amount: -bills, kind: 'minus' },
    ...(scheduled > 0 ? [{ label: 'Set aside for scheduled transfers', amount: -scheduled, kind: 'minus' as const }] : []),
    { label: 'Set aside for irregular bills', amount: -reserve, kind: 'minus' },
    ...(saving > 0 ? [{ label: 'Set aside for your agreed plan', amount: -saving, kind: 'minus' as const }] : []),
    { label: `Free until payday (${days} days)`, amount: left, kind: 'equals' },
    { label: 'Estimated safe to spend this week', amount: week, kind: 'equals' }
  ];
  return { week, perDay, days, until: payday, steps };
}

export const basketMonthly = (cashflow: Cashflow, basket: Basket): number =>
  cashflow.baskets.find((b) => b.basket === basket)?.monthly ?? 0;

export function buildCashflow({ transactions, accounts, asOf, corrections = [], planMonthly = 0 }: CashflowInput): Cashflow {
  const from = addDays(asOf, -PERIOD_DAYS + 1);
  const period = transactions.filter((t) => t.date >= from && t.date <= asOf)
    .sort((a, b) => b.date.localeCompare(a.date));
  const periodFrom = transactions.some((t) => t.date < from) ? from : period.at(-1)?.date ?? asOf;
  const periodDays = period.length ? daysBetween(periodFrom, asOf) + 1 : 0;
  const months = Math.max(periodDays, MIN_PERIOD_DAYS) / MONTH_DAYS;
  const correctionFor = new Map(corrections.map((c) => [c.lineId, c]));
  const spendingEntries: Transaction[] = [];
  const scheduledEntries: Transaction[] = [];
  const investmentEntries: Transaction[] = [];
  const inflows: Transaction[] = [];
  for (const transaction of period) {
    const flow = transactionFlow(transaction);
    if (flow === 'spending' || flow === 'refund') spendingEntries.push(transaction);
    if (flow === 'scheduled_transfer') scheduledEntries.push(transaction);
    if (flow === 'saving') investmentEntries.push(transaction);
    if (flow === 'income' && transaction.amount > 0) inflows.push(transaction);
  }
  const spending = groupByPayee(spendingEntries);
  const scheduled = groupByPayee(scheduledEntries);
  const entriesById = new Map([...spending, ...scheduled].map((g) => [g.id, g.entries]));
  const lines = spending.map((g) => toLine(g, months, asOf, correctionFor.get(g.id))).filter((line) => line !== undefined);
  const transfers = scheduled.map((g) => toLine(g, months, asOf, { lineId: g.id, as: 'regular' })).filter((line) => line !== undefined);
  const transferReserve = round2(sum(transfers.map((l) => l.monthly)));
  const incomeGroups = groupByPayee(inflows.filter((t) => t.type !== 'other_income'));
  const income = round2(sum(incomeGroups.map(({ entries }) => {
    const amounts = entries.map((t) => t.amount);
    return isRecurring(entries, asOf) ? median(amounts) : sum(amounts) / months;
  })));
  const baskets = BASKETS.map((b) => {
    const own = lines.filter((l) => l.basket === b.basket).sort((x, y) => y.monthly - x.monthly);
    return { ...b, monthly: round2(sum(own.map((l) => l.monthly))), lines: own };
  });
  const [commitments, irregular] = baskets;
  const free = round2(income - transferReserve - sum(baskets.map((b) => b.monthly)));
  const investmentMonthly = round2(sum(investmentEntries.map((t) => -t.amount)) / months);
  const payday = nextPayday(inflows, asOf);
  const assumptions = [
    'Bill amounts and due dates are estimated from payment history. Allow for bills and accounts outside this data.',
    payday.inferred ? 'The next pay date follows the most recent salary date.' : 'A salary date could not be inferred. The weekly estimate uses a 30-day window.',
    ...(transfers.length ? ['Salary sweeps are reserved separately because their destination is unavailable.'] : []),
    ...(investmentEntries.length ? ['Investment movements stay outside spending and income. Savings plans use the room available before investment contributions.'] : []),
    ...(inflows.some((t) => t.type === 'other_income') ? ['Other income is excluded from the monthly estimate because it may be irregular.'] : [])
  ];

  return {
    asOf, periodFrom, periodDays, income, transferReserve, investmentMonthly, assumptions, baskets, free,
    oneOffs: lines.filter((l) => l.basket === 'oneoff'),
    safeToSave: round2(Math.max(0, free - planMonthly)),
    safe: safeToSpend({
      accounts, asOf, payday: payday.date, commitments: commitments.lines, transfers, entriesById, irregularMonthly: irregular.monthly, planMonthly
    })
  };
}
