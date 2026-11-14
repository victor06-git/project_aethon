// Contract tests for the Personal Economic Trainer: three baskets, safe-to-spend, corrections,
// goal simulator, agreed plan, research, the Gemini tool loop and the HTTP adapter.
// Run with `npm test`. No network: the model, Exa and fetch are scripted fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createContainer, type Container, type ContainerDeps } from '../backend/src/container';
import type { AgentModel, AgentRequest, ToolCall } from '../backend/src/application/ports';
import { ungroundedFigures } from '../backend/src/application/grounding';
import { buildCashflow } from '../backend/src/domain/cashflow';
import type { Transaction } from '../backend/src/domain/types';
import { createGeminiAgent, type GeminiClient } from '../backend/src/infrastructure/llm/geminiAgent';
import { createExaResearch } from '../backend/src/infrastructure/research/exaResearch';
import { handleApi, type ApiOptions } from '../backend/src/interfaces/http/nodeAdapter';

const round2 = (n: number) => Math.round(n * 100) / 100;
const status = (code: number) => (e: any) => e.status === code;
const TRANSFER = 'transfer-to-maija-k';
const REPAIR = 'kodinkonehuolto-aalto';

const cashflow = (app: Container, state?: unknown) => app.handle('POST', '/api/trainer/cashflow', { state });
const act = (app: Container, name: string, args: unknown = {}, state?: unknown) => app.handle('POST', '/api/trainer/action', { action: { name, args }, state });
const say = (app: Container, text: string, state?: unknown) => app.handle('POST', '/api/trainer/chat', { messages: [{ role: 'user', text }], state });
const YES = 'Yes, that is right';
// Starts a goal and confirms the brief, as a user would.
// A car question with no price first goes through the guided questions (carConversation.ts);
// their last step writes this brief, so tests start from it directly.
const carBrief = (app: Container, state?: unknown) => act(app, 'simulate_goal', { kind: 'car', name: 'car', months: 12 }, state);
async function confirmed(app: Container, question: string, state?: unknown) {
  const brief = question === 'Could I buy a car next year?' ? await carBrief(app, state) : await say(app, question, state);
  assert.equal(brief.answer.type, 'brief', question);
  return say(app, YES, brief.state);
}
// Research fake: `extract` answers by topic (the query names it), `search` returns fixed passages.
function fakeResearch(topics: Record<string, any>, passages: any[] = []) {
  const queries: string[] = [];
  return {
    queries,
    search: async (q: string) => { queries.push(q); return passages; },
    extract: async (q: string) => {
      queries.push(q);
      const key = Object.keys(topics).find((k) => q.toLowerCase().includes(k));
      if (!key) return { content: {}, grounding: [], sources: [] };
      if (topics[key] instanceof Error) throw topics[key];
      return topics[key];
    }
  };
}
const lineOf = (cf: any, id: string) => [...cf.baskets.flatMap((b: any) => b.lines), ...cf.oneOffs].find((l: any) => l.id === id);

// A scripted model: calls the given tools in order, then answers with `text`.
function scriptedAgent(calls: ToolCall[], text: string) {
  const seen: { request?: AgentRequest; results: any[] } = { results: [] };
  const agent: AgentModel = {
    async run(request) {
      seen.request = request;
      for (const call of calls) seen.results.push(await request.execute(call));
      return text;
    }
  };
  return { agent, seen };
}

// ---- Three baskets and safe-to-spend ----

test('transactions fall into the three baskets', async () => {
  const cf = await createContainer().handle('GET', '/api/trainer/cashflow');
  assert.deepEqual(cf.baskets.map((b: any) => b.basket), ['regular', 'irregular', 'everyday']);
  assert.equal(cf.income, 2850);
  const rent = lineOf(cf, 'landlord');
  assert.deepEqual([rent.basket, rent.basis, rent.monthly], ['regular', 'recurring', 850]);
  assert.deepEqual([lineOf(cf, TRANSFER).basket, lineOf(cf, TRANSFER).basis], ['regular', 'assumed'], 'a transfer is assumed monthly until corrected');
  assert.equal(lineOf(cf, 'if-kotivakuutus').basket, 'irregular');
  assert.equal(lineOf(cf, 'k-market').basket, 'everyday', 'a shop visited once a month is not a bill');
  assert.equal(lineOf(cf, REPAIR).basket, 'everyday');
  assert.equal(cf.free, round2(cf.income - cf.baskets.reduce((s: number, b: any) => s + b.monthly, 0)));
  assert.equal(cf.safeToSave, cf.free);
  assert.ok(cf.disclaimer);
});

test('safe-to-spend shows math that adds up', async () => {
  const { safe } = await createContainer().handle('GET', '/api/trainer/cashflow');
  const start = safe.steps[0].amount;
  const minus = safe.steps.filter((s: any) => s.kind === 'minus').reduce((s: number, x: any) => s + x.amount, 0);
  const free = safe.steps.find((s: any) => /Free until payday/.test(s.label)).amount;
  assert.ok(Math.abs(start + minus - free) < 0.02, `${start} ${minus} ${free}`);
  assert.deepEqual([safe.until, safe.days], ['2026-12-11', 28], 'payday is a month after the last salary');
  assert.ok(safe.week > 0 && Math.abs(safe.week - safe.perDay * 7) < 0.05);
  assert.match(safe.steps[1].label, /Landlord/);
});

test('cash flow rules: monthly bills, ended bills, everyday shops, an agreed plan', () => {
  const tx = (date: string, merchant: string, amount: number, coachKey = 'other'): Transaction =>
    ({ id: `${merchant}-${date}`, date, merchant, category: coachKey, coachKey, amount });
  const input = {
    asOf: '2026-03-10',
    accounts: [{ id: 'a', name: 'A', iban: '', balance: 1000, kind: 'current' }],
    transactions: [
      tx('2026-03-01', 'Pay', 2000, 'salary'), tx('2026-02-01', 'Pay', 2000, 'salary'), tx('2026-01-01', 'Pay', 2000, 'salary'),
      tx('2026-03-03', 'Flat', -700), tx('2026-02-03', 'Flat', -700), tx('2026-01-03', 'Flat', -700),
      tx('2026-01-10', 'Old gym', -40), tx('2025-12-10', 'Old gym', -40),
      tx('2026-03-05', 'Corner shop', -20), tx('2026-03-06', 'Corner shop', -25),
      tx('2026-02-20', 'Invest Deposit', -300, 'Invest Deposit')
    ]
  };
  const cf = buildCashflow(input);
  assert.deepEqual(cf.baskets[0].lines.map((l) => l.id), ['flat'], 'only the bill that still runs is regular');
  assert.equal(lineOf(cf, 'old-gym').basket, 'everyday', 'a bill not seen for 45 days has ended');
  assert.equal(lineOf(cf, 'corner-shop').basket, 'everyday');
  assert.equal(lineOf(cf, 'invest-deposit'), undefined, 'investing is saving, not spending');
  assert.equal(cf.income, 2000);

  const withPlan = buildCashflow({ ...input, planMonthly: 300 });
  assert.ok(withPlan.safe.week < cf.safe.week);
  assert.equal(withPlan.safeToSave, round2(Math.max(0, cf.free - 300)));
  assert.ok(withPlan.safe.steps.some((s) => /agreed plan/.test(s.label)));
});

