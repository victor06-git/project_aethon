// Goal research: what is worth asking the web about a goal (current options and prices, the
// costs beyond the price, financing conditions), and how the answers enter the plan.
// A figure is used only when a returned passage supports it.
import { round2 } from '../domain/money';
import {
  LIMITS, eur, hostOf,
  type Benchmark, type BenchmarkUnit, type Extraction, type GoalDraft, type GoalOption, type Monitoring, type Source
} from '../domain/trainer';
import { mentionsFigure } from './grounding';
import type { ResearchProvider } from './ports';

const FINANCING_MIN_PRICE = 2000;
const MAX_OPTIONS = 5;
const MAX_SOURCES = 8;
const PRICE_RANGE = { min: 50, max: LIMITS.price };
const YEARLY_COST_RANGE = { min: 1, max: LIMITS.monthly * 12 };
const MONTHLY_COST_RANGE = { min: 1, max: LIMITS.monthly };
const RATE_RANGE = { min: 0.1, max: LIMITS.ratePct };
const PRICE_CHANGE_SHARE = 0.03;      // a price move smaller than this is noise
const RATE_CHANGE_POINTS = 0.25;
const CONDITIONS_MAX = 240;
const TOPIC_LABEL: Record<TopicId, string> = { options: 'market prices', listings: 'seller listings', running: 'running costs', financing: 'financing terms' };
const YEARLY = /per year|a year|annual|yearly|year\)|\/\s*(?:year|yr|v(?:\.|\b))|vuodessa|vuosi|vuoteen|vuotuinen/i;
const MONTHLY = /per month|a month|monthly|month\)|\/\s*(?:month|mo|kk)\b|kuukaudessa|kuukausi/i;
const NOMINAL_RATE = /nominal|nimelliskorko|\binterest(?: rate)?\b|\bkorko\b/i;
const EFFECTIVE_RATE = /\b(?:apr|effective annual rate|todellinen vuosikorko)\b/i;

type TopicId = 'options' | 'listings' | 'running' | 'financing';
interface Topic { id: TopicId; query: string; properties: Record<string, unknown> }
interface Figure { value: number; source: Source; quote: string }

const amount = (description: string) => ({ type: 'number', description });
const RUNNING_FIELDS: { id: string; label: string; field: string; ask: string }[] = [
  { id: 'insurance', label: 'Insurance', field: 'insurance_eur_per_year', ask: 'Typical yearly insurance cost in euros' },
  { id: 'fuel', label: 'Fuel or charging', field: 'fuel_eur_per_year', ask: 'Typical yearly fuel or charging cost in euros' },
  { id: 'maintenance', label: 'Maintenance and tyres', field: 'maintenance_eur_per_year', ask: 'Typical yearly maintenance and tyre cost in euros' },
  { id: 'tax', label: 'Vehicle tax', field: 'tax_eur_per_year', ask: 'Typical yearly vehicle tax in euros' }
];

function topicsFor(goal: GoalDraft, year: string): Topic[] {
  const topics: Topic[] = [
    {
      id: 'options',
      query: `${goal.name} for sale in Finland ${year}: current offers and typical price. The year refers to the current market, not the model year.`,
      properties: { typical_price_eur: amount(`A current average or median price explicitly reported for ${goal.name} in Finland, in euros`) }
    },
    {
      id: 'listings',
      query: `Individual active seller listings for ${goal.name} in Finland. Each page should show one offer with a cash price, such as a dealer's vehicle detail page. Exclude category pages and search results.`,
      properties: { options: {
        type: 'array', description: `Up to ${MAX_OPTIONS} distinct offers matching the requested product, each on its own active listing`,
        items: { type: 'object', properties: {
          name: { type: 'string', description: 'Short plain-text listing name including the model or product name' }, price_eur: amount('Full cash price in euros'),
          conditions: { type: 'string', description: 'Optional brief verbatim quote from the listing stating a meaningful price condition, expiry or eligibility rule' }
        } }
      } }
    }
  ];
  if (goal.running.length) {
    topics.push({
      id: 'running',
      query: `Yearly cost of owning a ${goal.name} in Finland ${year}: explicitly stated annual or monthly insurance, fuel or charging, maintenance and vehicle tax in euros`,
      properties: Object.fromEntries(RUNNING_FIELDS.flatMap((f) => [
        [f.field, amount(f.ask)],
        [f.field.replace('_per_year', '_per_month'), amount(f.ask.replace('yearly', 'monthly'))]
      ]))
    });
  }
  if (goal.kind === 'car' || goal.price >= FINANCING_MIN_PRICE) {
    topics.push({
      id: 'financing',
      query: `${goal.kind === 'car' ? 'Car loan' : 'Consumer loan'} interest rates and conditions in Finland ${year}`,
      properties: {
        interest_rate_pct: amount('An explicitly stated nominal annual interest rate in percent, excluding fees. Do not use APR or effective annual rates.'),
        conditions: { type: 'string', description: 'Optional brief verbatim quote stating an eligibility requirement, term, fee or down payment for this rate, from the same provider page' }
      }
    });
  }
  return topics;
}

