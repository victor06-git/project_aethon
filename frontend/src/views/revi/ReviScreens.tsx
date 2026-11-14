// Revi screens: the 3D City, expenses, recurring. The Invest tab lives in ./invest.
import { useData } from '../../models/hooks';
import { money } from '../format';
import { List, Loading, Row, Section } from '../components';
import { CityView } from './CityView';

// The 3D City on its own screen (opened from the Home card, the chat and the Invest tab).
export function CityScreen({ arg }: { arg: string | null }) {
  return <CityView scenarioId={arg} />;
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