test('a correction moves the line and recalculates everything', async () => {
  const app = createContainer();
  const before = await cashflow(app);
  const after = await cashflow(app, { corrections: [{ lineId: TRANSFER, as: 'oneoff' }] });
  assert.equal(round2(before.baskets[0].monthly - after.baskets[0].monthly), 120);
  assert.equal(round2(after.free - before.free), 120);
  assert.ok(after.safe.week > before.safe.week);
  assert.deepEqual(after.oneOffs.map((l: any) => [l.id, l.basis]), [[TRANSFER, 'corrected']]);
});

test('the trainer state is validated: it comes from the client', async () => {
  const app = createContainer();
  const { state } = await act(app, 'simulate_goal', { kind: 'car', name: 'car' });
  const tampered = { ...state, draft: { ...state.draft, running: [{ ...state.draft.running[0], url: 'javascript:alert(1)' }] } };
  const bad = ['nope', { corrections: 'x' }, { corrections: [{ lineId: TRANSFER, as: 'nonsense' }] }, { draft: { kind: 'car' } },
    { multiBank: 'yes' }, { draft: { ...state.draft, price: -1 } }, tampered];
  for (const s of bad) assert.throws(() => app.trainer.cashflow({ state: s }), status(400), JSON.stringify(s).slice(0, 60));
  assert.ok(app.trainer.cashflow({ state }), 'the state the trainer produced is accepted');
});

// ---- Conversation without a model (rules pick the tool) ----

test('questions about my own data', async () => {
  const app = createContainer();
  const safe = (await say(app, 'What can I safely spend this week?')).answer;
  assert.deepEqual([safe.type, safe.source], ['cashflow', 'rules']);
  assert.ok(safe.figure && safe.steps.length >= 4);
  assert.deepEqual(safe.review.map((l: any) => l.id), [TRANSFER], 'the assumption is offered for correction');

  const where = (await say(app, 'Where did my money go?')).answer;
  assert.equal(where.baskets.length, 3);
  assert.match(where.text, /€2,850/);

  const taxis = (await say(app, 'How much did I spend on taxis last month?')).answer;
  assert.deepEqual([taxis.figure, taxis.rows[0].label], ['€16.40', 'Bolt']);
  assert.match(taxis.text, /last month/);

  const kind = (await say(app, 'What kind of spender am I?')).answer;
  assert.match(kind.text, /Of every €100/);
  assert.equal(kind.rows.length, 3);

  const cut = await say(app, 'How much could I save if I cut dining out by 20%?');
  assert.match(cut.answer.text, /eating out by 20% would free about \*\*€\d+ a month/);
  assert.equal(cut.state.draft, null, 'an estimate does not start a goal');

  const joke = (await say(app, 'tell me a joke')).answer;
  assert.equal(joke.type, 'clarify');
  assert.ok(joke.examples.length > 0);
  const scenario = (await say(app, 'What happens if I stop ordering food delivery?')).answer;
  assert.deepEqual([scenario.type, scenario.scenarioId], ['forecast', 'stop_food'], 'the 3D City scenarios still answer');
});

test('the user corrects assumptions in their own words', async () => {
  const app = createContainer();
  const before = await cashflow(app);
  const gift = await say(app, 'That €120 transfer was a one-off gift, not a monthly bill');
  assert.deepEqual(gift.state.corrections, [{ lineId: TRANSFER, as: 'oneoff' }]);
  assert.match(gift.answer.text, /Transfer to Maija K\./);
  assert.ok(gift.answer.steps && gift.answer.baskets);

  const repair = await say(app, 'That €85 charge was a mandatory appliance repair, not everyday spending', gift.state);
  assert.deepEqual(repair.state.corrections[1], { lineId: REPAIR, as: 'irregular' });
  const after = await cashflow(app, repair.state);
  assert.equal(lineOf(after, REPAIR).basket, 'irregular');
  assert.ok(after.baskets[2].monthly < before.baskets[2].monthly, 'everyday spending went down');
  assert.ok(after.safe.week > before.safe.week);
});

