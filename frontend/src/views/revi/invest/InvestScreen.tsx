// Invest tab with Revi: portfolio value and chart, holdings and other instruments with 30-day
// lines; each opens its own screen with its price history.
import { useData } from '../../../models/hooks';
import { isError } from '../../../models/phoneModel';
import { useNav } from '../../../controllers/nav';
import { Btn, Failed, List, Loading, Row, Section } from '../../components';
import { money } from '../../format';
import { PriceChart } from './PriceChart';
import { Sparkline, Tile, signed } from './Sparkline';
import type { InstrumentDetail, InstrumentSummary, MarketOverview } from './types';

function InstrumentRow({ i, held }: { i: InstrumentSummary; held: boolean }) {
  const nav = useNav();
  const pct = held ? i.changePct1d : i.changePct1m;
  return (
    <button type="button" className="row click inv-row" onClick={() => nav.go('stock', i.id)}>
      <Tile ticker={i.ticker} color={i.color} />
      <div className="rmain">
        <div className="rtitle">{i.name}</div>
        <div className="rsub">{held ? `${(i.shares ?? 0).toLocaleString('en-GB', { maximumFractionDigits: 2 })} shares` : `${i.ticker} · ${i.sector}`}</div>
      </div>
      <Sparkline values={i.spark} />
      <div className="inv-right">
        <b>{money(held ? i.value ?? 0 : i.price)}</b>
        <span className={pct >= 0 ? 'up' : 'down'}>{signed(pct, '%')}{held ? '' : ' 1M'}</span>
      </div>
    </button>
  );
}

export function InvestScreen() {
  const nav = useNav();
  const o = useData<MarketOverview>('/api/market');
  const p = useData<InstrumentDetail>('/api/market/portfolio?range=3M');

  if (!o) return <Loading />;
  if (isError(o)) return <Failed message={o.__error} />;
  const up = o.portfolio.change1d >= 0;

  return (
    <div className="content inv">
      <div className="muted">Your investments · capital at risk</div>
      <div className="inv-price">{money(o.portfolio.value)}</div>
      <div className={`inv-change ${up ? 'up' : 'down'}`}>{signed(o.portfolio.change1d)} € ({signed(o.portfolio.changePct1d, '%')}) <span className="muted">today</span></div>
      {p && !isError(p) && (
        <button type="button" className="inv-chart-btn" onClick={() => nav.go('stock', 'portfolio')} title="Open your portfolio">
          <PriceChart history={p.history} />
        </button>
      )}
      <div className="actions inv-actions">
        <Btn label="Buy" primary modal={['Buy', 'No real investments can be made in this demo.']} />
        <Btn label="Sell" modal={['Sell', 'No real investments can be made in this demo.']} />
      </div>

      <Section title="Your holdings" />
      <List>{o.holdings.map((i) => <InstrumentRow key={i.id} i={i} held />)}</List>

      <Section title="Explore" />
      <List>{o.explore.map((i) => <InstrumentRow key={i.id} i={i} held={false} />)}</List>

      <Section title="Your money" />
      <List>
        <Row icon="city" title="3D Financial City" sub="See the echo of a decision" onClick={() => nav.openCity()} />
        <Row icon="history" title="Necessary expenses" sub="Rent, food average, fixed costs" go="expenses" />
        <Row icon="pay" title="Recurring expenses" sub="Rent, gym, subscriptions" go="recurring" />
      </List>
      <p className="foot">{o.source}. Past performance does not guarantee future results.</p>
    </div>
  );
}
