// Revi screens: the Invest tab (live 3D City on top, then investments), expenses, recurring.
import { useData } from '../../models/hooks';
import { money } from '../format';
import { Btn, Hero, List, Loading, Row, Section } from '../components';
import { CityView } from './CityView';

export function InvestReviScreen({ arg }: { arg: string | null }) {
  const v = useData<any>('/api/investments');
  return (
    <CityView scenarioId={arg}>
      {v && !('__error' in v) && (
        <>
          <Section title="Your investments" />
          <Hero label="Value of your investments" value={money(v.value)} side={`Total return +${v.returnPct}%`} />
          <List>{v.funds.map((f: any) => <Row key={f.id} icon="invest" title={f.name} sub="Fund investment" value={money(f.value)} />)}</List>
          <div className="actions">
            <Btn label="Buy" primary modal={['Buy fund', 'No real investments can be made in this demo.']} />
            <Btn label="Sell" modal={['Sell fund', 'No real investments can be made in this demo.']} />
          </div>
          <List>
            <Row icon="history" title="Necessary expenses" sub="Rent, food average, fixed costs" go="expenses" />
            <Row icon="pay" title="Recurring expenses" sub="Rent, gym, subscriptions" go="recurring" />
          </List>
        </>
      )}
    </CityView>
  );
}

export function ExpensesScreen() {
  const e = useData<any>('/api/coach/expenses');
  if (!e) return <Loading />;
  const groups: [string, any[]][] = [['Mandatory', e.mandatory], ['Priority', e.priority], ['Flexible', e.flexible]];
  const total = groups.reduce((s, [, items]) => s + items.reduce((a, x) => a + x.amount, 0), 0);
  return (
    <div className="content">
      <div className="title">Necessary expenses</div>
      {groups.map(([title, items]) => (
        <div key={title}><Section title={title} />
          <List>{items.map((x) => <Row key={x.name} title={x.name} value={money(x.amount)} tag={x.changePct ? `+${x.changePct}%` : undefined} />)}</List>
        </div>
      ))}
      <List><div className="total-line"><span>Total this month</span><span>{money(total)}</span></div></List>
      <p className="foot">Non-recurring expenses are not included.</p>
    </div>
  );
}

export function RecurringScreen() {
  const r = useData<any[]>('/api/payments/recurring');
  if (!r || !Array.isArray(r)) return <Loading />;
  return (
    <div className="content">
      <div className="title">Recurring expenses</div>
      <List>{r.map((x) => <Row key={x.name} title={x.name} sub={`Every month, day ${x.day}`} value={money(x.amount)} />)}</List>
    </div>
  );
}