test('a big decision: savings path, running costs and what-ifs', async () => {
  const app = createContainer();
  let r = await carBrief(app);
  assert.equal(r.answer.type, 'brief', 'first a brief to confirm, no numbers yet');
  assert.equal(r.answer.scenarios, undefined);
  assert.match(r.answer.text, /\*\*Goal:\*\* car[\s\S]*\*\*Budget:\*\* €15,000 \(my assumption[\s\S]*in 12 months[\s\S]*Is this right\?/);
  assert.deepEqual([r.state.draft.kind, r.state.draft.months, r.state.draft.price, r.state.draft.priceSource, r.state.draft.confirmed], ['car', 12, 15000, 'assumption', false]);
  assert.equal(r.state.draft.running.length, 5, 'insurance, fuel, maintenance, tax, parking');
  r = await say(app, 'Make it 18 months', r.state);
  assert.deepEqual([r.answer.type, r.state.draft.months], ['brief', 18], 'a change before confirming updates the brief');
  r = await say(app, 'Make it 12 months', r.state);
  r = await say(app, YES, r.state);
  assert.deepEqual([r.answer.type, r.state.draft.confirmed], ['scenario', true]);
  const plan = r.answer.scenarios[0];
  assert.deepEqual([plan.id, plan.feasible, plan.upfront], ['plan', false, 15000]);
  assert.ok(plan.gap > 0 && plan.afterMonthly > 0);
  assert.ok(r.answer.scenarios.some((s: any) => s.id === 'wait' && s.gap === 0), 'an alternative that fits is offered');
  assert.match(r.answer.nextStep.title, /Closest option that fits/);

  r = await say(app, 'What if I wait 3 more months?', r.state);
  assert.equal(r.state.draft.months, 15);
  const capacity = r.answer.scenarios[0].monthlyCapacity;
  r = await say(app, 'What if I cut dining out by 20%?', r.state);
  assert.deepEqual(r.state.draft.cuts, [{ group: 'dining', pct: 20 }]);
  assert.ok(r.answer.scenarios[0].monthlyCapacity > capacity);
  assert.ok(r.answer.scenarios.some((s: any) => s.id === 'current'), 'compared with current spending');
  r = await say(app, 'What if I keep my current everyday spending?', r.state);
  assert.deepEqual(r.state.draft.cuts, []);
  r = await say(app, 'What if I take a loan?', r.state);
  assert.deepEqual(r.state.draft.loan, { years: 5, ratePct: 6, rateSource: 'assumption' });
  const financed = r.answer.scenarios[0];
  assert.ok(financed.loan.amount > 0 && financed.loan.payment > 0);
  assert.equal(financed.upfront, Math.round((15000 - financed.loan.amount) * 100) / 100, 'upfront is the part not borrowed');
  r = await say(app, 'What if the car costs €9,000?', r.state);
  assert.deepEqual([r.state.draft.price, r.state.draft.priceSource], [9000, 'user']);
  r = await say(app, 'Insurance is €80 a month', r.state);
  assert.deepEqual(r.state.draft.running[0], { id: 'insurance', label: 'Insurance', monthly: 80, source: 'user' });

  const slider = await act(app, 'what_if', { months: 24, cut_group: 'everyday', cut_pct: 10 }, r.state);
  assert.equal(slider.state.draft.months, 24, 'sliders call the same tool');
  await assert.rejects(() => act(app, 'what_if', { months: 9999 }, r.state), status(400));
  await assert.rejects(() => act(app, 'launch_rocket'), status(400));
});

test('the brief asks for what is missing before any numbers', async () => {
  const app = createContainer();
  let r = await say(app, 'Could I afford a holiday in half a year?');
  assert.deepEqual([r.answer.type, r.state.draft.price, r.state.draft.months], ['brief', 0, 6]);
  assert.match(r.answer.text, /Budget:\*\* not set yet/);
  r = await say(app, YES, r.state);
  assert.deepEqual([r.answer.type, r.state.draft.confirmed], ['brief', false], 'cannot confirm without a budget');
  r = await say(app, 'The budget is €3,000', r.state);
  assert.deepEqual([r.answer.type, r.state.draft.price, r.state.draft.priceSource], ['brief', 3000, 'user']);
  r = await say(app, YES, r.state);
  assert.equal(r.answer.type, 'scenario');
});

test('an agreed plan is set aside, and re-checked when spending changes', async () => {
  const app = createContainer();
  const base = await cashflow(app);
  const none = await say(app, 'Agree this plan');
  assert.equal(none.state.plan, null);
  const brief = await carBrief(app);
  const early = await say(app, 'Agree this plan', brief.state);
  assert.deepEqual([early.state.plan, early.answer.type], [null, 'brief'], 'the brief is confirmed before anything is agreed');
  const car = await say(app, YES, brief.state);
  const refused = await say(app, 'Agree this plan', car.state);
  assert.equal(refused.state.plan, null, 'a plan that does not add up is not agreed');
  assert.match(refused.answer.text, /does not add up/);

  let r = await confirmed(app, 'Could I afford a €3,800 trip in 8 months?');
  assert.deepEqual([r.state.draft.kind, r.state.draft.name, r.state.draft.price, r.state.draft.months], ['purchase', 'trip', 3800, 8]);
  assert.equal(r.answer.scenarios[0].feasible, true);
  assert.deepEqual([r.answer.nextStep.title, r.answer.nextStep.ask], ['Prepared next step', 'Agree this plan']);
  r = await say(app, 'Agree this plan', r.state);
  assert.equal(r.answer.type, 'plan');
  assert.equal(r.state.draft, null);
  assert.equal(r.answer.nextStep.screen, 'transfer', 'the transfer is prepared, not made');
  const plan = r.state.plan;
  assert.ok(plan.monthlySaving > 0 && plan.targetDate === '2027-07-13');
  assert.deepEqual(plan.monitor, { prices: false, conditions: false, spending: false }, 'nothing is monitored without approval');
  const saving = await cashflow(app, r.state);
  assert.ok(saving.safe.week < base.safe.week, 'the plan comes off safe-to-spend');
  assert.equal(saving.safeToSave, round2(base.free - plan.monthlySaving));

  const some = await act(app, 'set_monitoring', { prices: true }, r.state);
  assert.deepEqual(some.state.plan.monitor, { prices: true, conditions: false, spending: false }, 'the user picks what is monitored');
  r = await say(app, 'Yes, re-check it for me', r.state);
  assert.deepEqual(r.state.plan.monitor, { prices: true, conditions: true, spending: true });
  const same = await act(app, 'recheck_plan', {}, r.state);
  assert.equal(same.state.plan.lastCheck.status, 'on_track');
  assert.match(same.state.plan.lastCheck.changes[0], /No change was verified/);

  const dentistMonthly = { ...r.state, corrections: [{ lineId: 'hammasl-k-ri-hymy', as: 'regular' }] };
  const worse = await say(app, 'Re-check my plan', dentistMonthly);
  assert.equal(worse.state.plan.lastCheck.status, 'at_risk');
  assert.match(worse.answer.text, /less than when we agreed/);
  assert.equal(worse.answer.scenarios.length, 1);
  assert.deepEqual(worse.answer.choices.map((c: any) => c.id), ['later'], 'short: the honest choice is a later date');
  const later = await say(app, 'Reach the goal later', worse.state);
  assert.ok(later.state.plan.targetDate > plan.targetDate && later.state.plan.monthlySaving < plan.monthlySaving);
});

test('when there is room, the user chooses: contribute less, reach the goal sooner, or a larger buffer', async () => {
  const app = createContainer();
  let r = await confirmed(app, 'Could I afford a €3,800 trip in 8 months?');
  r = await say(app, 'Agree this plan', r.state);
  const agreed = r.state.plan;
  // The €120 transfer turns out to be a one-off: €120 more is free each month.
  const richer = { ...r.state, corrections: [{ lineId: TRANSFER, as: 'oneoff' }] };
  const check = await act(app, 'recheck_plan', {}, richer);
  assert.match(check.answer.text, /€120 more than when we agreed[\s\S]*You decide/);
  assert.deepEqual(check.answer.choices.map((c: any) => c.id), ['less', 'sooner', 'buffer']);
  const [less, sooner, buffer] = check.answer.choices;
  assert.equal(less.targetDate, agreed.targetDate);
  assert.ok(less.monthlySaving <= agreed.monthlySaving, 'fewer monthly bills also free a little of the cushion');
  assert.ok(sooner.monthlySaving > agreed.monthlySaving && sooner.targetDate < agreed.targetDate);
  assert.equal(round2(buffer.monthlySaving + buffer.bufferMonthly), sooner.monthlySaving, 'the buffer takes what the goal does not need');

  const fast = await say(app, 'Reach the goal sooner', check.state);
  assert.deepEqual([fast.state.plan.monthlySaving, fast.state.plan.targetDate], [sooner.monthlySaving, sooner.targetDate]);
  assert.match(fast.state.plan.lastCheck.changes[0], /You chose: reach the goal sooner/);
  const safe = await act(app, 'choose_path', { id: 'buffer' }, check.state);
  assert.equal(safe.state.plan.bufferMonthly, buffer.bufferMonthly);
  const spendWithBuffer = (await cashflow(app, safe.state)).safe.week;
  const spendWithLess = (await cashflow(app, (await act(app, 'choose_path', { id: 'less' }, check.state)).state)).safe.week;
  assert.ok(spendWithBuffer < spendWithLess, 'the buffer is set aside before safe-to-spend');
  await assert.rejects(() => act(app, 'choose_path', { id: 'later' }, check.state), status(400));
});

test('other banks (PSD2) can be included in the picture', async () => {
  const app = createContainer();
  const on = await say(app, 'Include my other bank accounts');
  assert.equal(on.state.multiBank, true);
  const cf = await cashflow(app, on.state);
  assert.equal(cf.income, 3030, 'the side job paid into the other bank counts');
  assert.equal(cf.safe.steps[0].amount, round2(2612.34 + 438.6));
  assert.equal(lineOf(cf, 'spotify').basket, 'regular');
  assert.equal(lineOf(cf, 'kahvila-aamu').basket, 'everyday');
  assert.equal(lineOf(await cashflow(app), 'spotify'), undefined);
  assert.equal((await act(app, 'set_multibank', { on: false }, on.state)).state.multiBank, false);
});

// ---- Research (Exa) ----

const CAR_SOURCE = {
  title: 'Used cars in Finland', url: 'https://www.example.fi/cars', published: '2026-10-01',
  snippet: 'The average price of a used car sold in Finland was 12 500 euros in 2026.'
};
const LISTING_SOURCE = {
  title: 'Toyota Corolla 2019', url: 'https://www.example.fi/corolla', published: '2026-10-01',
  snippet: 'Toyota Corolla 2019. Cash price €13,900. Includes winter tyres.'
};
const INSURANCE_SOURCE = {
  title: 'Car insurance', url: 'https://www.example.fi/insurance', published: '2026-10-01',
  snippet: 'Auto insurance costs 720 €/vuosi on average.'
};

const CAR_MARKET = {
  content: {
    typical_price_eur: 12500,
    options: [
      { name: 'Toyota Corolla 2019', price_eur: 13900, conditions: 'Includes winter tyres.' },
      { name: 'Skoda Octavia 2018', price_eur: 11200 }, { name: 'No price' }
    ]
  },
  grounding: [
    { field: 'typical_price_eur', confidence: 'high', urls: [CAR_SOURCE.url] },
    { field: 'options[0].price_eur', confidence: 'medium', urls: [LISTING_SOURCE.url] },
    { field: 'options[1]', confidence: 'low', urls: ['https://www.example.fi/octavia'] }
  ],
  sources: [CAR_SOURCE, LISTING_SOURCE]
};
const CAR_COSTS = {
  content: { insurance_eur_per_year: 720, fuel_eur_per_year: 1500, maintenance_eur_per_year: 99999999, tax_eur_per_year: 300 },
  grounding: [{ field: 'insurance_eur_per_year', confidence: 'high', urls: ['https://www.example.fi/insurance'] }, { field: 'tax_eur_per_year', confidence: 'low', urls: ['https://www.example.fi/tax'] }],
  sources: [INSURANCE_SOURCE, { title: 'Running a car', url: 'https://www.example.fi/fuel', published: '2026-09-01', snippet: 'A typical driver spends 1 500 euros a year on fuel.' }]
};

test('goal research with Exa: options, costs beyond the price, and a source for every figure used', async () => {
  const logs: string[] = [];
  const research = fakeResearch({ 'for sale': CAR_MARKET, 'seller listings': CAR_MARKET, 'yearly cost': CAR_COSTS, 'loan': new Error('Exa HTTP 500') });
  const app = createContainer({ research, log: (m) => { logs.push(m); } });
  const car = await confirmed(app, 'Could I buy a car next year?');
  const r = await say(app, 'Look up real prices', car.state);
  assert.equal(r.answer.type, 'research');
  assert.equal(research.queries.length, 8, 'confirming researched once (benchmarks, listings, running costs, financing), the request once more');
  assert.ok(research.queries[0].includes(`car for sale in Finland ${new Date().getUTCFullYear()}`));

  const goal = r.state.draft;
  assert.deepEqual([goal.price, goal.priceSource], [12500, 'research']);
  assert.deepEqual(goal.options, [{ name: 'Toyota Corolla 2019', price: 13900, url: LISTING_SOURCE.url, evidence: LISTING_SOURCE, conditions: 'Includes winter tyres.' }]);
  const cost = (id: string) => goal.running.find((c: any) => c.id === id);
  assert.deepEqual([cost('insurance').monthly, cost('insurance').source, cost('insurance').url], [60, 'research', 'https://www.example.fi/insurance']);
  assert.deepEqual([cost('fuel').monthly, cost('fuel').source], [125, 'research'], 'no named source, but a passage states the number');
  assert.deepEqual([cost('maintenance').source, cost('tax').source], ['assumption', 'assumption'], 'out of range or low confidence: the assumption stays');
  assert.match(r.answer.text, /Typical price: €12,500 \(example\.fi\)[\s\S]*No source stated clearly: maintenance and tyres, vehicle tax/);
  assert.match(r.answer.text, /Exa could not check financing terms/);
  assert.equal(car.answer.type, 'research', 'confirming the brief already researched it');
  assert.equal(r.answer.scenarios[0].monthlyNeeded, car.answer.scenarios[0].monthlyNeeded, 'searching again finds the same figures');
  assert.equal(goal.benchmarks.find((b: any) => b.topic === 'insurance').quote, INSURANCE_SOURCE.snippet);
  assert.ok(r.answer.sources.length >= 2 && r.answer.scenarios, 'sources and the recalculated comparison come with it');
  assert.match(logs.join(' '), /financing.*Exa HTTP 500/, 'a failed topic is logged, the rest still answers');

  const picked = await say(app, 'Use option 1', r.state);
  assert.deepEqual([picked.state.draft.price, picked.state.draft.priceSource], [13900, 'research']);
  assert.equal(picked.state.draft.benchmarks.find((b: any) => b.topic === 'price').quote, LISTING_SOURCE.snippet);
  const refreshed = await act(app, 'research_goal', {}, picked.state);
  assert.equal(refreshed.state.draft.price, 13900, 'research keeps the selected listing budget');

  const own = await confirmed(app, 'Could I buy a €9,000 car next year?');
  const kept = await act(app, 'research_goal', {}, own.state);
  assert.equal(kept.state.draft.price, 9000, "the user's own budget is not overwritten");
  assert.match(kept.answer.text, /Your budget stays €9,000/);
});

test('web research: open questions get sources; without a key the trainer says so', async () => {
  const research = fakeResearch({}, [CAR_SOURCE]);
  const found = await say(createContainer({ research }), 'What does an average household spend on food?');
  assert.deepEqual([found.answer.type, found.answer.sources], ['research', [CAR_SOURCE]]);
  assert.match(research.queries[0], /average household spend on food\? Finland/);

  const car = await confirmed(createContainer(), 'Could I buy a car next year?');
  const off = await say(createContainer(), 'Look up real prices', car.state);
  assert.match(off.answer.text, /EXA_API_KEY/);
  assert.equal(off.state.draft.price, 15000);
  assert.deepEqual(await createContainer().handle('GET', '/api/trainer/status').then((s: any) => [s.model, s.research, s.data, s.starters.length]), [false, false, 'fixture', 4]);
});

test('a revised product needs confirmation, then searches that product with old evidence cleared', async () => {
  const research = fakeResearch({ 'for sale': CAR_MARKET, 'seller listings': CAR_MARKET });
  const app = createContainer({ research });
  const initial = await act(app, 'simulate_goal', { kind: 'car', name: 'used Toyota Corolla', note: 'Personal case details' });
  const ready = await act(app, 'confirm_brief', {}, initial.state);
  const first = await act(app, 'research_goal', {}, ready.state);
  assert.equal(first.state.draft.options.length, 1);
  const revised = await act(app, 'what_if', { name: 'used Toyota Yaris Hybrid' }, first.state);
  assert.equal(revised.answer.type, 'brief');
  assert.equal(revised.state.draft.options.length, 0);
  await act(app, 'research_goal', {}, revised.state);
  assert.equal(research.queries.length, 8, 'no research before the revised brief is confirmed (confirm and the first search ran 4 each)');
  await act(app, 'confirm_brief', {}, revised.state);
  assert.match(research.queries[8], /used Toyota Yaris Hybrid/, 'confirming the revised brief researches the new product');
  assert.ok(research.queries.every((query) => !query.includes('Personal case details')));
});

test('a price without a supporting excerpt cannot replace the plan after a partial Exa failure', async () => {
  const mixed = { content: { typical_price_eur: 12500 }, grounding: CAR_MARKET.grounding,
    sources: [{ ...CAR_SOURCE, snippet: 'The search page returned 12 500 results without a cash price.' }] };
  const research = fakeResearch({ 'for sale': mixed, 'seller listings': new Error('Exa HTTP 429') });
  const app = createContainer({ research });
  const initial = await confirmed(app, 'Could I buy a car next year?');
  const result = await act(app, 'research_goal', {}, initial.state);
  assert.match(result.answer.text, /no verified figures/i);
  assert.match(result.answer.text, /could not check seller listings/i);
  assert.equal(result.state.draft.price, initial.state.draft.price);
  assert.deepEqual(result.state.draft.options, []);
  assert.equal(result.answer.scenarios[0].monthlyNeeded, initial.answer.scenarios[0].monthlyNeeded);
});

test('an approved monitor looks the price up again and reports a change with its source', async () => {
  const tripSource = { ...CAR_SOURCE, url: 'https://www.example.fi/trips', snippet: 'This package costs €4,200 for two travellers.' };
  const research = fakeResearch({ 'for sale': { content: { typical_price_eur: 4200 }, grounding: [{ field: 'typical_price_eur', confidence: 'high', urls: [tripSource.url] }], sources: [tripSource] } });
  const app = createContainer({ research });
  // The plan was agreed before prices moved (no Exa then); the state travels with the client.
  const plain = createContainer();
  let r = await confirmed(plain, 'Could I afford a €3,800 trip in 8 months?');
  r = await say(plain, 'Agree this plan', r.state);
  const unwatched = await act(app, 'recheck_plan', {}, r.state);
  assert.equal(research.queries.length, 0, 'nothing is looked up without approval');
  assert.match(unwatched.state.plan.lastCheck.changes[0], /Nothing has changed/);

  const watched = await act(app, 'set_monitoring', { prices: true }, r.state);
  const check = await act(app, 'recheck_plan', {}, watched.state);
  assert.match(check.state.plan.lastCheck.changes.join('\n'), /current typical price is €4,200 \(example\.fi\)[.;] your plan counts €3,800/i);
  assert.equal(check.state.plan.goal.price, 3800, 'checking prices does not change the agreed plan');
  assert.equal(check.state.plan.lastCheck.proposedGoal.price, 4200);
  assert.ok(check.answer.scenarios[0].monthlyNeeded > check.state.plan.monthlySaving);
  assert.ok(check.answer.followUps.includes('The budget is €4,200') && check.answer.sources.length === 1);
  const updated = await say(app, 'The budget is €4,200', check.state);
  assert.deepEqual([updated.state.draft.price, updated.answer.type], [4200, 'scenario'], 'the user decides whether to adopt the new price');
});

test('a figure the model found by search enters the plan only with a quote the source really contains', async () => {
  const research = fakeResearch({}, [CAR_SOURCE]);
  const search = { name: 'search_web', args: { query: 'average used car price Finland 2026' } };
  const apply = (value: number, quote: string) => ({ name: 'apply_benchmark', args: { topic: 'price', value, unit: 'eur', source_url: CAR_SOURCE.url, quote } });

  const good = scriptedAgent([{ name: 'simulate_goal', args: { kind: 'car', name: 'used car', note: 'commutes 40 km a day' } }, search, apply(12500, 'used car sold in Finland was 12 500 euros')],
    'A typical used car costs about **€12,500**.');
  const r = await say(createContainer({ research, agent: good.agent }), 'Could I buy a used Toyota next year? Check real prices.');
  assert.deepEqual([r.state.draft.price, r.state.draft.priceSource, r.state.draft.note], [12500, 'research', 'commutes 40 km a day']);
  assert.deepEqual([r.state.draft.benchmarks[0].value, r.state.draft.benchmarks[0].url], [12500, CAR_SOURCE.url]);
  assert.match(r.answer.text, /€12,500/);
  assert.equal(r.answer.type, 'brief', 'the user still confirms the goal');
  assert.deepEqual(r.answer.sources, [CAR_SOURCE]);

  const invented = scriptedAgent([{ name: 'simulate_goal', args: { kind: 'car', name: 'used car' } }, search, apply(9000, 'a used car costs 9 000 euros'),
    apply(9000, 'used car sold in Finland was 12 500 euros')], 'Done.');
  const bad = await say(createContainer({ research, agent: invented.agent }), 'Could I buy a used Toyota next year?');
  assert.equal(bad.state.draft.price, 15000);
  assert.match(invented.seen.results[2].error, /word for word/);
  assert.match(invented.seen.results[3].error, /must state the value and its currency or unit/);
});

test('cuts can target any of the user\'s own spending categories, not just two', async () => {
  const app = createContainer();
  let r = await confirmed(app, 'Could I buy a car next year?');
  const base = r.answer.scenarios[0].monthlyCapacity;
  r = await act(app, 'what_if', { cut_group: 'restaurants', cut_pct: 50 }, r.state);
  assert.deepEqual(r.state.draft.cuts, [{ group: 'Restaurants', pct: 50 }], 'stored under the category name from the data');
  const withRestaurants = r.answer.scenarios[0].monthlyCapacity;
  assert.ok(withRestaurants > base);
  r = await act(app, 'what_if', { cut_group: 'Taxi', cut_pct: 100 }, r.state);
  assert.equal(r.state.draft.cuts.length, 2, 'several categories at once');
  assert.ok(r.answer.scenarios[0].monthlyCapacity > withRestaurants);
  r = await act(app, 'what_if', { cut_group: 'restaurants', cut_pct: 0 }, r.state);
  assert.deepEqual(r.state.draft.cuts.map((c: any) => c.group), ['taxi'], 'a cut of 0% removes it');
  await assert.rejects(() => act(app, 'what_if', { cut_group: 'yachts', cut_pct: 10 }, r.state), (e: any) => e.status === 400 && /Choose from: .*Restaurants/.test(e.message));
});

test('a loan is a choice: amount, years and rate are yours, and the rate says where it came from', async () => {
  const app = createContainer();
  let r = await confirmed(app, 'Could I buy a car next year?');
  r = await act(app, 'what_if', { loan: true }, r.state);
  const auto = r.answer.scenarios[0];
  assert.ok(auto.loan.amount > 0 && auto.loan.totalInterest > 0);
  assert.equal(r.state.draft.loan.rateSource, 'assumption');

  const half = await act(app, 'what_if', { loan_amount: 5000, loan_years: 3, loan_rate_pct: 4.5 }, r.state);
  const loan = half.answer.scenarios[0].loan;
  assert.deepEqual([loan.amount, loan.years, loan.ratePct, half.state.draft.loan.rateSource], [5000, 3, 4.5, 'user']);
  assert.equal(loan.totalInterest, Math.round((loan.payment * 36 - 5000) * 100) / 100);
  assert.ok(half.answer.scenarios[0].monthlyNeeded > auto.monthlyNeeded, 'borrowing less means saving more each month');
  const none = await act(app, 'what_if', { loan_amount: 0 }, r.state);
  assert.equal(none.answer.scenarios[0].loan, undefined, 'borrowing nothing is no loan');

  // A rate Exa found is used, with its source, when a loan is switched on.
  const loanSource = { title: 'Loans', url: 'https://www.example.fi/loans', published: '', snippet: 'Nominal interest 10.64% per year. Minimum age is 23.' };
  const research = fakeResearch({ 'for sale': CAR_MARKET, 'yearly cost': CAR_COSTS, loan: {
    content: { interest_rate_pct: 10.64, conditions: 'Minimum age is 23.' },
    grounding: [{ field: 'interest_rate_pct', confidence: 'high', urls: [loanSource.url] }], sources: [loanSource] } });
  const found = await act(createContainer({ research }), 'research_goal', {}, r.state.draft ? { ...r.state, draft: { ...r.state.draft, loan: null } } : r.state);
  assert.match(found.answer.text, /Minimum age is 23/);
  const withRate = await act(createContainer({ research }), 'what_if', { loan: true }, found.state);
  assert.deepEqual([withRate.state.draft.loan.ratePct, withRate.state.draft.loan.rateSource, withRate.state.draft.loan.rateUrl], [10.64, 'research', 'https://www.example.fi/loans']);
});

test('when the plan falls short the trainer offers concrete ways to close the gap', async () => {
  const app = createContainer();
  const r = await confirmed(app, 'Could I buy a car next year?');
  const ids = r.answer.fixes.map((f: any) => f.id);
  assert.deepEqual(ids, ['wait', 'price', 'loan'], 'no cut suggestion: the gap is more than half of everyday spending');
  const wait = r.answer.fixes.find((f: any) => f.id === 'wait');
  const waited = await act(app, 'what_if', wait.args, r.state);
  assert.equal(waited.answer.scenarios[0].gap, 0, 'the suggested wait closes the gap');
  const price = r.answer.fixes.find((f: any) => f.id === 'price');
  assert.equal((await act(app, 'what_if', price.args, r.state)).answer.scenarios[0].gap, 0);
  const fitting = await confirmed(app, 'Could I afford a €3,800 trip in 8 months?');
  assert.equal(fitting.answer.fixes, undefined, 'nothing to fix when it fits');
});

// ---- The trace: what the trainer did, step by step ----

test('every answer carries a trace of the steps behind it, with Exa queries and sources', async () => {
  const research = fakeResearch({ 'for sale': CAR_MARKET, 'yearly cost': CAR_COSTS });
  const app = createContainer({ research });
  const car = await confirmed(app, 'Could I buy a car next year?');
  const trace = car.answer.trace;
  assert.deepEqual(trace.map((t: any) => [t.kind, t.status]), [['rules', 'done'], ['tool', 'done']]);
  assert.match(trace[1].title, /Ran the numbers/);
  assert.ok(typeof trace[1].ms === 'number' && trace[1].detail);

  const events: any[] = [];
  const researched = await app.handle('POST', '/api/trainer/action', { action: { name: 'research_goal' }, state: car.state }, {}, (e: any) => events.push(e));
  const step = researched.answer.trace[0];
  assert.match(step.title, /Researched on the web with Exa/);
  assert.equal(step.items.length, 4, 'the queries cover the market benchmark, listings, running costs and financing');
  assert.match(step.items[0], /^Asked Exa: car for sale in Finland/);
  assert.ok(step.sources.length > 0 && step.sources.every((s: any) => s.url.startsWith('http')));
  assert.deepEqual(events.map((e) => [e.step.id, e.step.status]), [['tool-1', 'running'], ['tool-1', 'done']], 'steps are reported live: running, then done');
});

test('a failing tool and a failing model show up in the trace', async () => {
  const broken: AgentModel = { run: async () => { throw new Error('quota exceeded'); } };
  const r = await say(createContainer({ agent: broken, log: () => {} }), 'Where did my money go?');
  assert.deepEqual(r.answer.trace.map((t: any) => [t.id, t.status]), [['model', 'failed'], ['rules', 'done'], ['tool-1', 'done']]);
  assert.match(r.answer.trace[0].detail, /quota exceeded/);
  const events: any[] = [];
  await assert.rejects(() => createContainer().handle('POST', '/api/trainer/action', { action: { name: 'reclassify', args: { line_id: 'nope', basket: 'regular' } } }, {}, (e: any) => events.push(e)), status(400));
  assert.deepEqual(events.map((e) => e.step.status), ['running', 'failed']);
});

test('HTTP adapter streams the steps, then the result, when the client asks for NDJSON', async () => {
  await withServer({}, {}, async (base) => {
    const res = await fetch(`${base}/api/trainer/chat`, { method: 'POST', headers: { Accept: 'application/x-ndjson' }, body: JSON.stringify({ messages: [{ role: 'user', text: 'Where did my money go?' }] }) });
    assert.match(res.headers.get('content-type')!, /ndjson/);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.type), ['step', 'step', 'step', 'done']);
    assert.equal(lines.at(-1).result.answer.baskets.length, 3);
    const bad = await fetch(`${base}/api/trainer/chat`, { method: 'POST', headers: { Accept: 'application/x-ndjson' }, body: JSON.stringify({ messages: [] }) });
    assert.deepEqual(JSON.parse((await bad.text()).trim()), { type: 'error', status: 400, message: 'messages must be a non-empty list' });
  });
});

