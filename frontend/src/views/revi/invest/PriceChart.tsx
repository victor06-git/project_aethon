// Price chart: the price history as a line with a soft area under it, from the first day of the
// chosen range to today.
import type { PricePoint } from './types';
import { shortDate } from '../../format';

const W = 360, H = 190, PAD_T = 14, PAD_B = 22;

export function PriceChart({ history }: { history: PricePoint[] }) {
  if (history.length < 2) return null;
  const values = history.map((p) => p.close);
  let lo = Math.min(...values), hi = Math.max(...values);
  const pad = (hi - lo || hi * 0.05) * 0.08; lo -= pad; hi += pad;
  const x = (i: number) => (i / (history.length - 1)) * W;
  const y = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B);
  const line = history.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.close).toFixed(1)}`).join('');
  const area = `${line}L${W},${H - PAD_B}L0,${H - PAD_B}Z`;
  return (
    <svg className="inv-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price history">
      <defs>
        <linearGradient id="invArea" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--green)" stopOpacity=".22" />
          <stop offset="1" stopColor="var(--green)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#invArea)" />
      <path className="inv-line" d={line} />
      <text className="inv-axis" x={2} y={H - 6}>{shortDate(history[0].date)}</text>
      <text className="inv-axis" x={W - 2} y={H - 6} textAnchor="end">Today</text>
    </svg>
  );
}
