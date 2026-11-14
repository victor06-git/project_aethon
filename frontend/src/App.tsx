// Preview page: three modes (bank as is, bank + Kaiku, side by side). Each phone is its own
// controller with its own model. The devices keep Xiaomi 14 proportions and scale to the window.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PhoneController } from './controllers/PhoneController';

type Mode = 'bank' | 'kaiku' | 'both';
const MODES: { id: Mode; label: string }[] = [
  { id: 'bank', label: 'Bank only' }, { id: 'kaiku', label: 'Bank + Kaiku' }, { id: 'both', label: 'Side by side' }
];

function savedMode(): Mode {
  try { return (localStorage.getItem('kaiku-mode') as Mode) || 'kaiku'; } catch { return 'kaiku'; }
}

export function App() {
  const [mode, setMode] = useState<Mode>(savedMode);
  const stage = useRef<HTMLElement>(null);
  const [zoom, setZoom] = useState(1);
  const panes = mode === 'both'
    ? [{ kaiku: false, caption: 'Bank as is' }, { kaiku: true, caption: 'Bank + Kaiku' }]
    : [{ kaiku: mode === 'kaiku', caption: null }];

  useEffect(() => { try { localStorage.setItem('kaiku-mode', mode); } catch { /* storage may be blocked */ } }, [mode]);

  useLayoutEffect(() => {
    const fit = () => {
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

  return (
    <>
      <header className="topbar">
        <strong>Kaiku · S-mobiili preview</strong>
        <nav className="modes">
          {MODES.map((m) => <button key={m.id} type="button" data-mode={m.id} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>)}
        </nav>
      </header>
      <main className="stage" ref={stage}>
        {panes.map((p) => (
          <div key={`${mode}-${p.kaiku}`} className="pair" style={{ zoom }}>
            {p.caption && <div className="caption">{p.caption}</div>}
            <PhoneController kaiku={p.kaiku} label={p.caption ?? (p.kaiku ? 'Bank + Kaiku' : 'Bank')} />
          </div>
        ))}
      </main>
    </>
  );
}
