// HTTP-agnostic router (the controllers). Maps routes to use cases; no business logic.
// The same router serves the Node server and the standalone build. API contract: docs/API.md.
import { httpError } from '../../domain/types';
import type { BankService } from '../../application/bankService';
import type { CoachService } from '../../application/coachService';
import type { TrainerService } from '../../application/trainerService';

type Query = Record<string, string>;
type Handler = (params: Record<string, string>, query: Query, body: any) => unknown;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler }

function compile(method: string, pattern: string, handler: Handler): Route {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { method, re, keys, handler };
}

export function createRouter({ bank, coach, trainer }: { bank: BankService; coach: CoachService; trainer: TrainerService }) {
  const routes: Route[] = [
    // Personal Economic Trainer. The client keeps the trainer state and sends it with each request.
    compile('GET', '/api/trainer/status', () => trainer.status()),
    compile('GET', '/api/trainer/cashflow', () => trainer.cashflow(undefined)),
    compile('POST', '/api/trainer/cashflow', (p, q, body) => trainer.cashflow(body)),
    compile('POST', '/api/trainer/chat', (p, q, body) => trainer.chat(body)),
    compile('POST', '/api/trainer/action', (p, q, body) => trainer.action(body)),
    // Banking
    compile('GET', '/api/bootstrap', () => ({ bank: bank.bank(), profile: bank.profile(), data: bank.dataSource(), suggestions: coach.suggestions(), safeToSpend: coach.safeToSpend() })),
    compile('GET', '/api/home', () => bank.home()),
    compile('GET', '/api/accounts', () => bank.accounts()),
    compile('GET', '/api/accounts/:id', (p) => bank.account(p.id)),
    compile('GET', '/api/transactions', (p, q) => bank.transactions(q.limit)),
    compile('GET', '/api/cards', () => bank.cards()),
    compile('GET', '/api/loans', () => bank.loans()),
    compile('GET', '/api/loans/mortgage', () => bank.mortgage()),
    compile('GET', '/api/investments', () => bank.investments()),
    compile('GET', '/api/purchases', () => bank.purchases()),
    compile('GET', '/api/receipts', () => bank.receipts()),
    compile('GET', '/api/receipts/:id', (p) => bank.receipt(p.id)),
    compile('GET', '/api/offers', () => bank.offers()),
    compile('GET', '/api/stores', () => bank.stores()),
    compile('GET', '/api/bonus', () => bank.bonus()),
    compile('GET', '/api/payments/upcoming', () => bank.upcoming()),
    compile('GET', '/api/payments/recurring', () => bank.recurring()),
    compile('GET', '/api/messages', () => bank.messages()),
    compile('GET', '/api/profile', () => bank.profile()),
    compile('POST', '/api/payments', (p, q, body) => bank.createPayment(body)),
    compile('POST', '/api/transfers', () => bank.createTransfer()),
    compile('POST', '/api/letters/send', () => ({ status: 'not_sent', note: 'Demo only: nothing was sent. You decide when to send.' })),
    // Coach (Revi)
    compile('GET', '/api/coach/suggestions', () => coach.suggestions()),
    compile('GET', '/api/coach/expenses', () => coach.expenses()),
    compile('GET', '/api/coach/scenarios', () => coach.listScenarios()),
    compile('GET', '/api/coach/scenarios/:id', (p) => coach.getScenario(p.id)),
    compile('GET', '/api/coach/scenarios/:id/at', (p, q) => coach.valuesAt(p.id, Number(q.day) || 0)),
    compile('POST', '/api/coach/messages', (p, q, body) => coach.ask(body?.question))
  ];

  return {
    async handle(method: string, path: string, body?: unknown, query: Query = {}): Promise<any> {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = path.match(r.re);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return r.handler(params, query, body);
      }
      throw httpError(404, 'Not found');
    }
  };
}
