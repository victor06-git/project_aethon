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

import type { AgreedPlan, BasketTotal, CashLine, GoalDraft, GoalScenario, GapFix, MathStep, NextStep, PlanChoice, Source, TraceStep } from './trainer';

export interface Account {
  id: string;
  name: string;
  iban: string;
  balance: number;
  kind: string;
  bank?: string;         // set for accounts at other banks (PSD2)
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

export interface ChatTurn { role: 'user' | 'assistant'; text: string }

export type AnswerType = Intent | 'cashflow' | 'brief' | 'scenario' | 'plan' | 'research' | 'chat';

// The answer contract (docs/API.md). The trainer adds the optional cards below.
export interface Answer {
  type: AnswerType;
  text: string;
  planner?: ChatPlanner;          // inline car planner (down-payment slider, monthly bars)
  steps?: MathStep[];            // safe-to-spend math
  baskets?: BasketTotal[];       // the three baskets with their lines
  review?: CashLine[];           // assumptions the user may want to correct
  goal?: GoalDraft;
  scenarios?: GoalScenario[];    // comparison cards
  sources?: Source[];            // web citations
  plan?: AgreedPlan;
  choices?: PlanChoice[];         // ways to respond when the plan has room or is short
  nextStep?: NextStep;           // a prepared next step
  fixes?: GapFix[];              // ways to close the monthly gap
  trace?: TraceStep[];           // what the trainer did to get here
  followUps?: string[];
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

// Market (Invest tab): instruments and their price history.
export interface Instrument {
  id: string;
  ticker: string;
  name: string;
  kind: 'stock' | 'etf';
  exchange: string;
  sector: string;
  color: string;          // tile colour for the logo square
}

export interface PricePoint { date: string; close: number }

/** Car affordability planner shown in the chat after the guided car questions. The slider
 *  recalculates in the browser; the figures are the same loan formula as the trainer's. */
export interface ChatPlanner {
  kind: 'car_helsinki';
  price: number;
  months: number;
  rateAnnual: number;
  parkingMonth: number;
  insuranceMonth: number;
  leftoverMonth: number;
  downPayment: number;
  zoneLabel?: string;
}
