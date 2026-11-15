// Preview page: one phone, the bank with Revi. The device keeps Xiaomi 14 proportions and
// scales to the window.
// At phone width, or with ?embed in the URL (an iframe inside S-mobiili), the app is the page:
// no frame and no mode switcher, full-bleed up to 430px wide.
import { useLayoutEffect, useRef, useState } from 'react';
import { PhoneController } from './controllers/PhoneController';

const EMBED_MAX_WIDTH = 480;

const isEmbedded = () => window.innerWidth <= EMBED_MAX_WIDTH || new URLSearchParams(window.location.search).has('embed');

export function App() {
  const [embedded, setEmbedded] = useState(isEmbedded);
  const stage = useRef<HTMLElement>(null);
  const [zoom, setZoom] = useState(1);

  useLayoutEffect(() => {
    const fit = () => {
      setEmbedded(isEmbedded());
      if (!stage.current) return;
      const top = stage.current.getBoundingClientRect().top + window.scrollY;
      const byHeight = (window.innerHeight - top - 24) / 910;
      const byWidth = (window.innerWidth - 48) / 420;
      setZoom(Math.max(0.55, Math.min(1, byHeight, byWidth)));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  if (embedded) {
    return <main className="stage embed"><PhoneController revi label="Revi in S-mobiili" /></main>;
  }
  return (
    <>
      <header className="topbar">
        <strong>Revi · S-mobiili preview</strong>
      </header>
      <main className="stage" ref={stage}>
        <div className="pair" style={{ zoom }}>
          <PhoneController revi label="Bank + Revi" />
        </div>
      </main>
    </>
  );
}