// ---- Conversation with a model ----

test('with a model: tools give the figures, the model gives the words', async () => {
  const week = Math.round((await cashflow(createContainer())).safe.week);
  const { agent, seen } = scriptedAgent([{ name: 'get_safe_to_spend', args: {} }], `Good news: about **€${week}** is yours to enjoy this week.`);
  const r = await say(createContainer({ agent }), 'How much is okay to spend?');
  assert.deepEqual([r.answer.type, r.answer.source], ['cashflow', 'model']);
  assert.match(r.answer.text, /Good news/);
  assert.ok(r.answer.steps, 'the cards come from the tool');
  assert.ok(seen.request!.tools.length >= 14);
  assert.match(seen.request!.system, new RegExp(`${TRANSFER} \\| Transfer to Maija K\\. \\| regular .* ASSUMED`));
  assert.equal(seen.results[0].followUps, undefined, 'UI chips are not sent to the model');
});

test('a model figure that no tool returned is replaced by the computed answer', async () => {
  const logs: string[] = [];
  const { agent } = scriptedAgent([{ name: 'get_safe_to_spend', args: {} }], 'You can spend €9,999 this week.');
  const r = await say(createContainer({ agent, log: (m) => { logs.push(m); } }), 'How much is okay to spend?');
  assert.equal(r.answer.source, 'rules');
  assert.ok(!r.answer.text.includes('9,999') && r.answer.text.includes('safely spend'));
  assert.match(logs.join(' '), /€9,999/);
});

