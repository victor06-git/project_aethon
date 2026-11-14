// Adapter to the Gemini API (generateContent). The key is sent in a header,
// not in the URL, so it does not end up in access logs.
import { SYSTEM_PROMPT } from './prompt';
import type { Route } from '../../domain/types';
import type { QuestionClassifier } from '../../application/ports';

export interface GeminiOptions { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }

export function createGeminiClassifier({ apiKey, model, baseUrl = 'https://generativelanguage.googleapis.com', timeoutMs = 8000, fetchImpl = globalThis.fetch }: GeminiOptions): QuestionClassifier {
  const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return {
    async classify(question: string): Promise<Route> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: question }] }],
            generationConfig: { responseMimeType: 'application/json', ...(model.startsWith('gemini-3.') ? { thinkingConfig: { thinkingLevel: 'LOW' } } : { temperature: 0 }) }
          })
        });
        if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
        const body = await res.json();
        const parts = body.candidates?.[0]?.content?.parts as Array<{ thought?: boolean; text?: string }> | undefined;
        const parsed = JSON.parse(parts?.filter((part) => !part.thought && typeof part.text === 'string').map((part) => part.text).join('') || '{}');
        return { intent: parsed.intent, id: parsed.id ?? null };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
