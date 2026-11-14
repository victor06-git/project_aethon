// The phone frame around every screen: status bar, permanent header, tab bar, modal.
import { useNav } from '../../controllers/nav';
import { Icon } from '../icons';

interface Tab { id: string; label: string; icon: string; raised?: boolean }

// Bank as is: Home is the first tab. With Revi too; the Invest page opens from Home
// ("Investments") and from Banking, as in the bank.
const TABS_BANK: Tab[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'rewards', label: 'S-Etukortti', icon: 'card' },
  { id: 'pay', label: 'Pay', icon: 'plus', raised: true }, // the existing app: raised green round "+" button
  { id: 'banking', label: 'Banking', icon: 'bank' },
  { id: 'me', label: 'Me', icon: 'user' }
];
const TABS: Tab[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'rewards', label: 'S-Etukortti', icon: 'card' },
  { id: 'pay', label: 'Pay', icon: 'pay' },
  { id: 'banking', label: 'Banking', icon: 'bank' },
  { id: 'me', label: 'Me', icon: 'user' }
];


export const StatusBar = () => (
  <div className="status-bar"><span>9:41</span><span className="sb-icons"><i /><i /><i /><b /></span></div>
);

// Permanent header. No house icon next to the title — "S-mobiili" stays pinned and opens Home.
export function Header({ subTitle }: { subTitle: string | null }) {
  const nav = useNav();
  return (
    <>
      <header className="appbar">
        <button type="button" className="brandlink" onClick={nav.home} title="Back to Home">
          <span className="brand">S-mobiili</span>
        </button>
        <div className="header-actions">
          <button type="button" className="hicon" title="Messages" onClick={() => nav.go('messages')}><Icon name="message" size={22} /></button>
          <button type="button" className="hicon" title="Search" onClick={() => nav.go('search')}><Icon name="search" size={22} /></button>
        </div>
      </header>
      {subTitle !== null && (
        <div className="crumb">
          <button type="button" className="crumb-back" onClick={nav.back} aria-label="Back"><Icon name="back" size={20} /></button>
          <span>{subTitle}</span>
        </div>
      )}
    </>
  );
}

export function TabBar({ active }: { active: string | null }) {
  const nav = useNav();
  return (
    <nav className="tabbar">
      {(nav.revi ? TABS : TABS_BANK).map((t) => (
        <button key={t.id} type="button" className={`${active === t.id ? 'on' : ''}${t.raised ? ' raised' : ''}`} onClick={() => nav.setTab(t.id)}>
          {t.raised ? <span className="raise"><Icon name={t.icon} size={22} /></span> : <Icon name={t.icon} size={23} />}
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

export const Modal = ({ title, body, onClose }: { title: string; body: string; onClose: () => void }) => (
  <div className="modal-wrap">
    <div className="modal" role="dialog" aria-label={title}>
      <h3>{title}</h3><p>{body}</p>
      <button type="button" className="btn primary block" onClick={onClose}>Close</button>
    </div>
  </div>
);