test('a failing model falls back to the rules; general questions need no tool', async () => {
  const logs: string[] = [];
  const broken: AgentModel = { run: async () => { throw new Error('quota exceeded'); } };
  const r = await say(createContainer({ agent: broken, log: (m) => { logs.push(m); } }), 'Where did my money go?');
  assert.deepEqual([r.answer.source, r.answer.baskets.length], ['rules', 3]);
  assert.match(logs[0], /quota exceeded/);

  const general = await say(createContainer({ agent: scriptedAgent([], 'A budget is a plan for your money.').agent }), 'What is a budget?');
  assert.deepEqual([general.answer.type, general.answer.source], ['chat', 'model']);
  const made = await say(createContainer({ agent: scriptedAgent([], 'You spent €4,321 on taxis.').agent }), 'tell me a joke');
  assert.equal(made.answer.type, 'clarify', 'figures without a tool are not passed on');
});

test('the conversation is validated', async () => {
  const app = createContainer();
  const bad = [undefined, {}, { messages: [] }, { messages: 'hi' }, { messages: [{ role: 'assistant', text: 'hi' }] },
    { messages: [{ role: 'user', text: '   ' }] }, { messages: [{ role: 'system', text: 'x' }] }, { messages: [{ role: 'user', text: 'x'.repeat(501) }] }];
  for (const body of bad) await assert.rejects(() => app.handle('POST', '/api/trainer/chat', body), status(400), JSON.stringify(body));
  const two = await app.handle('POST', '/api/trainer/chat', { messages: [{ role: 'user', text: 'hello' }, { role: 'user', text: 'Where did my money go?' }] });
  assert.equal(two.answer.baskets.length, 3, 'two user messages in a row are fine');
});

