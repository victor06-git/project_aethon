// The 3D Financial City: live scene first, then the timeline strip, then scenario controls.
// Used at the top of the Invest tab. Numbers come from the engine (/api/coach/scenarios/:id/at).
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { CityPoint, Scenario, Suggestion } from '../../../../backend/src/domain/types';
import { useData, useModel } from '../../models/hooks';
import { isError } from '../../models/phoneModel';
import { useNav } from '../../controllers/nav';
import { Failed, Loading, Section } from '../components';
import { Icon } from '../icons';
import { City3D, BUILDINGS } from './city3d';

const MAX_DAY = 365;
const PX_PER_DAY = 6;

export function readout(days: number): string {
  if (days === 0) return 'Today';
  if (days < 14) return `In ${days} day${days === 1 ? '' : 's'}`;
  if (days < 60) return `In ${Math.round(days / 7)} weeks`;
  if (days < 360) return `In ${Math.round(days / 30)} months`;
  return 'In 1 year';
}

// Scale reference shared by every scene on screen, so heights compare honestly.
export function maxRefOf(scenarios: Scenario[]): number {
  let m = 1;
  for (const sc of scenarios) for (const b of BUILDINGS) m = Math.max(m, sc.city.start[b.key], sc.city.later[b.key]);
  return m;
}

export function CityView({ scenarioId, children }: { scenarioId: string | null; children?: ReactNode }) {
  const model = useModel();
  const nav = useNav();
  const list = useData<Scenario[]>('/api/coach/scenarios');
  const tips = useData<Suggestion[]>('/api/coach/suggestions');
  const [days, setDaysState] = useState(model.city.days);
  const [compare, setCompareState] = useState(model.city.compare);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cityRef = useRef<City3D | null>(null);
  const drag = useRef<{ x: number; t: number; acc: number } | null>(null);

  const ready = Array.isArray(list) && list.length > 0;
  const sc = ready ? list.find((s) => s.id === scenarioId) ?? list[0] : null;
  const setDays = (d: number) => { const v = Math.max(0, Math.min(MAX_DAY, d)); model.city.days = v; setDaysState(v); };
  const setCompare = (id: string) => { model.city.compare = id; setCompareState(id); };
  const cmp = compare && sc && compare !== sc.id ? compare : '';

  // Renderer lives as long as the canvas; heights carry over between visits.
  useEffect(() => {
    if (!canvasRef.current) return;
    const city = new City3D(canvasRef.current);
    if (model.city.anim) city.anim = model.city.anim;
    cityRef.current = city;
    const onResize = () => { city.resize(); city.draw(); };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); model.city.anim = city.anim; city.destroy(); };
  }, [ready, model]);

  // Paint whenever the scenario, the comparison or the timeline position changes.
  useEffect(() => {
    if (!ready || !sc || !cityRef.current) return;
    let stale = false;
    const ids = [sc.id, ...(cmp ? [cmp] : [])];
    const scs = ids.map((id) => list.find((s) => s.id === id)!);
    const maxRef = maxRefOf(scs);
    Promise.all(ids.map((id) => model.fetch<CityPoint>(`/api/coach/scenarios/${id}/at?day=${days}`))).then((vals) => {
      if (stale || !cityRef.current) return;
      cityRef.current.setScenes(vals.map((v, i) => ({ title: ids.length > 1 ? scs[i].title : '', values: v.values, confidence: v.confidence, maxRef })));
    });
    return () => { stale = true; };
  }, [ready, sc?.id, cmp, days, list, model]);

  if (!list) return <Loading />;
  if (isError(list)) return <Failed message={list.__error} />;
  if (!sc) return <Failed message="No scenarios" />;

  // Drag the strip: drag right = time moves forward; slow = days, fast = weeks and months.
  const onDown = (e: PointerEvent<HTMLDivElement>) => { drag.current = { x: e.clientX, t: performance.now(), acc: 0 }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    const dx = e.clientX - d.x;
    const v = Math.abs(dx) / Math.max(1, now - d.t);
    d.acc += dx * (v > 1.4 ? 3 : v > 0.6 ? 0.8 : 0.18);
    d.x = e.clientX; d.t = now;
    const step = Math.trunc(d.acc);
    if (step) { d.acc -= step; setDays(model.city.days + step); }
  };
  const onUp = () => { drag.current = null; };

  const ticks: ReactNode[] = [];
  for (let d = 0; d <= MAX_DAY; d += 7) ticks.push(<i key={`d${d}`} style={{ left: d * PX_PER_DAY }} className={d % 28 === 0 ? 'm' : ''} />);
  for (let m = 1; m <= 12; m++) ticks.push(<b key={`m${m}`} style={{ left: m * 30 * PX_PER_DAY }}>{m}m</b>);
  for (const ev of sc.events) ticks.push(<em key={`e${ev.day}`} style={{ left: ev.day * PX_PER_DAY }} title={ev.label} />);

  return (
    <div className="city-page">
      <div className="city-stage">
        <canvas className="city-canvas" ref={canvasRef} title="Drag to rotate the city" />
        {/* In side-by-side comparison each half carries its own title, so the caption steps aside. */}
        {!cmp && <div className="city-caption" title={sc.summary}><b>{sc.headline}</b><span>{sc.range}</span></div>}
        <div className="city-readout">{readout(days)}</div>
      </div>
      <div className="timeline" tabIndex={0} role="slider" aria-label="Timeline" aria-valuemin={0} aria-valuemax={MAX_DAY} aria-valuenow={days}
        title="Drag right to move forward in time. Drag fast to jump weeks and months. Arrow keys also work."
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onKeyDown={(e) => {
          const step = ({ ArrowRight: 1, ArrowLeft: -1, PageUp: 30, PageDown: -30 } as Record<string, number>)[e.key];
          if (step) { e.preventDefault(); setDays(days + step); }
        }}>
        <div className="tl-track" style={{ transform: `translateX(${-days * PX_PER_DAY}px)` }}>{ticks}</div>
        <div className="tl-now" />
      </div>
      <div className="content city-info">
        <div className="city-controls">
          <label><span className="formlabel">Scenario</span>
            <select className="field" value={sc.id} onChange={(e) => { if (compare === e.target.value) setCompare(''); nav.setArg(e.target.value); }}>
              {list.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select></label>
          <label><span className="formlabel">Compare with</span>
            <select className="field" value={cmp} onChange={(e) => setCompare(e.target.value)}>
              <option value="">No comparison</option>
              {list.filter((s) => s.id !== sc.id).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select></label>
        </div>
        {sc.events.length > 0 && (
          <div className="events">{sc.events.map((ev) => (
            <div key={ev.day} className={`ev${days >= ev.day ? ' past' : ''}`}><span>{readout(ev.day)}</span>{ev.label}</div>
          ))}</div>
        )}
        {Array.isArray(tips) && tips.length > 0 && (
          <>
            <Section title="Questions for you" />
            <div className="list">{tips.map((q) => (
              <button key={q.id} type="button" className="row click" onClick={() => nav.ask(q.text)}>
                <span className="glyph"><Icon name="kaiku" size={20} /></span>
                <div className="rmain"><div className="rtitle">{q.text}</div>{q.note && <div className="rsub">{q.note}</div>}</div>
                <span className="chev">›</span>
              </button>))}
            </div>
          </>
        )}
        {children}
      </div>
    </div>
  );
}
