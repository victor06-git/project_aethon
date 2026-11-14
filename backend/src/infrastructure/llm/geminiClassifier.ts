// Adapter to the Gemini API (generateContent). The key is sent in a header,
// not in the URL, so it does not end up in access logs.
import { SYSTEM_PROMPT } from './prompt';
import type { Route } from '../../domain/types';
import type { QuestionClassifier } from '../../application/ports';
import { createGeminiRequests } from './geminiRequests';

export interface GeminiOptions { apiKey: string; model: string; fallbackModel?: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }

export function createGeminiClassifier({ apiKey, model, fallbackModel, baseUrl = 'https://generativelanguage.googleapis.com', timeoutMs = 8000, fetchImpl = globalThis.fetch }: GeminiOptions): QuestionClassifier {
  const base = baseUrl.replace(/\/$/, '');
  const { startTurn } = createGeminiRequests({ model, fallbackModel, timeoutMs });
  return {
    async classify(question: string): Promise<Route> {
      return startTurn()(async (modelId, signal) => {
        const res = await fetchImpl(`${base}/v1beta/models/${encodeURIComponent(modelId)}:generateContent`, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: question }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              maxOutputTokens: 512,
              ...(modelId.startsWith('gemini-3.') || modelId.startsWith('gemini-4-')
                ? { thinkingConfig: { thinkingLevel: modelId === 'gemini-3.5-flash-lite' ? 'MINIMAL' : 'LOW' } }
                : { temperature: 0 })
            }
          })
        });
        if (!res.ok) throw Object.assign(new Error('Gemini request failed'), { status: res.status });
        const body = await res.json();
        const parts = body.candidates?.[0]?.content?.parts as Array<{ thought?: boolean; text?: string }> | undefined;
        const parsed = JSON.parse(parts?.filter((part) => !part.thought && typeof part.text === 'string').map((part) => part.text).join('') || '{}');
        return { intent: parsed.intent, id: parsed.id ?? null };
      });
    }
  };
}
