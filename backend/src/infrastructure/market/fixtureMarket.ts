// Demo market data: two years of daily closes per instrument, generated from a seeded random walk
// (geometric Brownian motion with a slow cycle). Deterministic, so every run shows the same charts.
// These are NOT real prices. Swap this adapter for a real price feed in container.ts.
import type { Instrument, PricePoint } from '../../domain/types';
import type { MarketData } from '../../application/ports';

interface Spec extends Instrument { start: number; drift: number; vol: number; seed: number }

// drift and vol are yearly; start is the price two years before "today".
const SPECS: Spec[] = [
  { id: 'nokia', ticker: 'NOKIA', name: 'Nokia', kind: 'stock', exchange: 'Helsinki', sector: 'Telecom equipment', color: '#124191', start: 3.6, drift: 0.12, vol: 0.28, seed: 11 },
  { id: 'kone', ticker: 'KNEBV', name: 'Kone', kind: 'stock', exchange: 'Helsinki', sector: 'Industrials', color: '#1450f5', start: 44, drift: 0.07, vol: 0.2, seed: 12 },
  { id: 'sp500', ticker: 'SXR8', name: 'S&P 500 ETF', kind: 'etf', exchange: 'Xetra', sector: 'US large companies', color: '#1f2a37', start: 470, drift: 0.09, vol: 0.16, seed: 13 },
  { id: 'apple', ticker: 'AAPL', name: 'Apple', kind: 'stock', exchange: 'Nasdaq', sector: 'Technology', color: '#3a3a3c', start: 170, drift: 0.1, vol: 0.26, seed: 14 },
  { id: 'neste', ticker: 'NESTE', name: 'Neste', kind: 'stock', exchange: 'Helsinki', sector: 'Energy', color: '#0a8f5a', start: 22, drift: -0.25, vol: 0.38, seed: 15 },
  { id: 'nordea', ticker: 'NDA FI', name: 'Nordea', kind: 'stock', exchange: 'Helsinki', sector: 'Banking', color: '#0000a0', start: 10.5, drift: 0.1, vol: 0.22, seed: 16 },
  { id: 'microsoft', ticker: 'MSFT', name: 'Microsoft', kind: 'stock', exchange: 'Nasdaq', sector: 'Technology', color: '#5e5e5e', start: 340, drift: 0.11, vol: 0.24, seed: 17 },
  { id: 'nvidia', ticker: 'NVDA', name: 'Nvidia', kind: 'stock', exchange: 'Nasdaq', sector: 'Semiconductors', color: '#5d8f00', start: 45, drift: 0.45, vol: 0.5, seed: 18 }
];

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand: () => number) {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Trading days (Mon to Fri) from two years before `asOf` up to `asOf`. */
function tradingDays(asOf: string, years: number): string[] {
  const end = new Date(`${asOf}T00:00:00Z`);
  const d = new Date(end); d.setUTCFullYear(d.getUTCFullYear() - years);
  const out: string[] = [];
  while (d <= end) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(iso(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function createFixtureMarket(asOf: string): MarketData {
  const days = tradingDays(asOf, 2);
  const cache = new Map<string, PricePoint[]>();
  const generate = (s: Spec): PricePoint[] => {
    const rand = mulberry32(s.seed);
    const dt = 1 / 252;
    let p = s.start;
    return days.map((date, i) => {
      if (i > 0) {
        const cycle = 0.35 * Math.sin((i / 252) * 2 * Math.PI + s.seed) * dt; // slow market mood
        p *= Math.exp((s.drift - 0.5 * s.vol ** 2) * dt + cycle + s.vol * Math.sqrt(dt) * gauss(rand));
      }
      return { date, close: Math.round(p * 100) / 100 };
    });
  };
  return {
    source: 'Demo prices (generated, not market data)',
    asOf: () => days[days.length - 1],
    instruments: () => SPECS.map(({ start, drift, vol, seed, ...inst }) => inst),
    history(id) {
      const spec = SPECS.find((s) => s.id === id);
      if (!spec) return [];
      if (!cache.has(id)) cache.set(id, generate(spec));
      return cache.get(id)!;
    }
  };
}
