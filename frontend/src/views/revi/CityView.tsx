// The 3D Financial City: live scene first, then the timeline strip, then the events.
// Opened as its own screen with one scenario. Numbers come from the engine (/api/coach/scenarios/:id/at).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { CityPoint, Scenario, Suggestion } from '../../../../backend/src/domain/types';
import { useData, useModel } from '../../models/hooks';
import { isError } from '../../models/phoneModel';
import { useNav } from '../../controllers/nav';
import { Failed, Loading, Section } from '../components';
import { Icon } from '../icons';
import { City3D, BUILDINGS } from './city3d';

const MAX_DAY = 365;
const PX_PER_DAY = 6;
const FRICTION_MS = 320;          // momentum decay after a fling
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const clampDay = (v: number) => Math.max(0, Math.min(MAX_DAY, v));

// Lets a fast-changing value through at most once per `ms` (the latest one wins).
function useThrottled<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + ms - performance.now());
    const t = setTimeout(() => { last.current = performance.now(); setOut(value); }, wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

// Month starts and labels for the coming year, counted from today.
function monthMarks(): { day: number; label: string }[] {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const marks: { day: number; label: string }[] = [];
  for (let i = 1; i <= 13; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const day = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (day > MAX_DAY) break;
    marks.push({ day, label: d.getMonth() === 0 ? `${MONTHS[0]} ${d.getFullYear()}` : MONTHS[d.getMonth()] });
  }
  return marks;
}

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cityRef = useRef<City3D | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // Position is a float in days, moved straight on the DOM every frame; React only hears whole days.
  const pos = useRef(model.city.days);
  const motion = useRef({ dragging: false, x: 0, t: 0, vel: 0, raf: 0 });

  const ready = Array.isArray(list) && list.length > 0;
  const sc = ready ? list.find((s) => s.id === scenarioId) ?? list[0] : null;
  const setDays = (d: number) => { const v = clampDay(d); model.city.days = v; setDaysState(v); };
  const sceneDay = useThrottled(days, 60);
  const marks = useMemo(monthMarks, []);

  const place = (v: number) => {
    const c = clampDay(v);
    pos.current = c;
    if (trackRef.current) trackRef.current.style.transform = `translate3d(${-c * PX_PER_DAY}px, 0, 0)`;
    stripRef.current?.style.setProperty('--past', `${c * PX_PER_DAY}px`);
    const d = Math.round(c);
    if (d !== model.city.days) setDays(d);
    return c;
  };
  const stopGlide = () => { cancelAnimationFrame(motion.current.raf); motion.current.raf = 0; };
  // Smooth glide to a target (keys) or a coasting fling (vel in days per ms) that slows down.
  const glide = (target: number | null) => {
    stopGlide();
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(48, now - last); last = now;
      const m = motion.current;
      let next: number;
      if (target !== null) {
        next = pos.current + (target - pos.current) * (1 - Math.exp(-dt / 90));
        if (Math.abs(target - next) < 0.02) next = target;
      } else {
        next = pos.current + m.vel * dt;
        m.vel *= Math.exp(-dt / FRICTION_MS);
      }
      const placed = place(next);
      const done = target !== null ? placed === target : Math.abs(m.vel) < 0.0015 || placed === 0 || placed === MAX_DAY;
      m.raf = done ? 0 : requestAnimationFrame(step);
    };
    motion.current.raf = requestAnimationFrame(step);
  };

  useLayoutEffect(() => { place(pos.current); }, [ready]);
  useEffect(() => stopGlide, []);
  // Trackpad: horizontal swipes move time too (vertical scrolling of the page is left alone).
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!dx) return;
      e.preventDefault(); stopGlide();
      place(pos.current + dx / PX_PER_DAY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ready]);

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

  // Paint whenever the scenario or the timeline position changes.
  useEffect(() => {
    if (!ready || !sc || !cityRef.current) return;
    let stale = false;
    const maxRef = maxRefOf([sc]);
    model.fetch<CityPoint>(`/api/coach/scenarios/${sc.id}/at?day=${sceneDay}`).then((v) => {
      if (stale || !cityRef.current) return;
      cityRef.current.setScenes([{ title: '', values: v.values, confidence: v.confidence, maxRef }]);
    });
    return () => { stale = true; };
  }, [ready, sc?.id, sceneDay, model]);

  if (!list) return <Loading />;
  if (isError(list)) return <Failed message={list.__error} />;
  if (!sc) return <Failed message="No scenarios" />;

  // Drag the strip: drag right = time moves forward. The strip follows the finger when slow;
  // the faster the drag, the more days each pixel covers (weeks, then months). Release coasts.
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    stopGlide();
    Object.assign(motion.current, { dragging: true, x: e.clientX, t: performance.now(), vel: 0 });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const m = motion.current;
    if (!m.dragging) return;
    const now = performance.now();
    const dt = Math.max(1, now - m.t);
    const dx = e.clientX - m.x;
    const speed = Math.abs(dx) / dt;                           // px per ms
    const gain = 1 + Math.min(14, speed * speed * 5);
    const dDays = (dx / PX_PER_DAY) * gain;
    place(pos.current + dDays);
    m.vel = 0.75 * m.vel + 0.25 * (dDays / dt);                // smoothed days per ms
    m.x = e.clientX; m.t = now;
  };
  const onUp = () => {
    const m = motion.current;
    if (!m.dragging) return;
    m.dragging = false;
    if (performance.now() - m.t < 80 && Math.abs(m.vel) > 0.01) glide(null);
  };

  return (
    <div className="city-page">
      <div className="city-stage">
        <canvas className="city-canvas" ref={canvasRef} title="Drag to rotate the city" />
        <div className="city-caption" title={sc.summary}><b>{sc.headline}</b><span>{sc.range}</span></div>
        <div className="city-readout">{readout(days)}</div>
      </div>
      <div ref={stripRef} className="timeline" tabIndex={0} role="slider" aria-label="Timeline" aria-valuemin={0} aria-valuemax={MAX_DAY} aria-valuenow={days}
        title="Drag right to move forward in time. Drag fast to jump weeks and months. Arrow keys also work."
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onKeyDown={(e) => {
          const step = ({ ArrowRight: 1, ArrowLeft: -1, PageUp: 30, PageDown: -30 } as Record<string, number>)[e.key];
          if (step) { e.preventDefault(); glide(clampDay(Math.round(pos.current) + step)); }
        }}>
        <div className="tl-past" />
        <div ref={trackRef} className="tl-track" style={{ width: MAX_DAY * PX_PER_DAY }}>
          <span className="tl-days" />
          <span className="tl-today"><b>Today</b></span>
          {marks.map((mk) => <span key={mk.day} className="tl-month" style={{ left: mk.day * PX_PER_DAY }}><b>{mk.label}</b></span>)}
          {sc.events.map((ev) => <em key={`e${ev.day}`} style={{ left: ev.day * PX_PER_DAY }} title={`${readout(ev.day)}: ${ev.label}`} />)}
        </div>
        <div className="tl-now" />
      </div>
      <div className="content city-info">
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
                <span className="glyph"><Icon name="revi" size={20} /></span>
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
