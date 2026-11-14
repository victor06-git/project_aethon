// Model: everything one phone knows, and the only code that talks to the API.
// React components subscribe through the hooks in ./hooks.ts.
import { request } from '@transport';
import type { Answer, Suggestion } from '../../../backend/src/domain/types';

export type Loaded<T> = T | { __error: string } | undefined;
export const isError = (d: unknown): d is { __error: string } => !!d && typeof d === 'object' && '__error' in d;

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'bot'; pending: true }
  | { role: 'bot'; answer: Answer };

export interface CityState { days: number; compare: string; anim: number[][] | null }

export class PhoneModel {
  private cache = new Map<string, unknown>();
  private pending = new Set<string>();
  private listeners = new Set<() => void>();
  chat: ChatMessage[] = [];
  city: CityState = { days: 0, compare: '', anim: null };
  version = 0;

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.version;
  private emit() { this.version++; this.listeners.forEach((fn) => fn()); }

  // Cached GET. Returns undefined while loading and notifies when the data arrives.
  data<T>(path: string): Loaded<T> {
    if (this.cache.has(path)) return this.cache.get(path) as T;
    if (!this.pending.has(path)) {
      this.pending.add(path);
      request<T>('GET', path)
        .then((d) => { this.cache.set(path, d); })
        .catch((e: Error) => { this.cache.set(path, { __error: e.message }); })
        .finally(() => { this.pending.delete(path); this.emit(); });
    }
    return undefined;
  }

  // Uncached GET for values that change with the UI (the City timeline).
  fetch<T>(path: string): Promise<T> { return request<T>('GET', path); }
  post<T>(path: string, body: unknown): Promise<T> { return request<T>('POST', path, body); }

  suggestions(): Suggestion[] | null {
    const boot = this.data<{ suggestions: Suggestion[] }>('/api/bootstrap');
    return boot && !isError(boot) ? boot.suggestions : null;
  }

  // Coach conversation. The answer contract is described in docs/API.md.
  async ask(question: string) {
    this.chat = [...this.chat, { role: 'user', text: question }, { role: 'bot', pending: true }];
    this.emit();
    let answer: Answer;
    try {
      answer = await this.post<Answer>('/api/coach/messages', { question });
    } catch (err) {
      answer = { type: 'clarify', text: (err as Error).message, examples: [] };
    }
    this.chat = [...this.chat.slice(0, -1), { role: 'bot', answer }];
    this.emit();
  }
}
