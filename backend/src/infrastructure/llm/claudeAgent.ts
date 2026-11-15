// AgentModel adapter: Anthropic Claude Messages API with tool use.
// Claude decides which tools to call; the application runs them and hands back the results,
// until Claude answers in text. Node only: never bundled into the browser.
import type { AgentModel, AgentRequest } from '../../application/ports';
import type { Config } from '../../config';

const DEFAULT_MAX_STEPS = 6;
const TEMPERATURE = 0.2;
const ANTHROPIC_VERSION = '2023-06-01';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

type Message = { role: 'user' | 'assistant'; content: string | ContentBlock[] };

interface Reply {
  content?: ContentBlock[];
  stop_reason?: string;
  error?: { message?: string };
}

export interface ClaudeAgentOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createClaudeAgent({
  apiKey,
  model,
  baseUrl = 'https://api.anthropic.com',
  timeoutMs = 20000,
  requestTimeoutMs = 15000,
  fetchImpl = globalThis.fetch
}: ClaudeAgentOptions): AgentModel {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;

  async function call(system: string, messages: Message[], tools: unknown[], deadline: number): Promise<Reply> {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('Claude did not answer in time.');
    const res = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(Math.min(left, requestTimeoutMs)),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        temperature: TEMPERATURE,
        system,
        messages,
        tools,
        tool_choice: { type: 'auto' }
      })
    });
    if (!res.ok) {
      let detail = '';
      try { detail = ((await res.json()) as Reply).error?.message ?? ''; } catch { /* no body */ }
      throw new Error(`Claude HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
    return (await res.json()) as Reply;
  }

  return {
    name: 'Claude',
    async run({ system, turns, tools, execute, maxSteps = DEFAULT_MAX_STEPS }: AgentRequest): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      const specs = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      }));
      const messages: Message[] = turns.map((t) => ({
        role: t.role === 'assistant' ? 'assistant' : 'user',
        content: t.text
      }));

      for (let step = 0; step < maxSteps; step++) {
        const reply = await call(system, messages, specs, deadline);
        const blocks = reply.content ?? [];
        const toolUses = blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
        if (!toolUses.length) {
          const text = blocks.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n').trim();
          if (!text || reply.stop_reason === 'max_tokens') throw new Error('Claude did not finish its answer.');
          return text;
        }
        messages.push({ role: 'assistant', content: blocks });
        const results: ContentBlock[] = [];
        for (const use of toolUses) {
          const result = await execute({ name: use.name, args: use.input ?? {} });
          results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify({ result }) });
        }
        messages.push({ role: 'user', content: results });
      }
      throw new Error(`Claude did not finish within ${maxSteps} steps`);
    }
  };
}

/** Null unless the Claude provider is selected and ANTHROPIC_API_KEY is set. */
export function createClaudeAgentFromConfig(config: Config): AgentModel | null {
  if (config.provider !== 'claude' || !config.claude.apiKey) return null;
  return createClaudeAgent({
    ...config.claude,
    timeoutMs: config.claude.agentTimeoutMs,
    requestTimeoutMs: config.claude.timeoutMs
  });
}