export function evidenceQuote(snippet: string, value: number, unit: BenchmarkUnit): string | undefined {
  return snippet.split(/\s+…\s+/).find((quote) =>
    mentionsFigure(quote, value, unit === 'percent' ? 'percent' : 'eur')
    && (unit !== 'eur_per_year' || YEARLY.test(quote))
    && (unit !== 'eur_per_month' || MONTHLY.test(quote))
    && (unit !== 'percent'
      || quote.split(/(?<=[.;!])\s+/).some((line) => NOMINAL_RATE.test(line) && !EFFECTIVE_RATE.test(line) && mentionsFigure(line, value, 'percent'))));
}

/** An applied figure needs a passage with both the amount and its unit. Use the field's citations when supplied. */
function sourceFor(found: Extraction, fields: string[], value: number, unit: BenchmarkUnit, requiresCitation = false): Figure | null {
  let candidates = found.sources;
  let cited = false;
  for (const field of fields) {
    const named = found.grounding.find((g) => g.field === field);
    if (!named) continue;
    if (named.confidence === 'low') return null;
    candidates = candidates.filter((s) => named.urls.includes(s.url));
    cited = true;
    break;
  }
  if (requiresCitation && !cited) return null;
  for (const source of candidates) {
    const quote = evidenceQuote(source.snippet, value, unit);
    if (quote) return { value, source, quote };
  }
  return null;
}

function figure(found: Extraction | undefined, field: string, range: { min: number; max: number }, unit: BenchmarkUnit): Figure | null {
  if (!found) return null;
  const value = found.content[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max) return null;
  return sourceFor(found, [field, 'content'], value, unit);
}

function verifiedConditions(value: unknown, source: Source): string | undefined {
  if (typeof value !== 'string') return;
  const quote = value.trim().replace(/\s+/g, ' ');
  if (quote && quote.length <= CONDITIONS_MAX && source.snippet.toLowerCase().includes(quote.toLowerCase())) return quote;
}

function optionsIn(found: Extraction): GoalOption[] {
  const list = Array.isArray(found.content.options) ? found.content.options : [];
  const options: GoalOption[] = [];
  const duplicatePage = new Set<string>();
  list.forEach((item: unknown, i: number) => {
    const { name, price_eur: price, conditions } = (item ?? {}) as { name?: unknown; price_eur?: unknown; conditions?: unknown };
    if (typeof name !== 'string' || /[{}\[\]<>]|\b(?:citations|confidence|price_eur)\s*:/i.test(name)) return;
    const label = name.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!label || typeof price !== 'number' || !Number.isFinite(price) || price < PRICE_RANGE.min || price > PRICE_RANGE.max) return;
    const backed = sourceFor(found, [`options[${i}].price_eur`, `options[${i}]`], price, 'eur', true);
    if (!backed) return;
    if (options.some((o) => o.url === backed.source.url)) {
      duplicatePage.add(backed.source.url);
      return;
    }
    const exactConditions = verifiedConditions(conditions, backed.source);
    options.push({ name: label, price, url: backed.source.url, evidence: backed.source, ...(exactConditions ? { conditions: exactConditions } : {}) });
  });
  return options.filter((o) => !duplicatePage.has(o.url)).slice(0, MAX_OPTIONS);
}

const benchmark = (topic: string, label: string, f: Figure, unit: BenchmarkUnit): Benchmark =>
  ({ topic, label, value: f.value, unit, url: f.source.url, quote: f.quote, sources: [f.source] });

function uniqueSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => !seen.has(s.url) && seen.add(s.url)).slice(0, MAX_SOURCES);
}

