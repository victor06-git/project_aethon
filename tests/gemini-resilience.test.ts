import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createContainer } from '../backend/src/container';
import { createGeminiAgent, type GeminiClient } from '../backend/src/infrastructure/llm/geminiAgent';

const primary = 'gemini-3.8-flash';
const fallback = 'gemini-3.5-flash-lite';
const providerError = (status: number) => Object.assign(new Error('raw error from upstream'), { status });
const request = { messages: [{ role: 'user', text: 'Where did my money go?' }] };
const toolCall = { functionCalls: [{ name: 'get_baskets', args: {} }] };

function trainer(generateContent: GeminiClient['models']['generateContent']) {
  const agent = createGeminiAgent({ apiKey: 'test', model: primary, fallbackModel: fallback, client: { models: { generateContent } } });
  return createContainer({ agent }).trainer;
}

test('a rate limit switches to the backup model and subsequent turns skip the cooling model', async () => {
  const models: string[] = [];
  const app = trainer(async ({ model }) => {
    models.push(model);
    if (model === primary) throw providerError(429);
    return models.filter((id) => id === fallback).length % 2 ? toolCall : { text: 'Here are your spending baskets.' };
  });
  for (let i = 0; i < 2; i++) {
    const { answer } = await app.chat(request);
    assert.equal(answer.source, 'model');
    assert.equal(answer.baskets?.length, 3);
  }
  assert.deepEqual(models, [primary, fallback, fallback, fallback, fallback]);
});

test('project billing exhaustion skips the backup and keeps built-in coaching available', async () => {
  const models: string[] = [];
  const app = trainer(async ({ model }) => {
    models.push(model);
    throw providerError(402);
  });
  for (let i = 0; i < 2; i++) {
    const { answer } = await app.chat(request);
    assert.equal(answer.source, 'rules');
    assert.equal(answer.baskets?.length, 3);
    assert.match(answer.trace?.find((step) => step.kind === 'model')?.detail ?? '', /out of prepaid credit/);
  }
  assert.deepEqual(models, [primary]);
});

test('model failure after a tool preserves the computed answer without replaying it', async () => {
  const models: string[] = [];
  const app = trainer(async ({ model }) => {
    models.push(model);
    if (models.length === 1) return toolCall;
    throw providerError(429);
  });
  const { answer } = await app.chat(request);
  assert.deepEqual(models, [primary, primary]);
  assert.equal(answer.source, 'rules');
  assert.equal(answer.baskets?.length, 3);
  assert.equal(answer.trace?.filter((step) => step.kind === 'tool' && step.status === 'done').length, 1);
  assert.equal(answer.trace?.some((step) => step.kind === 'rules'), false);
});

test('one transient retry fits within the turn and the tool wait uses the same model deadline', async () => {
  let calls = 0;
  const app = trainer(async () => {
    calls++;
    if (calls === 1) throw providerError(503);
    return calls === 2 ? toolCall : { text: 'Here are your spending baskets.' };
  });
  assert.equal((await app.chat(request)).answer.source, 'model');
  assert.equal(calls, 3);

  calls = 0;
  const agent = createGeminiAgent({ apiKey: 'test', model: primary, timeoutMs: 50, client: { models: {
    async generateContent() { calls++; return toolCall; }
  } } });
  await assert.rejects(() => agent.run({ system: '', turns: [], tools: [], execute: async () => { await sleep(70); } }), /took too long/);
  assert.equal(calls, 1);
});