test('figures are checked against the evidence, with rounding', () => {
  assert.deepEqual(ungroundedFigures('Save **€1,117** a month, 20% less, about 170,8 €.', { needed: 1117.33, note: 'cut by 20%', week: 170.83 }), []);
  assert.deepEqual(ungroundedFigures('It costs €1,200 or 7%.', { needed: 1117.33, list: [120, 850] }), ['€1,200', '7%']);
});

// ---- Adapters ----

test('Gemini adapter: runs the tool loop and hands the model turn back unchanged', async () => {
  const requests: any[] = [];
  const modelTurn = { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'get_baskets', args: {} }, thoughtSignature: 'sig' }] };
  const client: GeminiClient = {
    models: {
      generateContent: async (request) => {
        requests.push(request);
        return requests.length === 1 ? { functionCalls: [{ id: 'c1', name: 'get_baskets', args: {} }], candidates: [{ content: modelTurn }] } : { text: ' Done. ' };
      }
    }
  };
  const executed: ToolCall[] = [];
  const text = await createGeminiAgent({ apiKey: 'k', model: 'gemini-2.5-flash', client }).run({
    system: 'sys',
    turns: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }, { role: 'user', text: 'baskets?' }],
    tools: [{ name: 'get_baskets', description: 'd', parameters: { type: 'object', properties: {} } }],
    execute: async (call) => { executed.push(call); return { ok: true }; }
  });
  assert.equal(text, 'Done.');
  assert.deepEqual(executed, [{ name: 'get_baskets', args: {} }]);
  assert.deepEqual([requests[0].model, requests[0].config.systemInstruction], ['gemini-2.5-flash', 'sys']);
  assert.equal(requests[0].config.tools[0].functionDeclarations[0].name, 'get_baskets');
  assert.deepEqual(requests[0].contents.map((c: any) => c.role), ['user', 'model', 'user']);
  assert.equal(requests[1].contents[3], modelTurn);
  assert.deepEqual(requests[1].contents[4].parts[0].functionResponse, { id: 'c1', name: 'get_baskets', response: { result: { ok: true } } });

  const looping: GeminiClient = { models: { generateContent: async () => ({ functionCalls: [{ name: 'get_baskets', args: {} }] }) } };
  await assert.rejects(() => createGeminiAgent({ apiKey: 'k', model: 'm', client: looping }).run({
    system: '', turns: [{ role: 'user', text: 'x' }], tools: [], execute: async () => ({}), maxSteps: 2
  }), /2 steps/);
});

