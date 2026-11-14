// Home: the existing S-mobiili home screen. In Revi mode: total balance and the Revi card on top.
import { useData } from '../../../models/hooks';
import { isError } from '../../../models/phoneModel';
import { useNav } from '../../../controllers/nav';
import { money } from '../../format';
import { List, Row, Section, Loading, Failed, Card } from '../../components';
import { ReviCard } from '../../revi/ReviCard';

export function HomeScreen() {
  const nav = useNav();
  const home = useData<any>('/api/home');
  if (!home) return <Loading />;
  if (isError(home)) return <Failed message={home.__error} />;
  return (
    <div className="content">
      <div className="subtitle">Good morning!</div>
      <div className="title">Welcome to S-mobiili</div>
      {nav.revi && (
        <>
          <Card><div className="padded">
            <div className="balance-label">Total balance</div>
            <div className="balance-amount">{money(home.totalBalance)}</div>
            <div className="balance-row"><span>Invested</span><strong>{money(home.invested)}</strong></div>
          </div></Card>
          <ReviCard />
        </>
      )}
      <button type="button" className="banner" onClick={() => nav.go('upcoming')}><span>Upcoming payments</span><span>{home.upcomingCount} ›</span></button>
      <div className="light-hero">
        <div className="rtitle">Bonus this month</div>
        <div className="bigline">{money(home.bonus.earned)}</div>
        <div className="rsub">{money(home.bonus.nextTierGap)} to the next Bonus tier</div>
        <div className="bar"><span style={{ width: `${Math.round(home.bonus.progress * 100)}%` }} /></div>
        <button type="button" className="link" onClick={() => nav.setTab('rewards')}>View Bonus ›</button>
      </div>
      <Section title="Banking services" go="banking" />
      <List>
        <Row icon="accounts" title="Accounts" sub="S Account" value={money(home.totalBalance)} go="accounts" />
        <Row icon="card" title="Cards" sub="S-Etukortti Visa" value="Debit" go="cards" />
        <Row icon="saver" title="Saver" sub="Automatic saving" go="saver" />
        <Row icon="invest" title="Investments" sub="Funds and investments" go="invest" />
        <Row icon="loan" title="Loans" sub="Mortgage" go="loans" />
      </List>
      <Section title="Purchases and benefits" go="rewards" />
      <List>
        <Row icon="bag" title="My purchases" sub="Track your purchases" go="purchases" />
        <Row icon="receipt" title="Receipts" sub="Digital purchase receipts" go="receipts" />
        <Row icon="offer" title="Offers and tips" sub="Current offers" go="offers" />
      </List>
    </div>
  );
}
