// Ports: the contracts between the application layer and everything outside it.
// Infrastructure implements them; the application only calls these methods.
// Swap an implementation in container.ts without touching services, router or UI.
import type { Account, ChatTurn, CityPoint, Instrument, Letter, PricePoint, Route, SafeToSpend, Scenario, Suggestion, Transaction } from '../domain/types';
import type { Extraction, Source } from '../domain/trainer';

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

/** Accounts at other banks, shared through PSD2. Adapter today: repositories/fixtureExternal (demo). */
export interface ExternalAccounts {
  bank: string;
  accounts(): Account[];
  transactions(asOf: string): Transaction[];
}

/** Web research. Adapter: research/exaResearch (Exa). */
export interface ResearchProvider {
  /** Passages relevant to the query, each with its source. */
  search(query: string): Promise<Source[]>;
  /** The fields described by `properties` (JSON Schema), each with the sources that back it. */
  extract(query: string, properties: Record<string, unknown>): Promise<Extraction>;
}

/** A function the model may call. `parameters` is a JSON Schema object. */
export interface ToolSpec { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }
export interface ToolCall { name: string; args: Record<string, unknown> }

export interface AgentRequest {
  system: string;
  turns: ChatTurn[];
  tools: ToolSpec[];
  execute(call: ToolCall): Promise<unknown>;   // runs a tool, returns what the model should see
  maxSteps?: number;
}

/** A model that answers by calling tools until it can reply in text. Adapters: llm/openaiAgent (ChatGPT), llm/geminiAgent (Gemini). */
export interface AgentModel {
  name?: string;                          // shown in the trace, e.g. "ChatGPT is reading your question"
  run(request: AgentRequest): Promise<string>;
}

/** Price data for the Invest tab. Adapter today: market/fixtureMarket (demo prices, generated). */
export interface MarketData {
  source: string;                         // shown in the UI, so demo data is never mistaken for real
  asOf(): string;
  instruments(): Instrument[];
  history(id: string): PricePoint[];      // daily closes, oldest first, trading days only
}

const PORTS = {
  TransactionRepository: ['asOf', 'accounts', 'invested', 'list'],
  ExternalAccounts: ['accounts', 'transactions'],
  ResearchProvider: ['search', 'extract'],
  AgentModel: ['run'],
  QuestionClassifier: ['classify'],
  ForecastEngine: ['listScenarios', 'getScenario', 'valuesAt', 'suggestions', 'safeToSpend', 'rule', 'expenses'],
  MarketData: ['asOf', 'instruments', 'history']
} as const;

/** Fails fast at start-up if an adapter does not implement its port (useful for plain-JS or Python-backed adapters). */
export function assertPort<T>(name: keyof typeof PORTS, impl: T): T {
  const missing = PORTS[name].filter((m) => !impl || typeof (impl as Record<string, unknown>)[m] !== 'function');
  if (missing.length) throw new Error(`${name} is missing: ${missing.join(', ')}`);
  return impl;
}
