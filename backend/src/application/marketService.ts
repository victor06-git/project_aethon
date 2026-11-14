// Invest tab use cases: portfolio overview and one instrument with its history.
// The portfolio holds exactly what the account history says was invested, split by fixed weights.
import { httpError, type Instrument, type PricePoint } from '../domain/types';
import type { MarketData, TransactionRepository } from './ports';

const RANGE_DAYS: Record<string, number> = { '1W': 7, '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '2Y': 730 };
// Share of the invested money in each holding.
const HOLDINGS: Record<string, number> = { sp500: 0.45, nokia: 0.2, kone: 0.2, apple: 0.15 };

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const since = (h: PricePoint[], days: number) => {
  const end = new Date(`${h[h.length - 1].date}T00:00:00Z`); end.setUTCDate(end.getUTCDate() - days);
  const cut = end.toISOString().slice(0, 10);
  return h.filter((p) => p.date >= cut);
};
const pct = (now: number, then: number) => (then ? round(((now - then) / then) * 100) : 0);

export function createMarketService({ market, transactions }: { market: MarketData; transactions: TransactionRepository }) {
  const find = (id: string): Instrument => {
    const inst = market.instruments().find((i) => i.id === id);
    if (!inst) throw httpError(404, 'Unknown instrument');
    return inst;
  };

  // Shares bought one year ago so that today's value equals what the user has invested.
  const shares = () => {
    const invested = transactions.invested();
    const out: Record<string, number> = {};
    for (const [id, w] of Object.entries(HOLDINGS)) {
      const h = market.history(id);
      out[id] = (invested * w) / h[h.length - 1].close;
    }
    return out;
  };

  const portfolioHistory = (): PricePoint[] => {
    const sh = shares();
    const ids = Object.keys(sh);
    const base = market.history(ids[0]);
    return base.map((p, i) => ({ date: p.date, close: round(ids.reduce((s, id) => s + sh[id] * market.history(id)[i].close, 0)) }));
  };

  const historyOf = (id: string) => (id === 'portfolio' ? portfolioHistory() : market.history(find(id).id));

  const summary = (inst: Instrument, held?: number) => {
    const h = market.history(inst.id);
    const last = h[h.length - 1].close, prev = h[h.length - 2].close;
    return {
      ...inst,
      price: last,
      changePct1d: pct(last, prev),
      changePct1m: pct(last, since(h, 30)[0].close),
      spark: since(h, 30).map((p) => p.close),
      ...(held ? { shares: round(held, 4), value: round(held * last) } : {})
    };
  };

  return {
    overview() {
      const sh = shares();
      const ph = portfolioHistory();
      const last = ph[ph.length - 1].close, prev = ph[ph.length - 2].close;
      const all = market.instruments();
      return {
        asOf: market.asOf(),
        source: market.source,
        portfolio: { value: last, change1d: round(last - prev), changePct1d: pct(last, prev), returnPct1y: pct(last, since(ph, 365)[0].close) },
        holdings: all.filter((i) => sh[i.id]).map((i) => summary(i, sh[i.id])),
        explore: all.filter((i) => !sh[i.id]).map((i) => summary(i))
      };
    },

    instrument(id: string, range = '1M') {
      const days = RANGE_DAYS[range] ?? 30;
      const h = historyOf(id);
      const year = since(h, 365).map((p) => p.close);
      const last = h[h.length - 1].close;
      const window = since(h, days);
      const r: number[] = [];
      for (let i = 1; i < year.length; i++) r.push(Math.log(year[i] / year[i - 1]));
      const m = r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
      const vol = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, r.length - 1) * 252);
      const held = id === 'portfolio' ? undefined : shares()[id];
      return {
        instrument: id === 'portfolio'
          ? { id: 'portfolio', ticker: 'Portfolio', name: 'Your investments', kind: 'etf', exchange: '', sector: '', color: '#087339' }
          : find(id),
        source: market.source,
        range,
        price: last,
        change: round(last - window[0].close),
        changePct: pct(last, window[0].close),
        history: window,
        stats: { high52: Math.max(...year), low52: Math.min(...year), return1y: pct(last, year[0]), volatility: round(vol * 100, 1) },
        position: held ? { shares: round(held, 4), value: round(held * last) } : null
      };
    }
  };
}

export type MarketService = ReturnType<typeof createMarketService>;
