// Shapes returned by /api/market (see backend/src/application/marketService.ts).
import type { Instrument, PricePoint } from '../../../../../backend/src/domain/types';

export type { PricePoint };

export interface InstrumentSummary extends Instrument {
  price: number; changePct1d: number; changePct1m: number; spark: number[]; shares?: number; value?: number;
}

export interface MarketOverview {
  asOf: string; source: string;
  portfolio: { value: number; change1d: number; changePct1d: number; returnPct1y: number };
  holdings: InstrumentSummary[];
  explore: InstrumentSummary[];
}

export interface InstrumentDetail {
  instrument: Instrument; source: string; range: string;
  price: number; change: number; changePct: number; history: PricePoint[];
  stats: { high52: number; low52: number; return1y: number; volatility: number };
  position: { shares: number; value: number } | null;
}

export const RANGES = ['1W', '1M', '3M', '6M', '1Y'] as const;
