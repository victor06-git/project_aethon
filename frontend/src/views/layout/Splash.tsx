// Launch screens shown for a moment every time the app opens.
// The bank launch screen is fixed by brand policy: S-mobiili green with the white wordmark in the middle.
// Bank only shows it as is. With Revi the same screen stays untouched and gets a seasonal-style
// addition, the way banks add garlands at New Year (see SplashVariant for the options).
import { useEffect, useRef, useState } from 'react';
import { mountAurora } from '../revi/auroraIcon';

const BANK_MS = 1300;
const REVI_MS = 2200;
export const splashMs = (revi: boolean) => (revi ? REVI_MS : BANK_MS);

// Which Revi addition to show. lockup: aurora below + line ending in "Revi" under the wordmark.
// footer: aurora below + "with Revi" at the bottom. echo: no aurora, three echo waves + "Revi".
// shine: a band of aurora light behind the wordmark + "Revi" under it.
export type SplashVariant = 'lockup' | 'footer' | 'echo' | 'shine';
export const SPLASH_VARIANT: SplashVariant = 'footer';

function Aurora({ where }: { where: 'bottom' | 'band' }) {
  const sky = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!sky.current) return;
    try { return mountAurora(sky.current, { palette: 'overlay', wide: true }); } catch { return undefined; }
  }, []);
  return <canvas ref={sky} className={`sp-aurora ${where}`} />;
}

const WAVE = 'M2 9 C 30 2, 52 13, 80 7 S 132 3, 158 7';

// Aurora line(s) under the wordmark that draw themselves and end in "Revi".
function ReviLock({ lines }: { lines: number }) {
  return (
    <div className={`sp-lock${lines > 1 ? ' echo' : ''}`}>
      <svg className="sp-line" viewBox={`0 0 160 ${6 + lines * 8}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="spg" x1="0" x2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset=".35" stopColor="#c9ffe2" />
            <stop offset="1" stopColor="#fff" />
          </linearGradient>
        </defs>
        {Array.from({ length: lines }, (_, i) => (
          <path key={i} d={WAVE} pathLength="1" transform={`translate(0 ${i * 8})`}
            style={{ opacity: 1 - i * 0.32, animationDelay: `${0.45 + i * 0.18}s` }} />
        ))}
      </svg>
      <span className="sp-revi">Revi</span>
    </div>
  );
}

// Mounted on load; plays, fades out, then removes itself.
export function Splash({ revi, variant = SPLASH_VARIANT }: { revi: boolean; variant?: SplashVariant }) {
  const [phase, setPhase] = useState<'in' | 'out' | 'gone'>('in');
  useEffect(() => {
    const ms = splashMs(revi);
    const a = setTimeout(() => setPhase('out'), ms);
    const b = setTimeout(() => setPhase('gone'), ms + 450);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [revi]);
  if (phase === 'gone') return null;
  return (
    <div className={`splash${phase === 'out' ? ' out' : ''}`} aria-hidden="true">
      {revi && (variant === 'lockup' || variant === 'footer') && <Aurora where="bottom" />}
      {revi && variant === 'shine' && <Aurora where="band" />}
      <div className="sp-center">
        <div className="sp-bank-mark">S-mobiili</div>
        {revi && variant === 'lockup' && <ReviLock lines={1} />}
        {revi && variant === 'echo' && <ReviLock lines={3} />}
        {revi && variant === 'shine' && <div className="sp-under">Revi</div>}
      </div>
      {revi && variant === 'footer' && <div className="sp-footer"><span>with</span> Revi</div>}
    </div>
  );
}
