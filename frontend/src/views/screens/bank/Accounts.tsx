// Accounts, one account, transactions, and the card/limit screens.
import type { FormEvent } from 'react';
import type { Transaction } from '../../../../../backend/src/domain/types';
import { useData } from '../../../models/hooks';
import { isError } from '../../../models/phoneModel';
import { useNav } from '../../../controllers/nav';
import { money, shortDate } from '../../format';
import { Btn, CardArt, Failed, Field, Hero, List, Loading, Row, Section } from '../../components';

export const TxRow = ({ t }: { t: Transaction }) => (
  <Row title={t.merchant} sub={`${shortDate(t.date)} · ${t.category.replace('_', ' ')}`}
    value={`${t.amount > 0 ? '+' : '−'}${money(Math.abs(t.amount))}`} cls={t.amount > 0 ? 'pos' : ''} />
);

export function AccountsScreen() {
  const a = useData<any>('/api/accounts');
  const tx = useData<Transaction[]>('/api/transactions');
  if (!a) return <Loading />;
  return (
    <div className="content">
      <List>{a.accounts.map((acc: any) => <Row key={acc.id} title={acc.name} sub={acc.iban} value={money(acc.balance)} go="account" arg={acc.id} />)}</List>
      <Btn label="Own transfer" go="transfer" block />
      <Section title="Transactions" />
      <List>{Array.isArray(tx) ? tx.slice(0, 4).map((t) => <TxRow key={t.id} t={t} />) : null}</List>
    </div>
  );
}

export function AccountScreen({ arg }: { arg: string | null }) {
  const acc = useData<any>(`/api/accounts/${arg}`);
  if (!acc) return <Loading />;
  if (isError(acc)) return <Failed message={acc.__error} />;
  return (
    <div className="content">
      <Hero label={acc.name} value={money(acc.balance)} side={acc.iban} />
      <div className="actions"><Btn label="New payment" go="newpayment" primary /><Btn label="Transfer" go="transfer" /></div>
      <Section title="Recent transactions" />
      <List>{acc.transactions.map((t: Transaction) => <TxRow key={t.id} t={t} />)}</List>
    </div>
  );
}

export function TransactionsScreen() {
  const t = useData<Transaction[]>('/api/transactions');
  if (!t || isError(t)) return <Loading />;
  const groups = new Map<string, Transaction[]>();
  for (const x of t) groups.set(x.date, [...(groups.get(x.date) ?? []), x]);
  return (
    <div className="content">
      {[...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, items]) => (
        <div key={date}><Section title={shortDate(date)} /><List>{items.map((x) => <TxRow key={x.id} t={x} />)}</List></div>
      ))}
    </div>
  );
}

export function CardsScreen() {
  const c = useData<any>('/api/cards');
  if (!c) return <Loading />;
  return (
    <div className="content">
      {c.cards.map((k: any) => <CardArt key={k.id} name={k.name} last4={k.last4} />)}
      <List>{c.cards.map((k: any) => <Row key={k.id} title={k.name} sub={`Ending in ${k.last4}`} go="card" arg={k.id} />)}</List>
      <Btn label="Order a new card" block modal={['New card', 'Card ordering is only illustrative in this demo.']} />
    </div>
  );
}

export function CardScreen() {
  const c = useData<any>('/api/cards');
  if (!c) return <Loading />;
  const k = c.cards[0];
  return (
    <div className="content">
      <CardArt name={k.name} last4={k.last4} />
      <List>
        <Row title="Card limits" sub="Online, abroad and cash withdrawals" go="security" />
        <Row title="Card transactions" go="transactions" />
      </List>
      <Btn label="Show PIN" block modal={['Show PIN', 'PIN is not available in this demo.']} />
    </div>
  );
}

export function SecurityScreen() {
  const nav = useNav();
  const c = useData<any>('/api/cards');
  if (!c) return <Loading />;
  const l = c.limits;
  const save = (e: FormEvent) => { e.preventDefault(); nav.showModal('Card limits', 'Limits are not changed at a real bank in this demo.'); };
  return (
    <div className="content"><form onSubmit={save}>
      <Field label="Daily purchase limit" name="daily" options={['€1,000', '€500', '€2,000']} />
      <Field label="Cash withdrawal limit" name="cash" options={['€400', '€200', '€800']} />
      <List>
        <Row title="Online purchases" value={l.onlinePurchases ? 'On' : 'Off'} />
        <Row title="Payments abroad" value={l.abroad ? 'On' : 'Off'} />
      </List>
      <Btn label="Save" primary block submit />
    </form></div>
  );
}
