// Revi header on Home (the integration point): safe-to-spend and safe-to-save at a glance,
// the three baskets as a pill bar, the agreed plan, a way into the assistant and a live
// thumbnail of the 3D Financial City.
import { useEffect, useRef } from 'react';
import type { CityPoint, Scenario } from '../../../../backend/src/domain/types';
import { useData, useModel } from '../../models/hooks';
import { isError } from '../../models/phoneModel';
import { useNav } from '../../controllers/nav';
import { money } from '../format';
import { Icon } from '../icons';
import { City3D } from './city3d';
import { maxRefOf } from './CityView';
import { BasketBar } from './TrainerCards';

export function ReviCard() {
  const nav = useNav();
  const model = useModel();
  const flow = model.cashflow();
  const list = useData<Scenario[]>('/api/coach/scenarios');
  const canvas = useRef<HTMLCanvasElement>(null);
  const ready = Array.isArray(list);
  const shown = !!flow && !isError(flow);

  useEffect(() => {
    if (!ready || !shown || !canvas.current) return;
    let city: City3D | null = null;
    let cancelled = false;
    model.fetch<CityPoint>('/api/coach/scenarios/stop_food/at?day=0').then((v) => {
      if (cancelled || !canvas.current) return;
      city = new City3D(canvas.current, { compact: true });
      city.setScenes([{ values: v.values, confidence: 1, maxRef: maxRefOf(list as Scenario[]) }]);
    });
    return () => { cancelled = true; city?.destroy(); };
  }, [ready, shown, list, model]);

  if (!flow || isError(flow)) return null;
  const plan = model.trainer.plan;
  return (
    <div className="k-card">
      <button type="button" className="k-card-main" onClick={nav.openAssistant}>
        <span className="k-card-label"><Icon name="revi" size={18} /> Revi · your economic trainer</span>
        <span className="k-card-text">Safe to spend this week <b>{money(flow.safe.week, 0)}</b></span>
        <span className="k-card-sub">Safe to save this month <b>{money(flow.safeToSave, 0)}</b></span>
        <span className="k-card-cta">Ask Revi <Icon name="arrow" size={15} /></span>
      </button>
      <button type="button" className="k-card-city" onClick={() => nav.openCity('stop_food')} title="Open the 3D Financial City">
        <canvas ref={canvas} /><span>3D City</span>
      </button>
      <div className="k-card-baskets">
        <BasketBar baskets={flow.baskets} onPick={() => nav.go('cashflow')} />
        <button type="button" className="t-planchip" onClick={() => nav.go('plan')}>
          {plan ? `Plan: ${plan.goal.name}, ${money(plan.monthlySaving, 0)} a month` : model.trainer.draft ? `Exploring: ${model.trainer.draft.name}` : 'Plan a goal'} ›
        </button>
      </div>
    </div>
  );
}
