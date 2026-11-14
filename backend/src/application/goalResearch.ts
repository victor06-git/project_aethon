// Goal research: what is worth asking the web about a goal (current options and prices, the
// costs beyond the price, financing conditions), and how the answers enter the plan.
// A figure is used only when the research names a source for it; otherwise the assumption stays.
import { round2 } from '../domain/money';
import {
  LIMITS, eur, hostOf,
  type Benchmark, type BenchmarkUnit, type Extraction, type GoalDraft, type GoalOption, type Monitoring, type Source
} from '../domain/trainer';
import { numbersIn } from './grounding';
import type { ResearchProvider } from './ports';

const FINANCING_MIN_PRICE = 2000;     // below this, nobody takes a loan
const MAX_OPTIONS = 5;
const MAX_SOURCES = 8;
const PRICE_RANGE = { min: 50, max: LIMITS.price };
const YEARLY_COST_RANGE = { min: 1, max: LIMITS.monthly * 12 };
const RATE_RANGE = { min: 0.1, max: LIMITS.ratePct };
const PRICE_CHANGE_SHARE = 0.03;      // a price move smaller than this is noise
const RATE_CHANGE_POINTS = 0.25;
const CONDITIONS_MAX = 240;

type TopicId = 'options' | 'running' | 'financing';
interface Topic { id: TopicId; query: string; properties: Record<string, unknown> }
interface Figure { value: number; url: string }

const amount = (description: string) => ({ type: 'number', description });
const RUNNING_FIELDS: { id: string; label: string; field: string; ask: string }[] = [
  { id: 'insurance', label: 'Insurance', field: 'insurance_eur_per_year', ask: 'Typical yearly insurance cost in euros' },
  { id: 'fuel', label: 'Fuel or charging', field: 'fuel_eur_per_year', ask: 'Typical yearly fuel or charging cost in euros' },
  { id: 'maintenance', label: 'Maintenance and tyres', field: 'maintenance_eur_per_year', ask: 'Typical yearly maintenance and tyre cost in euros' },
  { id: 'tax', label: 'Vehicle tax', field: 'tax_eur_per_year', ask: 'Typical yearly vehicle tax in euros' }
];

function topicsFor(goal: GoalDraft, year: string): Topic[] {
  const topics: Topic[] = [{
    id: 'options',
    query: `${goal.name} for sale in Finland ${year}: current offers and typical price`,
    properties: {
      typical_price_eur: amount(`Typical current price of a ${goal.name} in Finland, in euros`),
      options: {
        type: 'array', description: `Up to ${MAX_OPTIONS} specific current offers or models with their price`,
        items: { type: 'object', properties: { name: { type: 'string' }, price_eur: { type: 'number' } } }
      }
    }
  }];
  if (goal.running.length) {
    topics.push({
      id: 'running',
      query: `Yearly cost of owning a ${goal.name} in Finland ${year}: insurance, fuel or charging, maintenance, vehicle tax`,
      properties: Object.fromEntries(RUNNING_FIELDS.map((f) => [f.field, amount(f.ask)]))
    });
  }
  if (goal.kind === 'car' || goal.price >= FINANCING_MIN_PRICE) {
    topics.push({
      id: 'financing',
      query: `${goal.kind === 'car' ? 'Car loan' : 'Consumer loan'} interest rates and conditions in Finland ${year}`,
      properties: {
        interest_rate_pct: amount('Typical yearly interest rate in percent'),
        conditions: { type: 'string', description: 'The main conditions in one sentence: down payment, term, fees' }
      }
    });
  }
  return topics;
}

/** The source that backs a figure: the one the research names for that field, or a passage that states the number. */
function sourceFor(found: Extraction, fields: string[], value: number): string | null {
  for (const field of fields) {
    const named = found.grounding.find((g) => g.field === field);
    if (named) return named.confidence !== 'low' && named.urls.length ? named.urls[0] : null;
  }
  return found.sources.find((s) => numbersIn(s.snippet).some((n) => Math.abs(n - value) < 0.005))?.url ?? null;
}

function figure(found: Extraction, field: string, range: { min: number; max: number }): Figure | null {
  const value = found.content[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max) return null;
  const url = sourceFor(found, [field, 'content'], value);
  return url ? { value, url } : null;
}

function optionsIn(found: Extraction): GoalOption[] {
  const list = Array.isArray(found.content.options) ? found.content.options : [];
  const options: GoalOption[] = [];
  list.forEach((item: unknown, i: number) => {
    const { name, price_eur: price } = (item ?? {}) as { name?: unknown; price_eur?: unknown };
    if (typeof name !== 'string' || !name.trim() || typeof price !== 'number' || price < PRICE_RANGE.min || price > PRICE_RANGE.max) return;
    const url = sourceFor(found, [`options[${i}].price_eur`, `options[${i}]`, 'options', 'content'], price);
    if (url && !options.some((o) => o.name === name)) options.push({ name: name.trim().slice(0, 120), price, url });
  });
  return options.slice(0, MAX_OPTIONS);
}

const benchmark = (topic: string, label: string, f: Figure, unit: BenchmarkUnit, sources: Source[]): Benchmark =>
  ({ topic, label, value: f.value, unit, url: f.url, sources: sources.filter((s) => s.url === f.url) });

function uniqueSources(found: Extraction[]): Source[] {
  const seen = new Set<string>();
  return found.flatMap((f) => f.sources).filter((s) => !seen.has(s.url) && seen.add(s.url)).slice(0, MAX_SOURCES);
}