test('Exa adapter: key in a header, passages mapped, unusable results dropped', async () => {
  const calls: { url: string; init: any }[] = [];
  const results = [
    { title: 'Cars', url: 'https://stat.fi/cars', publishedDate: '2026-05-02T00:00:00.000Z', highlights: ['Average price 12 500 euros.', 'More text.'] },
    { title: 'Bad link', url: 'javascript:alert(1)', highlights: ['x'] },
    { title: 'Empty', url: 'https://example.com/empty' }
  ];
  const fetchImpl = (async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ results }) }; }) as unknown as typeof fetch;
  const found = await createExaResearch({ apiKey: 'exa-secret', fetchImpl }).search('used car price Finland');
  assert.deepEqual(found, [{ title: 'Cars', url: 'https://stat.fi/cars', published: '2026-05-02', snippet: 'Average price 12 500 euros. … More text.' }]);
  assert.equal(calls[0].url, 'https://api.exa.ai/search');
  assert.equal(calls[0].init.headers['x-api-key'], 'exa-secret');
  assert.deepEqual([JSON.parse(calls[0].init.body).query, JSON.parse(calls[0].init.body).userLocation], ['used car price Finland', 'FI']);
  const failing = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
  await assert.rejects(() => createExaResearch({ apiKey: 'k', fetchImpl: failing }).search('x'), /Exa HTTP 500/);

  // Structured research: Exa answers in the requested shape and names the sources per field.
  const output = {
    content: JSON.stringify({ typical_price_eur: 12500 }),
    grounding: [{ field: 'typical_price_eur', confidence: 'high', citations: [{ url: 'https://stat.fi/cars', title: 'Cars' }, { url: 'ftp://nope' }] }, { field: 'x', confidence: 'unknown' }]
  };
  const structured = (async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ results, output }) }; }) as unknown as typeof fetch;
  const answer = await createExaResearch({ apiKey: 'k', fetchImpl: structured }).extract('used car price', { typical_price_eur: { type: 'number' } });
  assert.deepEqual(answer.content, { typical_price_eur: 12500 }, 'content may arrive as a JSON string');
  assert.deepEqual(answer.grounding, [{ field: 'typical_price_eur', confidence: 'high', urls: ['https://stat.fi/cars'] }, { field: 'x', confidence: 'low', urls: [] }]);
  assert.equal(answer.sources.length, 1);
  const sent = JSON.parse(calls.at(-1)!.init.body);
  assert.deepEqual(sent.outputSchema, { type: 'object', properties: { typical_price_eur: { type: 'number' } } });
  assert.equal(sent.contents.maxAgeHours, 0, 'listing and cost research requests fresh page contents');
  assert.match(sent.systemPrompt, /Never estimate/);
});

