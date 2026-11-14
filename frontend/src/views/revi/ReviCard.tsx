// Compact Revi card on Home (the integration point): one insight, a way into the
// assistant and a live thumbnail of the 3D Financial City.
import { useEffect, useRef } from 'react';
import type { CityPoint, SafeToSpend, Scenario } from '../../../../backend/src/domain/types';
import { useData, useModel } from '../../models/hooks';
import { isError } from '../../models/phoneModel';
import { useNav } from '../../controllers/nav';
import { Icon } from '../icons';
import { City3D } from './city3d';
import { maxRefOf } from './CityView';

export function ReviCard() {
  const nav = useNav();
  const model = useModel();
  const boot = useData<{ safeToSpend: SafeToSpend }>('/api/bootstrap');
  const list = useData<Scenario[]>('/api/coach/scenarios');
  const canvas = useRef<HTMLCanvasElement>(null);
  const ready = Array.isArray(list);

  useEffect(() => {
    if (!ready || !canvas.current) return;
    let city: City3D | null = null;
    let cancelled = false;
    model.fetch<CityPoint>('/api/coach/scenarios/stop_food/at?day=0').then((v) => {
      if (cancelled || !canvas.current) return;
      city = new City3D(canvas.current, { compact: true });
      city.setScenes([{ values: v.values, confidence: 1, maxRef: maxRefOf(list as Scenario[]) }]);
    });
    return () => { cancelled = true; city?.destroy(); };
  }, [ready, list, model]);

  if (!boot || isError(boot)) return null;
  const s = boot.safeToSpend;
  return (
    <div className="k-card">
      <button type="button" className="k-card-main" onClick={nav.openAssistant}>
        <span className="k-card-label"><Icon name="revi" size={18} /> Revi — Your Financial Echo</span>
        <span className="k-card-text">Safe to spend until {s.until}: <b>€{s.amount}</b></span>
        <span className="k-card-cta">Ask Revi <Icon name="arrow" size={15} /></span>
      </button>
      <button type="button" className="k-card-city" onClick={() => nav.openCity('stop_food')} title="Open the 3D Financial City">
        <canvas ref={canvas} /><span>3D City</span>
      </button>
    </div>
  );
}
