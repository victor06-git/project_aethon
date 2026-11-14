// Shared building blocks. Navigation goes through the controller (useNav), never the DOM.
import type { ReactNode } from 'react';
import { useNav } from '../controllers/nav';
import { Icon } from './icons';

export function Row({ icon, title, sub, value, cls = '', go, arg, tag, onClick }: {
  icon?: string; title: string; sub?: string; value?: string; cls?: string;
  go?: string; arg?: string; tag?: string; onClick?: () => void;
}) {
  const nav = useNav();
  const action = onClick ?? (go ? () => nav.go(go, arg ?? null) : undefined);
  const inner = (
    <>
      {icon && <span className="glyph"><Icon name={icon} size={20} /></span>}
      <div className="rmain">
        <div className="rtitle">{title}{tag && <span className="tag">{tag}</span>}</div>
        {sub && <div className="rsub">{sub}</div>}
      </div>
      {value !== undefined && <div className={`amount ${cls}`}>{value}</div>}
      {action && <span className="chev">›</span>}
    </>
  );
  return action
    ? <button type="button" className="row click" onClick={action}>{inner}</button>
    : <div className="row">{inner}</div>;
}

export const List = ({ children }: { children: ReactNode }) => <div className="list">{children}</div>;
export const Card = ({ children, padded = false }: { children: ReactNode; padded?: boolean }) =>
  <div className={`card${padded ? ' padded' : ''}`}>{children}</div>;

export function Section({ title, go }: { title: string; go?: string }) {
  const nav = useNav();
  return (
    <div className="section-title">{title}
      {go && <button type="button" className="link" onClick={() => nav.setTab(go)}>View all ›</button>}
    </div>
  );
}

export const Hero = ({ label, value, side }: { label: string; value: string; side?: string }) => (
  <div className="hero"><div className="small">{label}</div><strong>{value}</strong>{side && <div className="side">{side}</div>}</div>
);

export function Btn({ label, go, arg, modal, primary, block, submit, disabled, onClick }: {
  label: string; go?: string; arg?: string; modal?: [string, string];
  primary?: boolean; block?: boolean; submit?: boolean; disabled?: boolean; onClick?: () => void;
}) {
  const nav = useNav();
  const click = onClick ?? (go ? () => nav.go(go, arg ?? null) : modal ? () => nav.showModal(modal[0], modal[1]) : undefined);
  return (
    <button type={submit ? 'submit' : 'button'} className={`btn${primary ? ' primary' : ''}${block ? ' block' : ''}`} disabled={disabled} onClick={click}>
      {label}
    </button>
  );
}

export function Field({ label, name, type = 'text', defaultValue, options }: {
  label: string; name: string; type?: string; defaultValue?: string; options?: string[];
}) {
  return (
    <>
      <label className="formlabel" htmlFor={`f-${name}`}>{label}</label>
      {options
        ? <select className="field" id={`f-${name}`} name={name}>{options.map((o) => <option key={o}>{o}</option>)}</select>
        : <input className="field" id={`f-${name}`} name={name} type={type} defaultValue={defaultValue} autoComplete="off" />}
    </>
  );
}

// Visual card — S-Etukortti / Visa look from the UX reference.
export const CardArt = ({ name, last4 }: { name: string; last4: string }) => (
  <div className="cardart">
    <b style={{ fontSize: 20 }}>{name}</b>
    <span className="cardnum">•••• •••• •••• {last4}</span>
    <span style={{ alignSelf: 'flex-end', fontSize: 22, fontStyle: 'italic', fontWeight: 900 }}>VISA</span>
  </div>
);

export const Loading = () => <div className="content"><div className="muted">Loading…</div></div>;
export const Failed = ({ message }: { message?: string }) => <div className="content"><div className="warn">{message || 'Could not load this page.'}</div></div>;
