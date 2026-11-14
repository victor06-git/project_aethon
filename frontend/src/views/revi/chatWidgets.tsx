// Conversational UI widgets rendered inside chat bubbles (not separate bank screens).
import { useMemo, useState } from 'react';
import type { ChatPlanner } from '../../../../backend/src/domain/types';
import { money } from '../format';

function loanPayment(principal: number, months: number, rateAnnual: number) {
  if (principal <= 0 || months <= 0) return 0;
  const r = rateAnnual / 12;
  if (r <= 0) return principal / months;
  const f = (1 + r) ** months;
  return (principal * r * f) / (f - 1);
}

/** Interactive bars: tap a column for the detail line under the chart. */
export function ChatChart({
  rows,
  interactive = true
}: {
  rows: { label: string; amount: number }[];
  interactive?: boolean;
}) {
  const [active, setActive] = useState<string | null>(null);
  const max = Math.max(...rows.map((r) => r.amount), 1);
  const W = 280;
  const H = 120;
  const pad = { t: 8, r: 8, b: 28, l: 8 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const gap = 6;
  const barW = Math.max(10, (innerW - gap * (rows.length - 1)) / rows.length);
  const selected = rows.find((r) => r.label === active);

  return (
    <div className="k-chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Chart">
        {rows.map((r, i) => {
          const h = Math.max(2, (r.amount / max) * innerH);
          const x = pad.l + i * (barW + gap);
          const y = pad.t + innerH - h;
          const on = active === r.label;
          return (
            <g
              key={r.label}
              className={interactive ? 'k-chart-hit' : undefined}
              onClick={interactive ? () => setActive(on ? null : r.label) : undefined}
            >
              <rect x={x} y={y} width={barW} height={h} rx={2} className={`k-chart-bar${on ? ' on' : ''}`} />
              <text x={x + barW / 2} y={H - 10} textAnchor="middle" className="k-chart-label">
                {r.label.length > 9 ? `${r.label.slice(0, 8)}…` : r.label}
              </text>
            </g>
          );
        })}
      </svg>
      {selected ? (
        <div className="k-chart-detail">{selected.label}: <b>{money(selected.amount, 0)}</b></div>
      ) : (
        <div className="k-chart-legend">
          {rows.map((r) => (
            <span key={r.label}>{r.label} · {money(r.amount, 0)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Helsinki car planner: down-payment slider + live cost bars inside the same bubble. */
export function CarPlanner({ planner }: { planner: ChatPlanner }) {
  const [down, setDown] = useState(planner.downPayment);
  const rows = useMemo(() => {
    const loan = Math.max(0, planner.price - down);
    const monthlyLoan = loanPayment(loan, planner.months, planner.rateAnnual);
    const carMonth = monthlyLoan + planner.parkingMonth + planner.insuranceMonth;
    const free = Math.max(0, planner.leftoverMonth - carMonth);
    return [
      { label: 'Loan', amount: Math.round(monthlyLoan) },
      { label: 'Parking', amount: planner.parkingMonth },
      { label: 'Insurance', amount: planner.insuranceMonth },
      { label: 'Left', amount: Math.round(free) }
    ];
  }, [down, planner]);

  const carMonth = rows[0].amount + rows[1].amount + rows[2].amount;

  return (
    <div className="k-planner">
      <label className="k-slider">
        <span>Down payment: <b>{money(down, 0)}</b></span>
        <input
          type="range"
          min={0}
          max={planner.price}
          step={100}
          value={down}
          onChange={(e) => setDown(Number(e.target.value))}
        />
        <span className="k-slider-ends"><i>0 €</i><i>{money(planner.price, 0)}</i></span>
      </label>
      <div className="k-planner-sum">
        Car ~ <b>{money(carMonth, 0)}/mo</b>
        {planner.zoneLabel ? ` · ${planner.zoneLabel}` : ''} · tap a bar for detail
      </div>
      <ChatChart rows={rows} />
    </div>
  );
}
