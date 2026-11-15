// AgentModel adapter: OpenAI (ChatGPT) function calling over the Chat Completions API.
// The model decides which tools to call; the application runs them and hands back the results,
// until the model answers in text. Node only: never bundled into the browser.
import type { AgentModel, AgentRequest } from '../../application/ports';
import type { Config } from '../../config';

const DEFAULT_MAX_STEPS = 6;
const TEMPERATURE = 0.2;

interface ToolCallMsg { id: string; type: 'function'; function: { name: string; arguments: string } }
type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallMsg[] }
  | { role: 'tool'; tool_call_id: string; content: string };
interface Reply { choices?: { message?: { content?: string | null; tool_calls?: ToolCallMsg[] }; finish_reason?: string }[] }

export interface OpenAiAgentOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;          // deadline for the whole turn
  requestTimeoutMs?: number;   // deadline for one API call
  fetchImpl?: typeof fetch;
}

// Reasoning models (o-series, gpt-5) reject a custom temperature.
const fixedTemperature = (model: string) => /^(o\d|gpt-5)/.test(model);

export function createOpenAiAgent({ apiKey, model, baseUrl = 'https://api.openai.com/v1', timeoutMs = 20000, requestTimeoutMs = 15000, fetchImpl = globalThis.fetch }: OpenAiAgentOptions): AgentModel {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  async function call(messages: Message[], tools: unknown[], deadline: number): Promise<Reply> {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('ChatGPT did not answer in time.');
    const res = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(Math.min(left, requestTimeoutMs)),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, messages, tools, tool_choice: 'auto', parallel_tool_calls: false,
        ...(fixedTemperature(model) ? { max_completion_tokens: 4096 } : { temperature: TEMPERATURE, max_tokens: 2048 })
      })
    });
    if (!res.ok) {
      // Only the status and OpenAI's short error message: never the request or the key.
      let detail = '';
      try { detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? ''; } catch { /* no body */ }
      throw new Error(`ChatGPT HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
    return (await res.json()) as Reply;
  }

  return {
    name: 'ChatGPT',
    async run({ system, turns, tools, execute, maxSteps = DEFAULT_MAX_STEPS }: AgentRequest): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      const specs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      const messages: Message[] = [
        { role: 'system', content: system },
        ...turns.map((t): Message => (t.role === 'assistant' ? { role: 'assistant', content: t.text } : { role: 'user', content: t.text }))
      ];

      for (let step = 0; step < maxSteps; step++) {
        const choice = (await call(messages, specs, deadline)).choices?.[0];
        const calls = choice?.message?.tool_calls ?? [];
        if (!calls.length) {
          const text = choice?.message?.content?.trim();
          if (!text || choice?.finish_reason === 'length') throw new Error('ChatGPT did not finish its answer.');
          return text;
        }
        messages.push({ role: 'assistant', content: choice?.message?.content ?? null, tool_calls: calls });
        // Tools run one after another: a later call may depend on what an earlier one changed.
        for (const c of calls) {
          let args: Record<string, unknown> = {};
          try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { /* bad JSON: the tool validates */ }
          const result = await execute({ name: c.function.name, args });
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ result }) });
        }
      }
      throw new Error(`ChatGPT did not finish within ${maxSteps} steps`);
    }
  };
}

/** Null unless the ChatGPT provider is selected and OPENAI_API_KEY is set. */
export function createOpenAiAgentFromConfig(config: Config): AgentModel | null {
  if (config.provider !== 'chatgpt' || !config.chatgpt.apiKey) return null;
  return createOpenAiAgent({ ...config.chatgpt, timeoutMs: config.chatgpt.agentTimeoutMs, requestTimeoutMs: config.chatgpt.timeoutMs });
}
