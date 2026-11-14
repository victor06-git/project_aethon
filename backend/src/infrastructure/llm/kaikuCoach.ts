// Full-answer client for the Kaiku Python coach (src/project_aethon/kaiku_service.py).
// Unlike the classifiers in this folder, it returns a complete Answer: text, sources with
// OFFICIAL tags and fragments, a letter with references, and a trace of how it was produced.
// Any failure throws; coachService catches it, logs and answers locally, so the app keeps working.
import type { Answer } from '../../domain/types';

export interface KaikuOptions { url: string; timeoutMs?: number; fetchImpl?: typeof fetch }
export interface KaikuCoach { ask(question: string): Promise<Answer> }

export function createKaikuCoach({ url, timeoutMs = 35000, fetchImpl = globalThis.fetch }: KaikuOptions): KaikuCoach {
  const endpoint = url.replace(/\/$/, '') + '/kaiku/messages';
  return {
    async ask(question: string): Promise<Answer> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question })
        });
        const body: any = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.message || `Kaiku HTTP ${res.status}`);
        if (!body?.type || typeof body.text !== 'string') throw new Error('Kaiku: malformed answer');
        return body as Answer;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
