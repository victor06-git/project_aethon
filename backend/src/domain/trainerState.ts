// Validation of the trainer state. The client keeps the state and sends it back with each
// request, so it is untrusted input: every field is checked and anything unknown is dropped.
import { httpError } from './types';
import {
  CUT_GROUPS, EMPTY_STATE, LIMITS, LINE_BASKETS,
  type AgreedPlan, type Benchmark, type BenchmarkUnit, type Correction, type CostItem, type FigureSource,
  type GoalDraft, type GoalKind, type GoalOption, type LoanTerms, type Monitoring, type PlanCheck, type PlanStatus, type Source, type SpendingCut, type TrainerState
} from './trainer';

const MAX = { corrections: 200, items: 12, sources: 5, changes: 10, name: 80, note: 300, text: 700, url: 500 };
const SOURCES: FigureSource[] = ['assumption', 'research', 'user'];
const KINDS: GoalKind[] = ['car', 'purchase'];
const UNITS: BenchmarkUnit[] = ['eur', 'eur_per_month', 'eur_per_year', 'percent'];
const STATUSES: PlanStatus[] = ['on_track', 'at_risk', 'off_track'];

type Obj = Record<string, unknown>;

function fail(what: string): never {
  throw httpError(400, `Invalid trainer state: ${what}`);
}

function obj(v: unknown, name: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(name);
  return v as Obj;
}

/** A string up to `max` characters. Empty is allowed unless `required`. */
function text(v: unknown, name: string, max: number, required = true): string {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) fail(name);
  return v as string;
}

function num(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(name);
  return v as number;
}

function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (!allowed.includes(v as T)) fail(name);
  return v as T;
}

function list<T>(v: unknown, name: string, max: number, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length > max) fail(name);
  return (v as unknown[]).map(item);
}

const isoDate = (v: unknown, name: string): string => {
  const s = text(v, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(name);
  return s;
};

// Links are rendered as <a href>: only http(s), never javascript: or data:.
const httpUrl = (v: unknown, name: string): string => {
  const s = text(v, name, MAX.url);
  if (!/^https?:\/\//i.test(s)) fail(name);
  return s;
};

function source(v: unknown): Source {
  const o = obj(v, 'source');
  return {
    title: text(o.title, 'source.title', MAX.text, false), url: httpUrl(o.url, 'source.url'),
    published: text(o.published, 'source.published', 10, false), snippet: text(o.snippet, 'source.snippet', MAX.text, false)
  };
}

function benchmark(v: unknown): Benchmark {
  const o = obj(v, 'benchmark');
  const base: Benchmark = {
    topic: text(o.topic, 'benchmark.topic', MAX.name), label: text(o.label, 'benchmark.label', MAX.name),
    sources: list(o.sources, 'benchmark.sources', MAX.sources, source)
  };
  if (o.value === undefined) return base;
  return {
    ...base, value: num(o.value, 'benchmark.value', 0, LIMITS.price), unit: oneOf(o.unit, 'benchmark.unit', UNITS),
    url: httpUrl(o.url, 'benchmark.url'), ...(o.quote === undefined ? {} : { quote: text(o.quote, 'benchmark.quote', MAX.text) })
  };
}

function costItem(v: unknown): CostItem {
  const o = obj(v, 'cost');
  return {
    id: text(o.id, 'cost.id', MAX.name), label: text(o.label, 'cost.label', MAX.name),
    monthly: num(o.monthly, 'cost.monthly', 0, LIMITS.monthly), source: oneOf(o.source, 'cost.source', SOURCES),
    ...(o.url === undefined ? {} : { url: httpUrl(o.url, 'cost.url') })
  };
}

function cut(v: unknown): SpendingCut {
  const o = obj(v, 'cut');
  return { group: text(o.group, 'cut.group', MAX.name), pct: num(o.pct, 'cut.pct', 1, 100) };
}

function loan(v: unknown): LoanTerms | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, 'loan');
  return {
    years: num(o.years, 'loan.years', 1, LIMITS.loanYears), ratePct: num(o.ratePct, 'loan.ratePct', 0, LIMITS.ratePct),
    ...(o.amount === undefined ? {} : { amount: num(o.amount, 'loan.amount', 0, LIMITS.price) }),
    ...(o.rateSource === undefined ? {} : { rateSource: oneOf(o.rateSource, 'loan.rateSource', SOURCES) }),
    ...(o.rateUrl === undefined ? {} : { rateUrl: httpUrl(o.rateUrl, 'loan.rateUrl') })
  };
}

