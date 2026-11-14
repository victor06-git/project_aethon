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
async function confirmed(app: Container, question: string, state?: unknown) {
  const brief = await say(app, question, state);
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
  assert.deepEqual([taxis.figure, taxis.rows[0].label], ['€16', 'Bolt']);
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
  let r = await say(app, 'Could I buy a car next year?');
  assert.equal(r.answer.type, 'brief', 'first a brief to confirm, no numbers yet');
  assert.equal(r.answer.scenarios, undefined);
  assert.match(r.answer.text, /\*\*Goal:\*\* car[\s\S]*\*\*Budget:\*\* €15,000 \(my assumption[\s\S]*in 12 months[\s\S]*Is this right\?/);
  assert.deepEqual([r.state.draft.kind, r.state.draft.months, r.state.draft.price, r.state.draft.priceSource, r.state.draft.confirmed], ['car', 12, 15000, 'assumption', false]);
  assert.equal(r.state.draft.running.length, 4, 'insurance, fuel, maintenance, tax');
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
  assert.deepEqual(r.state.draft.loan, { years: 5, ratePct: 6 });
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
  const brief = await say(app, 'Could I buy a car next year?');
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
  assert.match(same.state.plan.lastCheck.changes[0], /Nothing has changed/);

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

const CAR_MARKET = {
  content: {
    typical_price_eur: 12500,
    options: [{ name: 'Toyota Corolla 2019', price_eur: 13900 }, { name: 'Skoda Octavia 2018', price_eur: 11200 }, { name: 'No price' }]
  },
  grounding: [
    { field: 'typical_price_eur', confidence: 'high', urls: [CAR_SOURCE.url] },
    { field: 'options[0].price_eur', confidence: 'medium', urls: ['https://www.example.fi/corolla'] },
    { field: 'options[1]', confidence: 'low', urls: ['https://www.example.fi/octavia'] }
  ],
  sources: [CAR_SOURCE]
};
const CAR_COSTS = {
  content: { insurance_eur_per_year: 720, fuel_eur_per_year: 1500, maintenance_eur_per_year: 99999999, tax_eur_per_year: 300 },
  grounding: [{ field: 'insurance_eur_per_year', confidence: 'high', urls: ['https://www.example.fi/insurance'] }, { field: 'tax_eur_per_year', confidence: 'low', urls: ['https://www.example.fi/tax'] }],
  sources: [{ title: 'Running a car', url: 'https://www.example.fi/fuel', published: '2026-09-01', snippet: 'A typical driver spends 1 500 euros a year on fuel.' }]
};

test('goal research with Exa: options, costs beyond the price, and a source for every figure used', async () => {
  const logs: string[] = [];
  const research = fakeResearch({ 'for sale': CAR_MARKET, 'yearly cost': CAR_COSTS, 'loan': new Error('Exa HTTP 500') });
  const app = createContainer({ research, log: (m) => { logs.push(m); } });
  const car = await confirmed(app, 'Could I buy a car next year?');
  const r = await say(app, 'Look up real prices', car.state);
  assert.equal(r.answer.type, 'research');
  assert.equal(research.queries.length, 3, 'options, running costs, financing');
  assert.match(research.queries[0], /car for sale in Finland 2026/);

  const goal = r.state.draft;
  assert.deepEqual([goal.price, goal.priceSource], [12500, 'research']);
  assert.deepEqual(goal.options, [{ name: 'Toyota Corolla 2019', price: 13900, url: 'https://www.example.fi/corolla' }], 'an option without a confident source is dropped');
  const cost = (id: string) => goal.running.find((c: any) => c.id === id);
  assert.deepEqual([cost('insurance').monthly, cost('insurance').source, cost('insurance').url], [60, 'research', 'https://www.example.fi/insurance']);
  assert.deepEqual([cost('fuel').monthly, cost('fuel').source], [125, 'research'], 'no named source, but a passage states the number');
  assert.deepEqual([cost('maintenance').source, cost('tax').source], ['assumption', 'assumption'], 'out of range or low confidence: the assumption stays');
  assert.match(r.answer.text, /Typical price: €12,500 \(example\.fi\)[\s\S]*No source stated clearly: maintenance and tyres, vehicle tax/);
  assert.ok(r.answer.sources.length >= 2 && r.answer.scenarios, 'sources and the recalculated comparison come with it');
  assert.match(logs.join(' '), /financing.*Exa HTTP 500/, 'a failed topic is logged, the rest still answers');

  const picked = await say(app, 'Use option 1', r.state);
  assert.deepEqual([picked.state.draft.price, picked.state.draft.priceSource], [13900, 'research']);
  assert.equal(picked.state.draft.benchmarks.find((b: any) => b.topic === 'price').url, 'https://www.example.fi/corolla');

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

test('an approved monitor looks the price up again and reports a change with its source', async () => {
  const research = fakeResearch({ 'for sale': { content: { typical_price_eur: 4200 }, grounding: [{ field: 'typical_price_eur', confidence: 'high', urls: ['https://www.example.fi/trips'] }], sources: [CAR_SOURCE] } });
  const app = createContainer({ research });
  let r = await confirmed(app, 'Could I afford a €3,800 trip in 8 months?');
  r = await say(app, 'Agree this plan', r.state);
  const unwatched = await act(app, 'recheck_plan', {}, r.state);
  assert.equal(research.queries.length, 0, 'nothing is looked up without approval');
  assert.match(unwatched.state.plan.lastCheck.changes[0], /Nothing has changed/);

  const watched = await act(app, 'set_monitoring', { prices: true }, r.state);
  const check = await act(app, 'recheck_plan', {}, watched.state);
  assert.match(check.state.plan.lastCheck.changes[0], /typical price is now €4,200 \(example\.fi\); your plan counts €3,800/);
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
  const r = await say(createContainer({ research, agent: good.agent }), 'Could I buy a used car next year? Check real prices.');
  assert.deepEqual([r.state.draft.price, r.state.draft.priceSource, r.state.draft.note], [12500, 'research', 'commutes 40 km a day']);
  assert.deepEqual([r.state.draft.benchmarks[0].value, r.state.draft.benchmarks[0].url], [12500, CAR_SOURCE.url]);
  assert.deepEqual([r.answer.source, r.answer.text], ['model', 'A typical used car costs about **€12,500**.']);
  assert.deepEqual(r.answer.sources, [CAR_SOURCE]);

  const invented = scriptedAgent([{ name: 'simulate_goal', args: { kind: 'car', name: 'used car' } }, search, apply(9000, 'a used car costs 9 000 euros'),
    apply(9000, 'used car sold in Finland was 12 500 euros')], 'Done.');
  const bad = await say(createContainer({ research, agent: invented.agent }), 'Could I buy a used car next year?');
  assert.equal(bad.state.draft.price, 15000);
  assert.match(invented.seen.results[2].error, /word for word/);
  assert.match(invented.seen.results[3].error, /must contain the value/);
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
