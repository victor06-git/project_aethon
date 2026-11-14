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
}

export interface SafeToSpend { amount: number; until: string }

export interface HttpError { status: number; message: string }
export const httpError = (status: number, message: string): HttpError => ({ status, message });