function goal(v: unknown): GoalDraft {
  const o = obj(v, 'goal');
  return {
    kind: oneOf(o.kind, 'goal.kind', KINDS), name: text(o.name, 'goal.name', MAX.name),
    price: num(o.price, 'goal.price', 0, LIMITS.price), priceSource: oneOf(o.priceSource, 'goal.priceSource', SOURCES),
    months: num(o.months, 'goal.months', 1, LIMITS.months),
    running: list(o.running, 'goal.running', MAX.items, costItem), cuts: list(o.cuts, 'goal.cuts', MAX.items, cut),
    loan: loan(o.loan), benchmarks: list(o.benchmarks, 'goal.benchmarks', MAX.items, benchmark),
    options: o.options === undefined ? [] : list(o.options, 'goal.options', MAX.items, option),
    ...(o.selectedOptionUrl === undefined ? {} : { selectedOptionUrl: httpUrl(o.selectedOptionUrl, 'goal.selectedOptionUrl') }),
    confirmed: flag(o.confirmed, 'goal.confirmed'),
    note: o.note === undefined ? '' : text(o.note, 'goal.note', MAX.note, false)
  };
}

function option(v: unknown): GoalOption {
  const o = obj(v, 'option');
  const url = httpUrl(o.url, 'option.url');
  const evidence = o.evidence === undefined ? undefined : source(o.evidence);
  if (evidence && evidence.url !== url) fail('option.evidence.url');
  return {
    name: text(o.name, 'option.name', MAX.text), price: num(o.price, 'option.price', 0, LIMITS.price), url,
    ...(evidence ? { evidence } : {}),
    ...(o.conditions === undefined ? {} : { conditions: text(o.conditions, 'option.conditions', 240) })
  };
}

function flag(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') fail(name);
  return v as boolean;
}

function monitoring(v: unknown): Monitoring {
  const o = obj(v, 'plan.monitor');
  return { prices: flag(o.prices, 'monitor.prices'), conditions: flag(o.conditions, 'monitor.conditions'), spending: flag(o.spending, 'monitor.spending') };
}

function planCheck(v: unknown): PlanCheck | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, 'plan.lastCheck');
  return {
    checkedOn: isoDate(o.checkedOn, 'lastCheck.checkedOn'), status: oneOf(o.status, 'lastCheck.status', STATUSES),
    changes: list(o.changes, 'lastCheck.changes', MAX.changes, (c) => text(c, 'lastCheck.change', MAX.text)),
    ...(o.proposedGoal === undefined ? {} : { proposedGoal: goal(o.proposedGoal) })
  };
}

function plan(v: unknown): AgreedPlan {
  const o = obj(v, 'plan');
  return {
    goal: goal(o.goal), agreedOn: isoDate(o.agreedOn, 'plan.agreedOn'), targetDate: isoDate(o.targetDate, 'plan.targetDate'),
    monthlySaving: num(o.monthlySaving, 'plan.monthlySaving', 0, LIMITS.monthly),
    bufferMonthly: num(o.bufferMonthly, 'plan.bufferMonthly', 0, LIMITS.monthly),
    capacityAtAgreement: num(o.capacityAtAgreement, 'plan.capacityAtAgreement', -LIMITS.monthly, LIMITS.monthly),
    monitor: monitoring(o.monitor), lastCheck: planCheck(o.lastCheck)
  };
}

function correction(v: unknown): Correction {
  const o = obj(v, 'correction');
  return { lineId: text(o.lineId, 'correction.lineId', MAX.name), as: oneOf(o.as, 'correction.as', LINE_BASKETS) };
}

/** Throws a 400 with the offending field if the state is not exactly what the trainer produces. */
export function parseState(input: unknown): TrainerState {
  if (input === undefined || input === null) return EMPTY_STATE;
  const o = obj(input, 'state');
  if (o.multiBank !== undefined && typeof o.multiBank !== 'boolean') fail('multiBank');
  return {
    multiBank: o.multiBank === true,
    corrections: o.corrections === undefined ? [] : list(o.corrections, 'corrections', MAX.corrections, correction),
    draft: o.draft === undefined || o.draft === null ? null : goal(o.draft),
    plan: o.plan === undefined || o.plan === null ? null : plan(o.plan)
  };
}