async function ask(topics: Topic[], provider: ResearchProvider, log: (msg: string) => void): Promise<Map<TopicId, Extraction>> {
  const settled = await Promise.allSettled(topics.map((t) => provider.extract(t.query, t.properties)));
  const answers = new Map<TopicId, Extraction>();
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') answers.set(topics[i].id, result.value);
    else log(`research "${topics[i].id}" failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  return answers;
}

export interface GoalResearch {
  goal: GoalDraft;
  queries: string[];     // what was asked of the web
  found: string[];       // what was found, one line each, with the source site
  missing: string[];     // what no source stated clearly
  sources: Source[];
}

/** Researches the goal and returns it with every backed figure applied. The user's own budget is never overwritten. */
export async function researchGoal(goal: GoalDraft, year: string, provider: ResearchProvider, log: (msg: string) => void = () => {}): Promise<GoalResearch> {
  const topics = topicsFor(goal, year);
  const answers = await ask(topics, provider, log);
  const found: string[] = [];
  const missing: string[] = [];
  const benchmarks = new Map(goal.benchmarks.map((b) => [b.topic, b]));
  let next = goal;

  const market = answers.get('options');
  const price = market ? figure(market, 'typical_price_eur', PRICE_RANGE) : null;
  if (market && price) {
    benchmarks.set('price', benchmark('price', 'Typical price', price, 'eur', market.sources));
    if (goal.priceSource === 'user') found.push(`Typical price: ${eur(price.value)} (${hostOf(price.url)}). Your budget stays ${eur(goal.price)}.`);
    else {
      next = { ...next, price: price.value, priceSource: 'research' };
      found.push(`Typical price: ${eur(price.value)} (${hostOf(price.url)}), now used as the budget.`);
    }
  } else missing.push('a typical price');
  const options = market ? optionsIn(market) : [];
  if (options.length) found.push(`${options.length} current option${options.length === 1 ? '' : 's'}, from ${eur(Math.min(...options.map((o) => o.price)))} to ${eur(Math.max(...options.map((o) => o.price)))}.`);

  const costs = answers.get('running');
  for (const item of goal.running.length ? RUNNING_FIELDS : []) {
    const yearly = costs ? figure(costs, item.field, YEARLY_COST_RANGE) : null;
    if (!costs || !yearly) { missing.push(item.label.toLowerCase()); continue; }
    const monthly = round2(yearly.value / 12);
    benchmarks.set(item.id, benchmark(item.id, item.label, yearly, 'eur_per_year', costs.sources));
    next = { ...next, running: next.running.map((c) => (c.id === item.id ? { ...c, monthly, source: 'research' as const, url: yearly.url } : c)) };
    found.push(`${item.label}: ${eur(monthly)} a month (${hostOf(yearly.url)}).`);
  }

  const loans = answers.get('financing');
  const rate = loans ? figure(loans, 'interest_rate_pct', RATE_RANGE) : null;
  if (loans && rate) {
    benchmarks.set('loan_rate', benchmark('loan_rate', 'Loan interest rate', rate, 'percent', loans.sources));
    if (next.loan) next = { ...next, loan: { ...next.loan, ratePct: rate.value, rateSource: 'research', rateUrl: rate.url } };
    const conditions = typeof loans.content.conditions === 'string' ? ` ${loans.content.conditions.trim().slice(0, CONDITIONS_MAX)}` : '';
    found.push(`Loan interest: about ${rate.value}% a year (${hostOf(rate.url)}).${conditions}`);
  } else if (loans) missing.push('loan interest');

  return {
    goal: { ...next, options: options.length ? options : goal.options, benchmarks: [...benchmarks.values()] },
    queries: topics.map((t) => t.query), found, missing, sources: uniqueSources([...answers.values()])
  };
}

export interface Watch { changes: string[]; followUps: string[]; sources: Source[]; queries: string[] }

/** What the user asked to have monitored, checked now: has the price or the loan rate moved? */
export async function watchGoal(goal: GoalDraft, monitor: Monitoring, year: string, provider: ResearchProvider, log: (msg: string) => void = () => {}): Promise<Watch> {
  const wanted = topicsFor(goal, year).filter((t) => (t.id === 'options' && monitor.prices) || (t.id === 'financing' && monitor.conditions && goal.loan !== null));
  if (!wanted.length) return { changes: [], followUps: [], sources: [], queries: [] };
  const answers = await ask(wanted, provider, log);
  const changes: string[] = [];
  const followUps: string[] = [];

  const market = answers.get('options');
  const price = market ? figure(market, 'typical_price_eur', PRICE_RANGE) : null;
  if (price && Math.abs(price.value - goal.price) >= goal.price * PRICE_CHANGE_SHARE) {
    changes.push(`The typical price is now ${eur(price.value)} (${hostOf(price.url)}); your plan counts ${eur(goal.price)}.`);
    followUps.push(`The budget is ${eur(price.value)}`);
  }
  const loans = answers.get('financing');
  const rate = loans ? figure(loans, 'interest_rate_pct', RATE_RANGE) : null;
  if (rate && goal.loan && Math.abs(rate.value - goal.loan.ratePct) >= RATE_CHANGE_POINTS) {
    changes.push(`Loan interest is now about ${rate.value}% (${hostOf(rate.url)}); your plan counts ${goal.loan.ratePct}%.`);
    followUps.push(`What if the loan rate is ${rate.value}%?`);
  }
  return { changes, followUps, sources: uniqueSources([...answers.values()]), queries: wanted.map((t) => t.query) };
}
