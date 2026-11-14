// My purchases, receipts, offers and stores (S-Etukortti side of the app).
import { useData } from '../../../models/hooks';
import { money, shortDate } from '../../format';
import { Card, Hero, List, Loading, Row, Section } from '../../components';

export function PurchasesScreen() {
  const p = useData<any>('/api/purchases');
  if (!p) return <Loading />;
  return (
    <div className="content">
      <Hero label={`Purchases, ${p.month}`} value={money(p.total)} side="Supermarket and other purchases" />
      <Section title="By category" />
      <Card><div className="padded">{p.categories.map((c: any) => (
        <div key={c.name}>
          <div className="listitem"><b>{c.name}</b><b>{money(c.amount)}</b></div>
          <div className="bar"><span style={{ width: `${Math.round((c.amount / p.total) * 100)}%` }} /></div>
        </div>))}
      </div></Card>
      <Section title="Receipts" />
      <List><Row title="Receipts archive" go="receipts" /></List>
    </div>
  );
}

export function ReceiptsScreen() {
  const r = useData<any[]>('/api/receipts');
  if (!r || !Array.isArray(r)) return <Loading />;
  return <div className="content"><List>{r.map((x) => <Row key={x.id} title={x.store} sub={shortDate(x.date)} value={money(x.total)} go="receipt" arg={x.id} />)}</List></div>;
}

export function ReceiptScreen({ arg }: { arg: string | null }) {
  const r = useData<any>(`/api/receipts/${arg}`);
  if (!r) return <Loading />;
  return (
    <div className="content"><div className="receipt">
      <div className="receipt-head">{r.store}</div>
      <p className="small center">{shortDate(r.date)}</p>
      {r.lines.map((l: any) => <div key={l.name} className="listitem"><span>{l.name}</span><b>{money(l.amount)}</b></div>)}
      <div className="divider" />
      <div className="listitem"><b>Total</b><b>{money(r.total)}</b></div>
      <p className="foot">Example receipt, not a real transaction.</p>
    </div></div>
  );
}

export function OffersScreen() {
  const o = useData<any[]>('/api/offers');
  if (!o || !Array.isArray(o)) return <Loading />;
  return <div className="content">{o.map((x) => <Card key={x.title}><div className="padded"><div className="rtitle">{x.title}</div><p className="small">{x.text}</p></div></Card>)}</div>;
}

export function StoresScreen() {
  const s = useData<any[]>('/api/stores');
  if (!s || !Array.isArray(s)) return <Loading />;
  return (
    <div className="content">
      <List>{s.map((x) => <Row key={x.name + x.place} title={x.name} sub={x.place} />)}</List>
      <div className="warn">The demo does not use your location.</div>
    </div>
  );
}