async function withServer(deps: ContainerDeps, options: ApiOptions, run: (base: string) => Promise<void>) {
  const app = createContainer(deps);
  const server = http.createServer((req, res) => { void handleApi(app, req, res, () => {}, options); });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await run(`http://localhost:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('HTTP adapter: JSON in and out, nothing cached, errors as JSON', async () => {
  await withServer({}, {}, async (base) => {
    const chat = await fetch(`${base}/api/trainer/chat`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', text: 'Where did my money go?' }] }) });
    assert.equal(chat.status, 200);
    assert.equal(chat.headers.get('cache-control'), 'no-store');
    assert.equal(chat.headers.get('access-control-allow-origin'), null, 'no CORS unless configured');
    assert.equal((await chat.json()).answer.baskets.length, 3);
    const bad = await fetch(`${base}/api/trainer/chat`, { method: 'POST', body: '{nope' });
    assert.deepEqual([bad.status, await bad.json()], [400, { message: 'Bad JSON' }]);
    const invalid = await fetch(`${base}/api/trainer/action`, { method: 'POST', body: JSON.stringify({ action: { name: 'reclassify', args: { line_id: 'x', basket: 'regular' } } }) });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).message, /Unknown line_id/);
  });
});

test('HTTP adapter: CORS headers and preflight only for the configured origin', async () => {
  await withServer({}, { corsOrigin: 'https://app.example.com' }, async (base) => {
    const res = await fetch(`${base}/api/trainer/status`);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
    const pre = await fetch(`${base}/api/trainer/chat`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-methods')!, /POST/);
  });
});

// ---- Guided car purchase: one short question per step, then the brief ----

test('car flow: type, price, parking, payment, then a brief with the planner; nothing simulated before', async () => {
  const app = createContainer();
  const msgs: { role: 'user' | 'assistant'; text: string }[] = [];
  const turn = async (text: string, state?: unknown) => {
    msgs.push({ role: 'user', text });
    const r = await app.handle('POST', '/api/trainer/chat', { messages: msgs, state });
    msgs.push({ role: 'assistant', text: r.answer.text });
    return r;
  };
  let r = await turn('i want to buy a big car');
  assert.deepEqual([r.answer.type, r.answer.followUps], ['chat', ['Electric', 'Hybrid', 'Petrol / Diesel']]);
  assert.equal(r.state.draft, null, 'no brief before the questions are answered');
  r = await turn('Petrol / Diesel', r.state);
  assert.equal(r.answer.rows.length, 3, 'price bands that fit the leftover, as bars');
  assert.equal(r.answer.followUps.length, 3, 'three price taps; any other price can be typed');
  assert.equal(new Set(r.answer.rows.map((x: any) => x.label)).size, 3, 'three different prices');
  assert.equal(r.state.draft, null);
  r = await turn('4567', r.state);
  assert.ok(r.answer.followUps.some((c: string) => /Kallio/.test(c)), 'then the parking zone');
  r = await turn('Kallio / central (~€60/mo resident)', r.state);
  assert.ok(r.answer.followUps.some((c: string) => /Loan/.test(c)), 'then how to pay');
  assert.equal(r.state.draft, null);
  r = await turn('Loan · 4 years', r.state);
  assert.equal(r.answer.type, 'brief');
  assert.deepEqual([r.state.draft.name, r.state.draft.price, r.state.draft.confirmed], ['big petrol car', 4567, false]);
  assert.equal(r.state.draft.running.find((c: any) => c.id === 'parking').monthly, 60);
  assert.equal(r.state.draft.loan.years, 4);
  assert.equal(r.answer.planner.price, 4567);
  assert.ok(r.answer.text.split(/\s+/).length < 45, 'short: bottom line first');
  // After the brief, other messages go back to the trainer.
  r = await turn('Make it 18 months', r.state);
  assert.deepEqual([r.answer.type, r.state.draft.months], ['brief', 18]);
});

test('car flow: a message that already has a price goes straight to the brief', async () => {
  const r = await say(createContainer(), 'Could I buy a used Toyota Yaris Hybrid for €8,000 in 12 months?');
  assert.deepEqual([r.answer.type, r.state.draft.price], ['brief', 8000]);
});

test('investing in a property starts a purchase goal; a plan that is too costly to run says what to do next', async () => {
  const app = createContainer();
  const flat = await say(app, 'i want invest to the apartment');
  assert.deepEqual([flat.answer.type, flat.state.draft.kind, flat.state.draft.name], ['brief', 'purchase', 'apartment']);

  const brief = await act(app, 'simulate_goal', { kind: 'car', name: 'hybrid car', price: 14000, months: 60 });
  const parked = await act(app, 'what_if', { cost_id: 'parking', cost_monthly: 100 }, brief.state);
  const r = await act(app, 'confirm_brief', {}, parked.state);
  const plan = r.answer.scenarios[0];
  assert.ok(plan.gap <= 0 && plan.afterFree < 0, 'saving works, running it does not');
  assert.deepEqual([r.answer.nextStep.screen, r.answer.nextStep.title], ['plan', 'Next step: make the running costs fit']);
});
