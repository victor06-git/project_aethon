// The other tab screens of the existing app: S-Etukortti, Pay, Banking, Me.
import { useData } from '../../../models/hooks';
import { useNav } from '../../../controllers/nav';
import { money } from '../../format';
import { Btn, CardArt, Hero, List, Loading, Row, Section } from '../../components';

export function RewardsScreen() {
  const b = useData<any>('/api/bonus');
  if (!b) return <Loading />;
  return (
    <div className="content">
      <div className="subtitle">S-ETUKORTTI</div>
      <div className="title">S-Etukortti</div>
      <CardArt name="S-ETUKORTTI" last4="1234" />
      <div className="light-hero">
        <div className="small">Bonus earned in {b.month}</div>
        <div className="bigline">{money(b.earned)}</div>
        <div className="rsub">Bonus tier {b.tierPct}% · {money(b.nextTierGap)} to next tier</div>
        <div className="bar"><span style={{ width: `${Math.round(b.progress * 100)}%` }} /></div>
      </div>
      <Section title="S-Etukortti services" />
      <List>
        <Row title="My purchases" sub="Breakdown by category" go="purchases" />
        <Row title="Receipts" sub="Digital receipts" go="receipts" />
        <Row title="Offers and tips" sub="Selected for you" go="offers" />
        <Row title="Where to earn Bonus" sub="Stores and services" go="stores" />
      </List>
    </div>
  );
}

export function PayScreen() {
  const nav = useNav();
  return (
    <div className="content">
      <div className="tiles">
        <button type="button" className="tile" onClick={() => nav.go('newpayment')}>New payment</button>
        <button type="button" className="tile" onClick={() => nav.go('transfer')}>Own transfer</button>
      </div>
      <Section title="Payments" />
      <List>
        <Row title="Upcoming payments" sub="Scheduled" go="upcoming" />
        <Row title="E-invoices" sub="Subscriptions and offers" go="einvoices" />
      </List>
    </div>
  );
}

export function BankingScreen() {
  const nav = useNav();
  const a = useData<any>('/api/accounts');
  const home = useData<any>('/api/home');
  if (!a || !home) return <Loading />;
  return (
    <div className="content">
      <div className="subtitle">S-PANKKI</div>
      <div className="title">Banking</div>
      <Hero label="Current account balance" value={money(a.totalBalance)} side="S Account · FI•• ··1234" />
      <div className="tiles">
        <button type="button" className="tile" onClick={() => nav.setTab('pay')}><b>Pay</b><div className="small">Bills and transfers</div></button>
        <button type="button" className="tile" onClick={() => nav.go('cards')}><b>Cards</b><div className="small">Card details</div></button>
      </div>
      <button type="button" className="banner" onClick={() => nav.go('upcoming')}><span>Upcoming payments</span><span>{home.upcomingCount} ›</span></button>
      <Section title="Accounts and cards" />
      <List>
        <Row title="Accounts" sub="Transactions" value={money(a.totalBalance)} go="accounts" />
        <Row title="Cards" sub="S-Etukortti Visa" go="cards" />
      </List>
      <Section title="Saving and loans" />
      <List>
        <Row title="Saver" sub="Save as you shop" go="saver" />
        <Row title="Invest" sub="Funds and the money echo" go="invest" />
        <Row icon="loan" title="Loans" sub="Mortgage" go="loans" />
      </List>
      <Section title="Other services" />
      <List>
        <Row title="E-invoices" go="einvoices" />
        <Row title="Online payslip" go="payslip" />
        <Row title="S-Pankki Private" go="private" />
      </List>
    </div>
  );
}

export function MeScreen() {
  const p = useData<any>('/api/profile');
  if (!p) return <Loading />;
  return (
    <div className="content">
      <List><Row title={p.fullName} sub={p.membership} go="profile" /></List>
      <Section title="Sign-in" />
      <List><Row title="Authentication" sub="QR code and confirmations" go="auth" /></List>
      <Section title="Settings" />
      <List><Row title="Personal details" go="profile" /><Row title="Settings" sub="Language, notifications" go="settings" /></List>
      <Section title="Help" />
      <List><Row title="Messages" go="messages" /><Row title="Customer service" go="help" /></List>
      <Btn label="Sign out" block modal={['Sign out', 'In this demo, signing out does not affect any account or data.']} />
    </div>
  );
}
