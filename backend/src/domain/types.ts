// Shared types: the vocabulary every layer and the frontend agree on.

export interface Transaction {
  id: string;
  date: string;          // ISO date, YYYY-MM-DD
  merchant: string;      // display label
  category: string;      // display category
  coachKey: string;      // taxi, food_delivery, leisure, groceries, housing, ...
  amount: number;        // negative = money out
  balanceAfter?: number;
  mcc?: string | null;
  type?: string;
  account?: string;
  merchantId?: string | null;
}

export interface Account {
  id: string;
  name: string;
  iban: string;
  balance: number;
  kind: string;
}

export type Intent = 'fact' | 'forecast' | 'action' | 'clarify';

export interface Route {
  intent: Intent;
  id?: string | null;
}

export interface Suggestion {
  id: string;
  intent: Intent;
  text: string;
  short?: string;
  note?: string;
}

export type CityKey = 'mandatory' | 'unexpected' | 'small' | 'cushion' | 'debt';
export type CityValues = Record<CityKey, number>;

export interface Scenario {
  id: string;
  title: string;
  headline: string;
  range: string;
  confidence: string;
  horizonMonths: number;
  summary: string;
  events: { day: number; label: string }[];
  city: { start: CityValues; later: CityValues };
}

export interface CityPoint {
  id: string;
  day: number;
  values: CityValues;
  confidence: number;    // 1 today, falling with distance
}

export interface Letter { subject: string; body: string }

/** A web source behind one answer (Kaiku coach): numbered as cited, official-first. */
export interface AnswerSource {
  k: number;             // citation number as it appears in the text: [1], [2]...
  official: boolean;     // from the official-domain list (Kela, Vero, Finlex, Bank of Finland...)
  domain: string;
  title: string;
  url: string;
  published?: string | null;
  fragment?: string;     // the quoted piece of the page that backs the claim
}

/** How the answer was produced (shown under "Sources" for the curious and the judges). */
export interface AnswerTrace {
  route: string;         // static | web | data | both | clarify, "(document)" for letters
  decidedBy: string;     // model | guardrail (...) | fallback (...)
  llmCalls: number;
  tokens: number;
  thinkingTokens?: number;
  seconds: number;
  exaCost?: number;
  cached?: boolean;
  query?: string | null;
  thinkingLevel?: string | null;
  problems?: string[];   // automatic checks that failed (empty = all good)
}

// The coach answer contract (docs/API.md).
export interface Answer {
  type: Intent;
  text: string;
  figure?: string;
  range?: string;
  confidence?: string;
  scenarioId?: string;
  rows?: { label: string; amount: number }[];
  letter?: Letter;
  examples?: string[];
  source?: 'model' | 'rules';
  // Optional extras from the Kaiku coach service (see src/project_aethon/kaiku_service.py).
  sources?: AnswerSource[];
  dataUsed?: { period: string; transactions: number; note?: string };
  trace?: AnswerTrace;
  noEvidence?: boolean;
}

export interface SafeToSpend { amount: number; until: string }

export interface HttpError { status: number; message: string }
export const httpError = (status: number, message: string): HttpError => ({ status, message });
