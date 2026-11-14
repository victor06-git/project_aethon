// Personal Economic Trainer vocabulary: shared by every layer and the frontend. Pure, no I/O.
import type { Answer } from './types';

// ---- Cash flow ----

export type Basket = 'regular' | 'irregular' | 'everyday';
export type LineBasket = Basket | 'oneoff';
/** How a line got its basket: seen every month, guessed, averaged, or set by the user. */
export type LineBasis = 'recurring' | 'assumed' | 'average' | 'corrected';

/** One payee (or merchant type) the user pays, with what it costs per month. */
export interface CashLine {
  id: string;
  label: string;
  category: string;
  basket: LineBasket;
  basis: LineBasis;
  monthly: number;       // 0 for a one-off
  total: number;         // paid in the analysed period
  count: number;
  lastDate: string;
  lastAmount: number;
}

export interface BasketTotal { basket: Basket; label: string; hint: string; monthly: number; lines: CashLine[] }
export interface MathStep { label: string; amount: number; kind: 'start' | 'minus' | 'equals' }
export interface WeeklySafe { week: number; perDay: number; days: number; until: string; steps: MathStep[] }

export interface Cashflow {
  asOf: string;
  periodDays: number;        // how much history the averages use
  income: number;            // per month
  baskets: BasketTotal[];    // the three baskets: regular, irregular, everyday
  oneOffs: CashLine[];
  free: number;              // income minus the three baskets: what is left each month
  safeToSave: number;        // `free` minus what an agreed plan already takes, never negative
  safe: WeeklySafe;
}

/** The user's correction of an assumption: "this line belongs there". */
export interface Correction { lineId: string; as: LineBasket }

// ---- Goals and scenarios ----

export type GoalKind = 'car' | 'purchase';
export type FigureSource = 'assumption' | 'research' | 'user';
export type BenchmarkUnit = 'eur' | 'eur_per_month' | 'eur_per_year' | 'percent';

export interface CostItem { id: string; label: string; monthly: number; source: FigureSource; url?: string }
export interface SpendingCut { group: string; pct: number }      // group: a key of CUT_GROUPS
export interface LoanTerms { years: number; ratePct: number }
export interface Source { title: string; url: string; published: string; snippet: string }

/** What the web says about one cost. `value` is set only when a quoted figure was verified in a source. */
export interface Benchmark {
  topic: string;
  label: string;
  sources: Source[];
  value?: number;
  unit?: BenchmarkUnit;
  quote?: string;
  url?: string;
}

/** A concrete option found on the web for the goal, with where it was found. */
export interface GoalOption { name: string; price: number; url: string }

/** A structured answer from web research: the fields found, and which sources back each field. */
export interface Extraction {
  content: Record<string, unknown>;
  grounding: { field: string; urls: string[]; confidence: 'low' | 'medium' | 'high' }[];
  sources: Source[];
}

export interface GoalDraft {
  kind: GoalKind;
  name: string;
  price: number;
  priceSource: FigureSource;
  months: number;              // time until the purchase
  running: CostItem[];         // monthly costs after the purchase
  cuts: SpendingCut[];
  loan: LoanTerms | null;
  benchmarks: Benchmark[];
  options: GoalOption[];       // current options found by research
  confirmed: boolean;          // the user confirmed the brief; nothing is simulated before that
  note: string;                // the user's circumstances and priorities, in their words
}

export interface GoalScenario {
  id: string;
  label: string;
  months: number;
  readyDate: string;
  upfront: number;             // what must be on the table on the day of the purchase
  monthlyNeeded: number;       // to save each month until the purchase
  monthlyCapacity: number;     // what the user frees up each month
  gap: number;                 // monthly shortfall while saving, 0 if it fits
  afterMonthly: number;        // running costs plus loan payment after the purchase
  afterFree: number;           // what is left each month after the purchase
  feasible: boolean;
  loan?: LoanTerms & { amount: number; payment: number };
  notes: string[];
}

// ---- Agreed plan ----

export type PlanStatus = 'on_track' | 'at_risk' | 'off_track';
export interface PlanCheck { checkedOn: string; status: PlanStatus; changes: string[] }

/** What the user approved the trainer to keep an eye on. */
export interface Monitoring { prices: boolean; conditions: boolean; spending: boolean }

export interface AgreedPlan {
  goal: GoalDraft;
  agreedOn: string;
  targetDate: string;
  monthlySaving: number;
  bufferMonthly: number;       // extra set aside each month for a larger buffer
  capacityAtAgreement: number;
  monitor: Monitoring;
  lastCheck: PlanCheck | null;
}

/** A way to respond when something changed: contribute less, get there sooner (or later), or grow the buffer. */
export interface PlanChoice {
  id: 'less' | 'sooner' | 'buffer' | 'later';
  label: string;
  detail: string;
  monthlySaving: number;
  bufferMonthly: number;
  targetDate: string;
}

/** Something concrete the user can do now. `ask` sends a chat message, `screen` opens a bank screen. */
export interface NextStep { title: string; detail: string; ask?: string; screen?: string }

export const NO_MONITORING: Monitoring = { prices: false, conditions: false, spending: false };
export const isMonitoring = (m: Monitoring): boolean => m.prices || m.conditions || m.spending;

/** Everything the trainer remembers. Kept by the client and sent with each request (the API is stateless). */
export interface TrainerState {
  corrections: Correction[];
  draft: GoalDraft | null;
  plan: AgreedPlan | null;
  multiBank: boolean;          // include accounts at other banks (PSD2)
}
export interface TrainerReply { answer: Answer; state: TrainerState }

// ---- Constants ----

export const EMPTY_STATE: TrainerState = { corrections: [], draft: null, plan: null, multiBank: false };

// S-Pankki's three baskets.
export const BASKETS: { basket: Basket; label: string; hint: string }[] = [
  { basket: 'regular', label: 'Mandatory & regular', hint: 'Rent, utilities, loans, subscriptions: the same every month' },
  { basket: 'irregular', label: 'Mandatory & irregular', hint: 'Repairs, insurance, health: averaged per month' },
  { basket: 'everyday', label: 'Everyday spending', hint: 'Slips through your fingers: coffees, lunches, taxis, treats' }
];
export const LINE_BASKETS: LineBasket[] = ['regular', 'irregular', 'everyday', 'oneoff'];

/** Everyday spending the user can decide to cut. Matched against a line's label and category. */
export const CUT_GROUPS: Record<string, { label: string; match: RegExp }> = {
  dining: { label: 'eating out', match: /restaurant|food delivery|fast food|\bbar\b|caf[eé]/i },
  groceries: { label: 'groceries', match: /grocer|food shop|butcher|dairy/i },
  taxi: { label: 'taxis', match: /taxi/i },
  leisure: { label: 'leisure', match: /leisure|cinema|theatre|sport|amusement|attraction/i },
  transport: { label: 'transport', match: /transport|fuel|parking/i },
  shopping: { label: 'shopping', match: /\bshop\b|clothing|electronics|furniture/i },
  everyday: { label: 'all everyday spending', match: /./ }
};

export const LIMITS = { price: 10_000_000, months: 240, monthly: 100_000, loanYears: 15, ratePct: 30 };

export const TRAINER_DISCLAIMER = 'Estimates from your own transactions and the assumptions shown. You decide.';

export const eur = (n: number): string => `€${Math.round(n).toLocaleString('en-GB')}`;

/** "https://www.stat.fi/page" → "stat.fi". */
export const hostOf = (url: string): string => url.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0];
