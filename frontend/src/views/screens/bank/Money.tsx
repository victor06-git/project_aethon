// Loans, mortgage, bank-only Invest, Saver. (In Kaiku mode the Invest tab is views/kaiku/InvestScreen.)
import { useData } from '../../../models/hooks';
import { isError } from '../../../models/phoneModel';
import { money, shortDate } from '../../format';
import { Btn, Failed, Hero, List, Loading, Row, Section } from '../../components';

export function LoansScreen() {
  const l = useData<any>('/api/loans');
  if (!l) return <Loading />;
  return (
    <div className="content">
      <List>{l.loans.map((x: any) => <Row key={x.id} title={x.name} sub={`Rate ${x.rate}% · ${money(x.payment)} a month`} value={money(x.balance, 0)} go="mortgage" arg={x.id} />)}</List>
      <Section title="Loan services" />
      <List><Row title="Apply for a loan" sub="Consumer loan" /><Row title="Mortgage application" sub="Explore options" /></List>
    </div>
  );
}

export function MortgageScreen() {
  const m = useData<any>('/api/loans/mortgage');
  if (!m) return <Loading />;
  return (
    <div className="content">
      <Hero label="Outstanding balance" value={money(m.balance)} side={`Next payment ${shortDate(m.nextDate)} · ${money(m.payment)}`} />
      <List>
        <Row title="Interest rate" sub="Reference rate plus margin" value={`${m.rate}%`} />
        <Row title="Next loan payment" value={money(m.payment)} />
        <Row title="Estimated end" value={String(m.endYear)} />
      </List>
    </div>
  );
}

export function InvestBankScreen() {
  const v = useData<any>('/api/investments');
  if (!v) return <Loading />;
  if (isError(v)) return <Failed message={v.__error} />;
  const n = v.series.length;
  const line = v.series.map((y: number, i: number) => `${i ? 'L' : 'M'}${(i / Math.max(1, n - 1)) * 330} ${108 - y * 18}`).join(' ');
  return (
    <div className="content">
      <Hero label="Value of your investments" value={money(v.value)} side={`Total return +${v.returnPct}%`} />
      <div className="linechart"><svg viewBox="0 0 330 120" aria-label="Investment growth">
        <path d={`${line} L330 120 L0 120 Z`} fill="#b9efc8" opacity=".55" />
        <path d={line} fill="none" stroke="#0ab354" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
      </svg></div>
      <Section title="Funds" />
      <List>{v.funds.map((f: any) => <Row key={f.id} icon="invest" title={f.name} sub="Fund investment" value={money(f.value)} />)}</List>
      <div className="actions">
        <Btn label="Buy" primary modal={['Buy fund', 'No real investments can be made in this demo.']} />
        <Btn label="Sell" modal={['Sell fund', 'No real investments can be made in this demo.']} />
      </div>
    </div>
  );
}

export const SaverScreen = () => (
  <div className="content">
    <div className="card padded"><div className="subtitle">SAVE AUTOMATICALLY</div>
      <h2>Save on everyday purchases</h2>
      <p className="small">For example, save one euro per card purchase, or move part of your rewards into a fund.</p></div>
    <List><Row title="One euro per purchase" value="Off" /><Row title="Rewards to fund" value="Off" /></List>
    <Btn label="Turn on" primary block modal={['Saver', 'Saving methods cannot be activated in this demo.']} />
  </div>
);
