// One instrument (or the whole portfolio): price, chart, history range, the user's position and
// key figures. Revolut-style layout, S-mobiili look.
import { useState } from 'react';
import { useData } from '../../../models/hooks';
import { isError } from '../../../models/phoneModel';
import { Btn, Failed, List, Loading } from '../../components';
import { money } from '../../format';
import { PriceChart } from './PriceChart';
import { Tile, signed } from './Sparkline';
import { RANGES, type InstrumentDetail } from './types';

const RANGE_TEXT: Record<string, string> = { '1W': 'past week', '1M': 'past month', '3M': 'past 3 months', '6M': 'past 6 months', '1Y': 'past year' };

export function StockScreen({ arg }: { arg: string | null }) {
  const id = arg ?? 'portfolio';
  const [range, setRange] = useState<(typeof RANGES)[number]>('3M');
  const d = useData<InstrumentDetail>(`/api/market/${id}?range=${range}`);

  if (!d) return <Loading />;
  if (isError(d)) return <Failed message={d.__error} />;

  const up = d.change >= 0;
  const isPortfolio = id === 'portfolio';

  return (
    <div className="content inv">
      <div className="inv-head">
        {!isPortfolio && <Tile ticker={d.instrument.ticker} color={d.instrument.color} />}
        <div>
          <div className="inv-name">{d.instrument.name}</div>
          {!isPortfolio && <div className="muted">{d.instrument.ticker} · {d.instrument.exchange}</div>}
        </div>
      </div>

      <div className="inv-price">{money(d.price)}</div>
      <div className={`inv-change ${up ? 'up' : 'down'}`}>{signed(d.change)} € ({signed(d.changePct, '%')}) <span className="muted">{RANGE_TEXT[range]}</span></div>

      <PriceChart history={d.history} />

      <div className="inv-ranges" role="tablist" aria-label="History range">
        {RANGES.map((r) => (
          <button key={r} type="button" role="tab" aria-selected={r === range} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>
        ))}
      </div>

      {d.position && (
        <List>
          <div className="inv-pos one">
            <div><span className="muted">Your position</span><b>{money(d.position.value)}</b><span className="muted">{d.position.shares.toLocaleString('en-GB', { maximumFractionDigits: 4 })} shares</span></div>
          </div>
        </List>
      )}

      {!isPortfolio && (
        <div className="actions inv-actions">
          <Btn label="Buy" primary modal={['Buy', 'No real investments can be made in this demo.']} />
          <Btn label="Sell" modal={['Sell', 'No real investments can be made in this demo.']} />
        </div>
      )}

      <div className="section-title">Key figures</div>
      <List>
        <div className="inv-stats">
          <div><span className="muted">52-week high</span><b>{money(d.stats.high52)}</b></div>
          <div><span className="muted">52-week low</span><b>{money(d.stats.low52)}</b></div>
          <div><span className="muted">1-year return</span><b className={d.stats.return1y >= 0 ? 'up' : 'down'}>{signed(d.stats.return1y, '%')}</b></div>
          <div title="How much the price moves in a year, as a percentage."><span className="muted">Volatility</span><b>{d.stats.volatility}%</b></div>
          {!isPortfolio && <div><span className="muted">Sector</span><b>{d.instrument.sector}</b></div>}
        </div>
      </List>
      <p className="foot">{d.source}. Past performance does not guarantee future results. Capital at risk.</p>
    </div>
  );
}
