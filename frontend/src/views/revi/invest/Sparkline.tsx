// Tiny 30-day line for list rows. Green when the month ended up, red when down.
export function Sparkline({ values, width = 64, height = 26 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 2 - ((v - min) / span) * (height - 4)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? 'var(--pos)' : 'var(--neg)'} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// Square logo tile with the ticker's first letters (no real logos are used).
export function Tile({ ticker, color }: { ticker: string; color: string }) {
  return <span className="inv-tile" style={{ background: color }}>{ticker.replace(/[^A-Z0-9]/g, '').slice(0, 2)}</span>;
}

export const signed = (n: number, suffix = '') => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}${suffix}`;