async function ask(topics: Topic[], provider: ResearchProvider, log: (msg: string) => void) {
  const settled = await Promise.allSettled(topics.map((t) => provider.extract(t.query, t.properties)));
  const answers = new Map<TopicId, Extraction>();
  const failed: string[] = [];
  settled.forEach((result, i) => {
    const id = topics[i].id;
    if (result.status === 'fulfilled') answers.set(id, result.value);
    else {
      failed.push(TOPIC_LABEL[id]);
      log(`research "${id}" failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });
  return { answers, failed };
}

export interface GoalResearch {
  goal: GoalDraft;
  queries: string[];     // what was asked of the web
  found: string[];       // what was found, one line each, with the source site
  missing: string[];     // what no source stated clearly
  failed: string[];     // what Exa could not complete
  sources: Source[];
}

/** Researches the goal and returns it with every backed figure applied. The user's own budget is never overwritten. */
export async function researchGoal(goal: GoalDraft, year: string, provider: ResearchProvider, log: (msg: string) => void = () => {}): Promise<GoalResearch> {
  const topics = topicsFor(goal, year);
  const { answers, failed } = await ask(topics, provider, log);
  const found: string[] = [];
  const missing: string[] = [];
  const benchmarks = new Map(goal.benchmarks.map((b) => [b.topic, b]));
  const used: Source[] = [];
  let next = goal;

  const market = answers.get('options');
  const price = figure(market, 'typical_price_eur', PRICE_RANGE, 'eur');
  if (price) {
    used.push(price.source);
    const keepPrice = goal.priceSource === 'user' || goal.selectedOptionUrl;
    const topic = keepPrice ? 'market_price' : 'price';
    benchmarks.set(topic, benchmark(topic, 'Typical price', price, 'eur'));
    if (keepPrice) found.push(`Typical price: ${eur(price.value)} (${hostOf(price.source.url)}). Your budget stays ${eur(goal.price)}.`);
    else {
      next = { ...next, price: price.value, priceSource: 'research' };
      found.push(`Typical price: ${eur(price.value)} (${hostOf(price.source.url)}), now used in the estimate.`);
    }
  } else if (market) missing.push('a typical price');
  const listings = answers.get('listings');
  const options = listings ? optionsIn(listings) : [];
  if (options.length) found.push(`${options.length} current option${options.length === 1 ? '' : 's'}, from ${eur(Math.min(...options.map((o) => o.price)))} to ${eur(Math.max(...options.map((o) => o.price)))}.`);
  else if (listings) missing.push('specific listings with a verified price');

  const costs = answers.get('running');
  for (const item of costs ? RUNNING_FIELDS : []) {
    const yearly = figure(costs, item.field, YEARLY_COST_RANGE, 'eur_per_year');
    const monthlyFigure = figure(costs, item.field.replace('_per_year', '_per_month'), MONTHLY_COST_RANGE, 'eur_per_month');
    if (yearly && monthlyFigure && Math.abs(yearly.value / 12 - monthlyFigure.value) > 1) {
      used.push(yearly.source, monthlyFigure.source);
      found.push(`${item.label} estimates differ: ${eur(yearly.value)} a year (${hostOf(yearly.source.url)}) and ${eur(monthlyFigure.value)} a month (${hostOf(monthlyFigure.source.url)}). The plan keeps the amount already shown.`);
      continue;
    }
    const estimate = yearly ?? monthlyFigure;
    if (!estimate) { missing.push(item.label.toLowerCase()); continue; }
    used.push(estimate.source);
    const monthly = yearly ? round2(yearly.value / 12) : estimate.value;
    benchmarks.set(item.id, benchmark(item.id, item.label, estimate, yearly ? 'eur_per_year' : 'eur_per_month'));
    const keepsUserFigure = next.running.some((c) => c.id === item.id && c.source === 'user');
    next = { ...next, running: next.running.map((c) => c.id === item.id && c.source !== 'user' ? { ...c, monthly, source: 'research' as const, url: estimate.source.url } : c) };
    const calculation = yearly ? `${eur(yearly.value)} a year works out to ${eur(monthly)} a month` : `${eur(monthly)} a month`;
    found.push(`${item.label}: ${calculation} (${hostOf(estimate.source.url)}).${keepsUserFigure ? ' Your estimate still applies.' : ''}`);
  }

  const loans = answers.get('financing');
  const rate = figure(loans, 'interest_rate_pct', RATE_RANGE, 'percent');
  if (loans && rate) {
    used.push(rate.source);
    benchmarks.set('loan_rate', benchmark('loan_rate', 'Advertised nominal loan rate', rate, 'percent'));
    if (next.loan && next.loan.rateSource !== 'user') {
      next = { ...next, loan: { ...next.loan, ratePct: rate.value, rateSource: 'research', rateUrl: rate.source.url } };
    }
    const conditions = verifiedConditions(loans.content.conditions, rate.source);
    found.push(`Advertised nominal loan rate: ${rate.value}% a year (${hostOf(rate.source.url)}).${conditions ? ` Terms stated by the provider: “${conditions}”` : ''} Your actual rate, fees and eligibility depend on the provider.`);
  } else if (loans) missing.push('loan interest');

  return {
    goal: { ...next, options, benchmarks: [...benchmarks.values()] },
    queries: topics.map((t) => t.query), found, missing, failed,
    sources: uniqueSources([...used, ...options.flatMap((o) => o.evidence ?? []), ...[...answers.values()].flatMap((a) => a.sources)])
  };
}

export interface Watch {
  changes: string[];
  followUps: string[];
  sources: Source[];
  queries: string[];
  missing: string[];
  failed: string[];
  price?: Figure;
  rate?: Figure;
}

/** What the user asked to have monitored, checked now: has the price or the loan rate moved? */
export async function watchGoal(goal: GoalDraft, monitor: Monitoring, year: string, provider: ResearchProvider, log: (msg: string) => void = () => {}): Promise<Watch> {
  const wanted = topicsFor(goal, year).filter((t) => (t.id === 'options' && monitor.prices) || (t.id === 'financing' && monitor.conditions && goal.loan !== null));
  const priceTopic = wanted.find((t) => t.id === 'options');
  if (priceTopic && goal.selectedOptionUrl) {
    priceTopic.query = `Current asking price for the specific ${goal.name} listing at ${goal.selectedOptionUrl}`;
    priceTopic.properties = { listing_price_eur: amount('Full cash price in euros of the exact listing; omit if unavailable, sold, or expired') };
  }
  const { answers, failed } = await ask(wanted, provider, log);
  const changes: string[] = [];
  const followUps: string[] = [];
  const missing: string[] = [];
  const used: Source[] = [];
  const updated: Pick<Watch, 'price' | 'rate'> = {};

  const market = answers.get('options');
  const estimate = figure(market, goal.selectedOptionUrl ? 'listing_price_eur' : 'typical_price_eur', PRICE_RANGE, 'eur');
  const price = estimate && (!goal.selectedOptionUrl || estimate.source.url === goal.selectedOptionUrl) ? estimate : null;
  if (market && !price) missing.push(goal.selectedOptionUrl ? 'the selected listing’s current price' : 'a typical price');
  const oldMarket = goal.benchmarks.find((b) => b.topic === 'market_price')?.value;
  const baseline = goal.selectedOptionUrl ? goal.price : oldMarket ?? goal.price;
  if (price && Math.abs(price.value - baseline) >= baseline * PRICE_CHANGE_SHARE) {
    changes.push(goal.selectedOptionUrl
      ? `The selected listing now shows ${eur(price.value)} (${hostOf(price.source.url)}). Your plan counts ${eur(goal.price)}.`
      : `A current typical price is ${eur(price.value)} (${hostOf(price.source.url)}). Your plan counts ${eur(goal.price)}.`);
    followUps.push(`The budget is ${eur(price.value)}`);
    updated.price = price;
    used.push(price.source);
  }
  const loans = answers.get('financing');
  const rate = figure(loans, 'interest_rate_pct', RATE_RANGE, 'percent');
  if (loans && !rate) missing.push('a nominal loan rate');
  if (rate && goal.loan && Math.abs(rate.value - goal.loan.ratePct) >= RATE_CHANGE_POINTS) {
    changes.push(`The advertised nominal loan rate is ${rate.value}% (${hostOf(rate.source.url)}); your plan counts ${goal.loan.ratePct}%.`);
    followUps.push(`What if the loan rate is ${rate.value}%?`);
    updated.rate = rate;
    used.push(rate.source);
  }
  return {
    changes, followUps, missing, failed, ...updated,
    sources: uniqueSources([...used, ...[...answers.values()].flatMap((a) => a.sources)]), queries: wanted.map((t) => t.query)
  };
}
