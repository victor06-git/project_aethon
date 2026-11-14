// Contract tests: run with `npm test`. They guard the seams between teammates:
// ports, the intent list, the coach answer shape and the CSV adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createContainer, type Container } from '../backend/src/container';
import { assertPort } from '../backend/src/application/ports';
import { INTENTS } from '../backend/src/domain/intents';
import { classifyByRules } from '../backend/src/infrastructure/classifiers/rulesClassifier';
import { createScenarioEngine } from '../backend/src/infrastructure/engine/scenarioEngine';
import { loadCsvTransactions } from '../backend/src/infrastructure/repositories/csvTransactions';
import { SYSTEM_PROMPT } from '../backend/src/infrastructure/llm/prompt';

const here = path.dirname(fileURLToPath(import.meta.url));

const ask = (app: Container, question: string) => app.handle('POST', '/api/coach/messages', { question });

test('container starts with demo adapters and serves the main routes', async () => {
  const app = createContainer();
  for (const p of ['/api/bootstrap', '/api/home', '/api/accounts', '/api/transactions', '/api/coach/scenarios']) {
    assert.ok(await app.handle('GET', p, undefined, {}), p);
  }
});

test('assertPort rejects an adapter that misses a method', () => {
  assert.throws(() => assertPort('QuestionClassifier', {}), /classify/);
});

test('every rule and every prompt id is a known intent', () => {
  const questions = ['How much can I safely spend?', 'my rent went up, is it legal?', 'taxi spending',
    'Where is my money going?', 'What if I stop food delivery?', 'mortgage interest rate', 'skip cinema'];
  for (const q of questions) {
    const r = classifyByRules(q);
    assert.ok(r.intent !== 'clarify' && r.id! in INTENTS[r.intent], `${q} -> ${JSON.stringify(r)}`);
  }
  for (const ids of Object.values(INTENTS)) for (const id of Object.keys(ids)) assert.match(SYSTEM_PROMPT, new RegExp(id));
});

test('every forecast intent has a scenario in the engine', () => {
  const ids = createScenarioEngine().listScenarios().map((s) => s.id);
  for (const id of Object.keys(INTENTS.forecast)) assert.ok(ids.includes(id), id);
});

test('coach answers follow the API contract', async () => {
  const app = createContainer();
  const f = await ask(app, 'What happens if I stop ordering food delivery?');
  assert.equal(f.type, 'forecast');
  assert.ok(f.text && f.figure && f.scenarioId);
  const c = await ask(app, 'tell me a joke');
  assert.equal(c.type, 'clarify');
  assert.ok(c.examples.length > 0);
  await assert.rejects(() => ask(app, '   '), (e: any) => e.status === 400);
});

test('a failing model falls back to the rules and is logged', async () => {
  const logs: string[] = [];
  const model = { classify: async () => { throw new Error('offline'); } };
  const app = createContainer({ model, log: (m) => { logs.push(m); } });
  const r = await ask(app, 'Where is my money going?');
  assert.equal(r.source, 'rules');
  assert.match(logs[0], /offline/);
});

test('a model answer outside the intent list is ignored', async () => {
  const model = { classify: async () => ({ intent: 'forecast' as const, id: 'buy_a_boat' }) };
  const r = await ask(createContainer({ model }), 'What if I stop food delivery?');
  assert.equal(r.source, 'rules');
  assert.equal(r.scenarioId, 'stop_food');
});

test('City values: today is certain, the forecast gets less certain', () => {
  const e = createScenarioEngine();
  assert.equal(e.valuesAt('stop_food', 0).confidence, 1);
  assert.ok(e.valuesAt('stop_food', 200).confidence < 0.5);
});

test('CSV adapter reads one customer, balance, investments and taxi trips', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revi-'));
  const file = path.join(dir, 'tx.csv');
  fs.copyFileSync(path.join(here, 'fixtures', 'sample_transactions.csv'), file);
  const repo = await loadCsvTransactions({ file, customerId: 'CUST00042' });
  assert.equal(repo.list().length, 8);
  assert.equal(repo.asOf(), '2026-09-25');
  assert.equal(repo.accounts()[0].balance, 1881.6);
  assert.equal(repo.invested(), 200);
  const app = createContainer({ transactions: repo });
  const taxi = await ask(app, 'How much did I spend on taxi?');
  assert.equal(taxi.figure, '€40.00');
  const where = await ask(app, 'Where is my money going?');
  assert.ok(!where.rows!.some((r: { label: string }) => /invest/i.test(r.label)), 'investments are not spending');
  assert.ok(fs.existsSync(path.join(dir, '.cache', 'CUST00042.json')), 'cache written');
});

test('the predefined suggested questions are all answerable', async () => {
  const list: any[] = await createContainer().handle('GET', '/api/coach/suggestions');
  assert.equal(list.length, 3);
  for (const q of list) {
    assert.ok(q.text && q.short, q.id);
    const r = classifyByRules(q.text);
    assert.deepEqual([r.intent, r.id], [q.intent, q.id], q.text);
  }
});
