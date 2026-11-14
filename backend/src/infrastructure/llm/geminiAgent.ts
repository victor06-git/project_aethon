// AgentModel adapter: Gemini function calling through the official SDK (@google/genai).
// Gemini decides which tools to call; the application runs them and hands back the results,
// until Gemini answers in text. Node only: never bundled into the browser.
import { GoogleGenAI, ThinkingLevel, type Content, type FunctionCall, type GenerateContentConfig, type Part } from '@google/genai';
import type { AgentModel, AgentRequest } from '../../application/ports';
import type { Config } from '../../config';
import { createGeminiRequests } from './geminiRequests';

const DEFAULT_MAX_STEPS = 6;
const TEMPERATURE = 0.2;

// The part of the SDK this adapter uses, so tests can pass a scripted client.
interface GeminiReply { functionCalls?: FunctionCall[]; text?: string; candidates?: { content?: Content; finishReason?: string }[] }
export interface GeminiClient {
  models: { generateContent(request: { model: string; contents: Content[]; config: GenerateContentConfig }): Promise<GeminiReply> };
}

export interface GeminiAgentOptions {
  apiKey: string;
  model: string;
  fallbackModel?: string;
  baseUrl?: string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  client?: GeminiClient;
}

export function createGeminiAgent({ apiKey, model, fallbackModel, baseUrl, timeoutMs = 20000, requestTimeoutMs, client }: GeminiAgentOptions): AgentModel {
  const ai: GeminiClient = client ?? new GoogleGenAI({ apiKey, httpOptions: { ...(baseUrl ? { baseUrl } : {}), retryOptions: { attempts: 1 } } });
  const { startTurn } = createGeminiRequests({ model, fallbackModel, timeoutMs, requestTimeoutMs });
  return {
    async run({ system, turns, tools, execute, maxSteps = DEFAULT_MAX_STEPS }: AgentRequest): Promise<string> {
      const request = startTurn();
      const config: GenerateContentConfig = {
        systemInstruction: system,
        maxOutputTokens: 2048,
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }]
      };
      let contents: Content[] = turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] }));

      for (let step = 0; step < maxSteps; step++) {
        const reply = await request((modelId, abortSignal) => ai.models.generateContent({
          model: modelId, contents, config: {
            ...config, abortSignal,
            // Use each Gemini model's supported low-cost thinking setting.
            ...(modelId.startsWith('gemini-3.') || modelId.startsWith('gemini-4-')
              ? { thinkingConfig: { thinkingLevel: modelId === 'gemini-3.5-flash-lite' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW } }
              : { temperature: TEMPERATURE })
          }
        }));
        const calls = reply.functionCalls ?? [];
        if (!calls.length) {
          const text = reply.text?.trim();
          if (!text || reply.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw new Error('Gemini did not finish its answer.');
          return text;
        }
        // Tools run one after another: a later call may depend on what an earlier one changed.
        const results: Part[] = [];
        for (const call of calls) {
          const result = await execute({ name: call.name ?? '', args: call.args ?? {} });
          results.push({ functionResponse: { id: call.id, name: call.name, response: { result } } });
        }
        // The model's own turn goes back unchanged: it carries what Gemini needs to continue.
        const modelTurn: Content = reply.candidates?.[0]?.content ?? { role: 'model', parts: calls.map((functionCall) => ({ functionCall })) };
        contents = [...contents, modelTurn, { role: 'user', parts: results }];
      }
      throw new Error(`Gemini did not finish within ${maxSteps} steps`);
    }
  };
}

/** Null when no Gemini key is configured (or the model is switched off): the trainer then uses its rules. */
export function createAgent(config: Config): AgentModel | null {
  if (config.provider !== 'gemini' || !config.gemini.apiKey) return null;
  return createGeminiAgent({ ...config.gemini, timeoutMs: config.gemini.agentTimeoutMs, requestTimeoutMs: config.gemini.timeoutMs });
}
