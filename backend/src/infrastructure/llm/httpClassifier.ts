// Adapter for an OpenAI-compatible chat endpoint (e.g. a self-hosted Gemma, or a Python service
// from src/project_aethon exposed over HTTP).
import { SYSTEM_PROMPT } from './prompt';
import type { Route } from '../../domain/types';
import type { QuestionClassifier } from '../../application/ports';

export interface HttpOptions { url: string; key?: string; model: string; timeoutMs?: number; fetchImpl?: typeof fetch }

export function createHttpClassifier({ url, key, model, timeoutMs = 8000, fetchImpl = globalThis.fetch }: HttpOptions): QuestionClassifier {
  return {
    async classify(question: string): Promise<Route> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({
            model, temperature: 0, response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: question }]
          })
        });
        if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
        const body = await res.json();
        const parsed = JSON.parse(body.choices[0].message.content);
        return { intent: parsed.intent, id: parsed.id ?? null };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
