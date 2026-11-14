// Ports: the contracts between the application layer and everything outside it.
// Infrastructure implements them; the application only calls these methods.
// Swap an implementation in container.ts without touching services, router or UI.
import type { Account, CityPoint, Letter, Route, SafeToSpend, Scenario, Suggestion, Transaction } from '../domain/types';

/** The user's own money data. Adapters: fixtureTransactions (demo), csvTransactions (S-Pankki dataset). */
export interface TransactionRepository {
  source: string;
  customerId?: string;
  asOf(): string;                 // "today" for this data set (last transaction date)
  accounts(): Account[];
  invested(): number;             // money moved into investments
  list(): Transaction[];          // newest first
}

/** Turns a free-form question into a route. Never returns numbers.
 *  Adapters: infrastructure/llm (model, OWNED BY THE MODEL TEAMMATE), classifiers/rulesClassifier (fallback). */
export interface QuestionClassifier {
  classify(question: string): Promise<Route> | Route;
}

/** The echo engine: computes every figure. Adapter today: engine/scenarioEngine (hand-set scenarios). */
export interface ForecastEngine {
  listScenarios(): Scenario[];
  getScenario(id: string): Scenario;
  valuesAt(id: string, day: number): CityPoint;
  suggestions(): Suggestion[];    // the three predefined questions
  safeToSpend(): SafeToSpend;
  rule(id: string): { text: string; letter?: Letter } | null;
  expenses(): Expenses;
}

export interface Expenses {
  mandatory: { name: string; amount: number; changePct?: number }[];
  priority: { name: string; amount: number; changePct?: number }[];
  flexible: { name: string; amount: number; changePct?: number }[];
}

/** Bank products and content that are not transactions. Adapter: repositories/fixtureCatalog. */
export interface Catalog {
  bank(): { name: string; shortName: string; rewardsName: string; currency: string };
  profile(): { firstName: string; fullName: string; email: string; phone: string; membership: string };
  cards(): any;
  loans(): { loans: { id: string; name: string; rate: number; payment: number; balance: number; nextDate: string; endYear: number }[] };
  investments(): { value: number; returnPct: number; funds: { id: string; name: string; value: number }[]; series: number[] };
  purchases(): any;
  receipts(): { id: string; store: string; date: string; total: number; lines: { name: string; amount: number }[] }[];
  offers(): any;
  stores(): any;
  bonus(): { earned: number; progress: number; nextTierGap: number; month: string; tierPct: number };
  upcoming(): { name: string; date: string; amount: number }[];
  recurring(): any;
  messages(): any;
}

const PORTS = {
  TransactionRepository: ['asOf', 'accounts', 'invested', 'list'],
  QuestionClassifier: ['classify'],
  ForecastEngine: ['listScenarios', 'getScenario', 'valuesAt', 'suggestions', 'safeToSpend', 'rule', 'expenses']
} as const;

/** Fails fast at start-up if an adapter does not implement its port (useful for plain-JS or Python-backed adapters). */
export function assertPort<T>(name: keyof typeof PORTS, impl: T): T {
  const missing = PORTS[name].filter((m) => !impl || typeof (impl as Record<string, unknown>)[m] !== 'function');
  if (missing.length) throw new Error(`${name} is missing: ${missing.join(', ')}`);
  return impl;
}
