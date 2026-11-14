import { useEffect, useRef } from 'react';
import { mountAurora, mountWaves, type AuroraPalette, type WaveVariant } from './auroraIcon';

// Kaiku's mark: a round window onto the northern lights, wrapped in two living waves.
// 'brand' palette paints the scene in the bank's own greens; 'night' keeps the dark sky.
// Falls back to a plain gradient when WebGL is unavailable or the user prefers reduced motion.
export function AuroraOrb({ waves = 'two', palette = 'brand', className = '' }: { waves?: WaveVariant | 'none'; palette?: AuroraPalette; className?: string }) {
  const sky = useRef<HTMLCanvasElement>(null);
  const ring = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const stops: Array<() => void> = [];
    try { if (sky.current) stops.push(mountAurora(sky.current, { palette })); } catch { /* keep the CSS fallback */ }
    if (ring.current && waves !== 'none') stops.push(mountWaves(ring.current, { variant: waves }));
    return () => stops.forEach((stop) => stop());
  }, [waves, palette]);

  return (
    <span className={`k-orb ${className}`.trim()} aria-hidden="true">
      {waves !== 'none' && <canvas ref={ring} className="k-orb-waves" />}
      <canvas ref={sky} className="k-orb-sky" />
    </span>
  );
}
