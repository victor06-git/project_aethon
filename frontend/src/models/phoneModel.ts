// Model: everything one phone knows, and the only code that talks to the API.
// React components subscribe through the hooks in ./hooks.ts.
import { request, requestStream } from '@transport';
import type { Answer, ChatTurn } from '../../../backend/src/domain/types';
import type { Cashflow, TraceStep, TrainerReply, TrainerState } from '../../../backend/src/domain/trainer';

export type Loaded<T> = T | { __error: string } | undefined;
export const isError = (d: unknown): d is { __error: string } => !!d && typeof d === 'object' && '__error' in d;

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'bot'; pending: true; steps: TraceStep[] }
  | { role: 'bot'; answer: Answer }
  | { role: 'bot'; error: string; retry: () => void };

export interface CityState { days: number; compare: string; anim: number[][] | null }
export type CashflowView = Cashflow & { disclaimer: string };

// The trainer state (corrections, goal in progress, agreed plan) lives in this browser and
// travels with each request: the API keeps nothing between calls.
const STORE_KEY = 'revi-trainer-v1';
const EMPTY: TrainerState = { corrections: [], draft: null, plan: null, multiBank: false };

function loadTrainer(): TrainerState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    return EMPTY;   // storage blocked or unreadable: start fresh
  }
}

const LARGE_KEY = 'revi-large-text';
function loadLarge(): boolean {
  try { return localStorage.getItem(LARGE_KEY) === '1'; } catch { return false; }
}

function saveTrainer(state: TrainerState) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage may be blocked */ }
}

export class PhoneModel {
  private cache = new Map<string, unknown>();
  private pending = new Set<string>();
  private listeners = new Set<() => void>();
  private flow: Loaded<CashflowView>;
  private flowState: TrainerState | null = null;   // the trainer state `flow` was computed for
  private flowLoading = false;
  chat: ChatMessage[] = [];
  city: CityState = { days: 0, compare: '', anim: null };
  trainer: TrainerState = loadTrainer();
  large = loadLarge();     // larger text, for people who find the default small
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

  toggleLarge() {
    this.large = !this.large;
    try { localStorage.setItem(LARGE_KEY, this.large ? '1' : '0'); } catch { /* storage may be blocked */ }
    this.emit();
  }

  // ---- Trainer ----

  private setTrainer(state: TrainerState) { this.trainer = state; saveTrainer(state); }

  /** A change made on this device only (for example dropping the goal in progress). */
  patchTrainer(patch: Partial<TrainerState>) { this.setTrainer({ ...this.trainer, ...patch }); this.emit(); }

  // The three baskets, safe-to-spend and safe-to-save for the current trainer state.
  // While new figures load after a change, the previous ones stay on screen.
  cashflow(): Loaded<CashflowView> {
    if (this.flowState !== this.trainer && !this.flowLoading) {
      const state = this.trainer;
      this.flowLoading = true;
      request<CashflowView>('POST', '/api/trainer/cashflow', { state })
        .then((flow) => { this.flow = flow; this.flowState = state; })
        .catch((e: Error & { status?: number }) => {
          // A stored state the server no longer accepts (after an update) is dropped once.
          if (e.status === 400 && state !== EMPTY) { this.setTrainer(EMPTY); return; }
          this.flow = { __error: e.message };
          this.flowState = state;
        })
        .finally(() => { this.flowLoading = false; this.emit(); });
    }
    return this.flow;
  }

  get busy(): boolean {
    const last = this.chat[this.chat.length - 1];
    return !!last && 'pending' in last;
  }

  // What the trainer needs of the conversation so far: questions and its own answers.
  private turns(): ChatTurn[] {
    return this.chat.flatMap((m): ChatTurn[] => {
      if (m.role === 'user') return [{ role: 'user', text: m.text }];
      return 'answer' in m ? [{ role: 'assistant', text: m.answer.text }] : [];
    });
  }

  /** A question in the user's own words. The answer contract is described in docs/API.md. */
  ask(question: string): Promise<void> {
    const messages: ChatTurn[] = [...this.turns(), { role: 'user', text: question }];
    return this.exchange(question, (onStep) => this.stream('/api/trainer/chat', { messages, state: this.trainer }, onStep), () => { void this.ask(question); });
  }

  /** A button in the chat: runs one trainer tool and shows what the user "said". */
  act(said: string, name: string, args: Record<string, unknown> = {}): Promise<void> {
    return this.exchange(said, (onStep) => this.stream('/api/trainer/action', { action: { name, args }, state: this.trainer }, onStep), () => { void this.act(said, name, args); });
  }

  /** A control outside the chat (toggle, slider, select): runs one tool and returns its answer. */
  async apply(name: string, args: Record<string, unknown> = {}): Promise<Answer> {
    const reply = await this.runTool(name, args);
    this.setTrainer(reply.state);
    this.emit();
    return reply.answer;
  }

  /** Removes a failed exchange from the chat and sends it again. */
  retry(message: ChatMessage) {
    if (!('error' in message)) return;
    const at = this.chat.indexOf(message);
    this.chat = this.chat.filter((_, i) => i !== at && i !== at - 1);
    message.retry();
  }

  private runTool(name: string, args: Record<string, unknown>): Promise<TrainerReply> {
    return this.post<TrainerReply>('/api/trainer/action', { action: { name, args }, state: this.trainer });
  }

  // A request whose steps arrive while it runs, so the chat can show what is happening.
  private stream(path: string, body: unknown, onStep: (step: TraceStep) => void): Promise<TrainerReply> {
    return requestStream<TrainerReply>('POST', path, body, (event) => onStep(event.step as TraceStep));
  }

  // Shows a step in the waiting message: a new one is added, a known one is updated (running → done).
  private showStep(step: TraceStep) {
    const last = this.chat[this.chat.length - 1];
    if (!last || !('pending' in last)) return;
    const steps = last.steps.some((s) => s.id === step.id) ? last.steps.map((s) => (s.id === step.id ? step : s)) : [...last.steps, step];
    this.chat = [...this.chat.slice(0, -1), { ...last, steps }];
    this.emit();
  }

  private async exchange(said: string, send: (onStep: (step: TraceStep) => void) => Promise<TrainerReply>, retry: () => void) {
    if (this.busy) return;
    this.chat = [...this.chat, { role: 'user', text: said }, { role: 'bot', pending: true, steps: [] }];
    this.emit();
    let reply: ChatMessage;
    try {
      const { answer, state } = await send((step) => this.showStep(step));
      this.setTrainer(state);
      reply = { role: 'bot', answer };
    } catch (err) {
      reply = { role: 'bot', error: (err as Error).message, retry };
    }
    this.chat = [...this.chat.slice(0, -1), reply];
    this.emit();
  }
}
