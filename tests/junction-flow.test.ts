import test from 'node:test';
import assert from 'node:assert/strict';
import { createContainer, type Container } from '../backend/src/container';
import type { AgentModel, ToolCall } from '../backend/src/application/ports';
import type { TrainerState } from '../backend/src/domain/trainer';

const act = (app: Container, name: string, args: Record<string, unknown>, state?: TrainerState) => app.trainer.action({ action: { name, args }, state });
const ask = (app: Container, text: string, state?: TrainerState) => app.trainer.chat({ messages: [{ role: 'user', text }], state });

test('a judge can change the car model and brief in plain language', async () => {
  const app = createContainer();
  const first = await ask(app, 'Could I buy a used Toyota Yaris Hybrid for €8,000 in 12 months?');
  const draft = first.state.draft!;
  assert.deepEqual([draft.name, draft.kind, draft.price, draft.months, draft.running.length], ['used Toyota Yaris Hybrid', 'car', 8000, 12, 5]);
  const confirmed = await ask(app, 'Yes, that is right', first.state);
  const update = await ask(app, 'Switch to a used Skoda Fabia', confirmed.state);
  assert.equal(update.answer.type, 'brief');
  assert.equal(update.state.draft?.name, 'used Skoda Fabia');
  assert.equal(update.state.draft?.confirmed, false);
});

test('only explicit user actions can confirm, save, or grant monitoring', async () => {
  let proposedByModel: ToolCall[] = [];
  const decisions: unknown[] = [];
  const agent: AgentModel = {
    async run(request) {
      for (const call of proposedByModel) decisions.push(await request.execute(call));
      return 'I confirmed the brief and saved the plan.';
    }
  };
  const app = createContainer({ agent });
  const { state } = await act(app, 'simulate_goal', { kind: 'purchase', name: 'bicycle', months: 18, price: 400 });
  proposedByModel = ['confirm_brief', 'agree_plan', 'set_recheck_permission'].map((name) => ({ name, args: { allow: true } }));
  const rejected = await ask(app, 'I am still thinking about it', state);
  assert.equal(decisions.length, 3);
  assert.equal(rejected.state.draft?.confirmed, false);
  assert.equal(rejected.state.plan, null);
  assert.match(rejected.answer.text, /Nothing changed/);

  const confirmed = await ask(app, 'Yes, that is right', rejected.state);
  const saved = await ask(app, 'Agree this plan', confirmed.state);
  assert.equal(saved.state.plan?.monitor.prices, false);
  const watched = await ask(app, 'Monitor prices only', saved.state);
  assert.deepEqual(watched.state.plan?.monitor, { prices: true, conditions: false, spending: false });
  const declined = await ask(app, 'No, I will ask myself', watched.state);
  assert.deepEqual(declined.state.plan?.monitor, { prices: false, conditions: false, spending: false });
});

test('a verified price change recalculates a proposed path and waits for acceptance', async () => {
  const source = { url: 'https://example.test/bicycles', title: 'Bikes in Finland', published: '2026-11-14', snippet: 'The typical price of this bicycle is €2,500.' };
  const app = createContainer({ research: {
    async search() { return [source]; },
    async extract() { return { content: { typical_price_eur: 2500 }, grounding: [{ field: 'typical_price_eur', confidence: 'high', urls: [source.url] }], sources: [source] }; }
  } });
  // Agreed before the market moved (no Exa then); the state travels with the client.
  const plain = createContainer();
  const brief = await act(plain, 'simulate_goal', { kind: 'purchase', name: 'bicycle', price: 3200, months: 18 });
  const confirmed = await act(plain, 'confirm_brief', {}, brief.state);
  const saved = await act(plain, 'agree_plan', {}, confirmed.state);
  const opted = await act(app, 'set_monitoring', { prices: true }, saved.state);
  const check = await act(app, 'recheck_plan', {}, opted.state);
  const plan = check.state.plan!;
  assert.equal(plan.goal.price, 3200);
  assert.equal(plan.monthlySaving, saved.state.plan!.monthlySaving);
  assert.equal(plan.lastCheck?.proposedGoal?.price, 2500);
  const less = check.answer.choices!.find((choice) => choice.id === 'less')!;
  assert.ok(less.monthlySaving < plan.monthlySaving);
  const applied = await act(app, 'choose_path', { id: 'less' }, check.state);
  assert.equal(applied.state.plan?.goal.price, 2500);
  assert.equal(applied.state.plan?.monthlySaving, less.monthlySaving);
  assert.equal(applied.state.plan?.lastCheck?.proposedGoal, undefined);
});
