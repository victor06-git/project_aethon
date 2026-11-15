// The ChatGPT adapter: tool loop over the Chat Completions API. No network: fetch is scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiAgent } from '../backend/src/infrastructure/llm/openaiAgent';

const reply = (message: unknown) => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }), { status: 200 });

test('ChatGPT agent calls tools, returns their results and then answers in text', async () => {
  const sent: any[] = [];
  const replies = [
    reply({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'safe_to_spend', arguments: '{"weeks":1}' } }] }),
    reply({ content: 'You can spend **€120** this week.' })
  ];
  const fetchImpl = (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return replies.shift()!; }) as typeof fetch;
  const agent = createOpenAiAgent({ apiKey: 'test', model: 'gpt-4.1-mini', fetchImpl });
  const calls: unknown[] = [];
  const text = await agent.run({
    system: 'sys', turns: [{ role: 'user', text: 'What can I spend?' }],
    tools: [{ name: 'safe_to_spend', description: 'd', parameters: { type: 'object', properties: {} } }],
    execute: async (call) => { calls.push(call); return { weekly: 120 }; }
  });
  assert.equal(text, 'You can spend **€120** this week.');
  assert.deepEqual(calls, [{ name: 'safe_to_spend', args: { weeks: 1 } }]);
  assert.equal(sent[0].tools[0].function.name, 'safe_to_spend');
  assert.equal(sent[0].messages[0].role, 'system');
  assert.equal(sent[1].messages.at(-1).role, 'tool');
  assert.equal(sent[1].messages.at(-1).tool_call_id, 'c1');
  assert.equal(agent.name, 'ChatGPT');
});

test('ChatGPT agent reports an HTTP error without leaking the key', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 })) as typeof fetch;
  const agent = createOpenAiAgent({ apiKey: 'secret-key', model: 'gpt-4.1-mini', fetchImpl });
  await assert.rejects(agent.run({ system: 's', turns: [{ role: 'user', text: 'hi' }], tools: [], execute: async () => null }),
    (e: Error) => e.message.startsWith('ChatGPT HTTP 401') && !e.message.includes('secret-key'));
});
