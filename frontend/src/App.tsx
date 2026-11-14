// Preview page: three modes (bank as is, bank + Revi, side by side). Each phone is its own
// controller with its own model. The devices keep Xiaomi 14 proportions and scale to the window.
// At phone width, or with ?embed in the URL (an iframe inside S-mobiili), the app is the page:
// no frame and no mode switcher, full-bleed up to 430px wide.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PhoneController } from './controllers/PhoneController';

const EMBED_MAX_WIDTH = 480;

type Mode = 'bank' | 'revi' | 'both';
const MODES: { id: Mode; label: string }[] = [
  { id: 'bank', label: 'Bank only' }, { id: 'revi', label: 'Bank + Revi' }, { id: 'both', label: 'Side by side' }
];

function savedMode(): Mode {
  try { return (localStorage.getItem('revi-mode') as Mode) || 'revi'; } catch { return 'revi'; }
}

const isEmbedded = () => window.innerWidth <= EMBED_MAX_WIDTH || new URLSearchParams(window.location.search).has('embed');

export function App() {
  const [mode, setMode] = useState<Mode>(savedMode);
  const [embedded, setEmbedded] = useState(isEmbedded);
  const stage = useRef<HTMLElement>(null);
  const [zoom, setZoom] = useState(1);
  const panes = mode === 'both'
    ? [{ revi: false, caption: 'Bank as is' }, { revi: true, caption: 'Bank + Revi' }]
    : [{ revi: mode === 'revi', caption: null }];

  useEffect(() => { try { localStorage.setItem('revi-mode', mode); } catch { /* storage may be blocked */ } }, [mode]);

  useLayoutEffect(() => {
    const fit = () => {
      setEmbedded(isEmbedded());
      if (!stage.current) return;
      const top = stage.current.getBoundingClientRect().top + window.scrollY;
      const caption = mode === 'both' ? 28 : 0;
      const byHeight = (window.innerHeight - top - 24 - caption) / 910;
      const byWidth = (window.innerWidth - 48 - 40 * (panes.length - 1)) / (420 * panes.length);
      setZoom(Math.max(0.55, Math.min(1, byHeight, byWidth)));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [mode, panes.length]);

  if (embedded) {
    return <main className="stage embed"><PhoneController revi label="Revi in S-mobiili" /></main>;
  }
  return (
    <>
      <header className="topbar">
        <strong>Revi · S-mobiili preview</strong>
        <nav className="modes">
          {MODES.map((m) => <button key={m.id} type="button" data-mode={m.id} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>)}
        </nav>
      </header>
      <main className="stage" ref={stage}>
        {panes.map((p) => (
          <div key={`${mode}-${p.revi}`} className="pair" style={{ zoom }}>
            {p.caption && <div className="caption">{p.caption}</div>}
            <PhoneController revi={p.revi} label={p.caption ?? (p.revi ? 'Bank + Revi' : 'Bank')} />
          </div>
        ))}
      </main>
    </>
  );
}
