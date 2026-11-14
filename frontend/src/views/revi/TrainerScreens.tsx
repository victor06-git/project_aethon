// Trainer screens: the three baskets with tap-to-correct lines and the safe-to-spend math,
// and the plan screen with what-if sliders, scenario comparison and the agreed plan tracker.
import { useCallback, useEffect, useState } from 'react';
import type { Answer } from '../../../../backend/src/domain/types';
import type { CashLine, GoalDraft, LineBasis, Monitoring } from '../../../../backend/src/domain/trainer';
import { useModel } from '../../models/hooks';
import { isError } from '../../models/phoneModel';
import { useNav } from '../../controllers/nav';
import { money, shortDate } from '../format';
import { Btn, Card, Failed, List, Loading, Section } from '../components';
import { Markdown } from './Markdown';
import { BasketBar, Choices, GoalCosts, GoalOptions, MathSteps, NextStepCard, PlanCard, STATUS_LABEL, ScenarioCards, Sources } from './TrainerCards';

const BASIS_TEXT: Record<LineBasis, string> = {
  recurring: 'every month', assumed: 'assumed monthly: check', average: 'monthly average', corrected: 'set by you'
};
const BASKET_CHOICES = [
  { value: 'regular', label: 'Regular' }, { value: 'irregular', label: 'Irregular' },
  { value: 'everyday', label: 'Everyday' }, { value: 'one_off', label: 'One-off' }
];
const SLIDER = { months: { min: 1, max: 60 }, dining: { max: 50 }, everyday: { max: 30 }, step: 5 };
const DISCLAIMER = 'Estimates from your own transactions and the assumptions shown. You decide.';
const MONITORS: { key: keyof Monitoring; label: string }[] = [
  { key: 'prices', label: 'Prices of what I am saving for' },
  { key: 'conditions', label: 'Loan and insurance conditions' },
  { key: 'spending', label: 'My own spending' }
];
const watching = (m: Monitoring) => m.prices || m.conditions || m.spending;

// Runs one trainer tool from a control and keeps its error and busy state for the screen.
function useTool() {
  const model = useModel();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (name: string, args: Record<string, unknown> = {}): Promise<Answer | null> => {
    setBusy(true);
    setError(null);
    try {
      return await model.apply(name, args);
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }, [model]);
  return { run, error, busy };
}

function LineRow({ line, busy, onMove }: { line: CashLine; busy: boolean; onMove: (basket: string) => void }) {
  return (
    <div className="row t-line">
      <div className="rmain">
        <div className="rtitle">{line.label}{line.basis === 'assumed' && <span className="tag check">check</span>}</div>
        <div className="rsub">{line.category} · {BASIS_TEXT[line.basis]}</div>
      </div>
      <div className="amount">{line.basket === 'oneoff' ? money(line.total, 0) : `${money(line.monthly, 0)}/mo`}</div>
      <select className="t-move" aria-label={`Basket for ${line.label}`} value={line.basket === 'oneoff' ? 'one_off' : line.basket}
        disabled={busy} onChange={(e) => onMove(e.target.value)}>
        {BASKET_CHOICES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function CashflowScreen() {
  const model = useModel();
  const nav = useNav();
  const { run, error, busy } = useTool();
  const flow = model.cashflow();
  if (!flow) return <Loading />;
  if (isError(flow)) return <Failed message={flow.__error} />;
  const move = (line: CashLine) => (basket: string) => { void run('reclassify', { line_id: line.id, basket }); };
  return (
    <div className="content">
      <div className="title">Your three baskets</div>
      <div className="hero">
        <div className="small">Safe to spend this week</div>
        <strong>{money(flow.safe.week, 0)}</strong>
        <div className="side"><span>Safe to save this month</span><b>{money(flow.safeToSave, 0)}</b></div>
      </div>
      <label className="t-toggle">
        <input type="checkbox" checked={model.trainer.multiBank} disabled={busy} onChange={(e) => { void run('set_multibank', { on: e.target.checked }); }} />
        <span>Include my accounts at other banks (PSD2 demo)</span>
      </label>
      {error && <div className="warn" role="alert">{error}</div>}
      <Card padded>
        <BasketBar baskets={flow.baskets} />
        <p className="foot">About {money(flow.income, 0)} comes in each month. Averages use the last {flow.periodDays} days.</p>
      </Card>

      <Section title="How safe-to-spend is worked out" />
      <Card padded><MathSteps steps={flow.safe.steps} /></Card>

      {flow.baskets.map((b) => (
        <div key={b.basket}>
          <div className="section-title"><span><i className={`dot ${b.basket}`} /> {b.label}</span><span>{money(b.monthly, 0)}/mo</span></div>
          <p className="foot t-hint">{b.hint}. Wrong basket? Change it on the line.</p>
          <List>
            {b.lines.map((l) => <LineRow key={l.id} line={l} busy={busy} onMove={move(l)} />)}
            {!b.lines.length && <div className="row"><span className="muted">Nothing here.</span></div>}
          </List>
        </div>
      ))}
      {flow.oneOffs.length > 0 && (
        <>
          <Section title="One-offs (not counted each month)" />
          <List>{flow.oneOffs.map((l) => <LineRow key={l.id} line={l} busy={busy} onMove={move(l)} />)}</List>
        </>
      )}
      <Btn label="Ask Revi to explain" primary block onClick={() => nav.ask('Where did my money go?')} />
      <p className="foot">{flow.disclaimer}</p>
    </div>
  );
}

function Slider({ label, value, unit, min, max, step, disabled, onChange, onCommit }: {
  label: string; value: number; unit: string; min: number; max: number; step: number;
  disabled: boolean; onChange: (v: number) => void; onCommit: () => void;
}) {
  return (
    <label className="t-slider">
      <span>{label}<b>{value}{unit}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} onPointerUp={onCommit} onKeyUp={onCommit} />
    </label>
  );
}

// What-if sliders: the value follows the finger, the plan is recalculated on release.
function GoalSliders({ goal, busy, onChange }: { goal: GoalDraft; busy: boolean; onChange: (args: Record<string, unknown>) => void }) {
  const cutOf = (group: string) => goal.cuts.find((c) => c.group === group)?.pct ?? 0;
  const [months, setMonths] = useState(goal.months);
  const [dining, setDining] = useState(cutOf('dining'));
  const [everyday, setEveryday] = useState(cutOf('everyday'));
  useEffect(() => { setMonths(goal.months); setDining(cutOf('dining')); setEveryday(cutOf('everyday')); }, [goal]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card padded>
      <Slider label="Time until you buy" value={months} unit=" months" min={SLIDER.months.min} max={Math.max(SLIDER.months.max, goal.months)} step={1}
        disabled={busy} onChange={setMonths} onCommit={() => { if (months !== goal.months) onChange({ months }); }} />
      <Slider label="Cut eating out" value={dining} unit="%" min={0} max={SLIDER.dining.max} step={SLIDER.step}
        disabled={busy} onChange={setDining} onCommit={() => { if (dining !== cutOf('dining')) onChange({ cut_group: 'dining', cut_pct: dining }); }} />
      <Slider label="Cut all everyday spending" value={everyday} unit="%" min={0} max={SLIDER.everyday.max} step={SLIDER.step}
        disabled={busy} onChange={setEveryday} onCommit={() => { if (everyday !== cutOf('everyday')) onChange({ cut_group: 'everyday', cut_pct: everyday }); }} />
      <label className="t-toggle">
        <input type="checkbox" checked={goal.loan !== null} disabled={busy} onChange={(e) => onChange({ loan: e.target.checked })} />
        <span>Pay the rest with a loan{goal.loan ? ` (${goal.loan.years} years at ${goal.loan.ratePct}%)` : ''}</span>
      </label>
    </Card>
  );
}

export function PlanScreen() {
  const model = useModel();
  const nav = useNav();
  const { run, error, busy } = useTool();
  const { draft, plan } = model.trainer;
  const [answer, setAnswer] = useState<Answer | null>(null);
  const act = useCallback(async (name: string, args: Record<string, unknown> = {}) => {
    const a = await run(name, args);
    if (a) setAnswer(a);
  }, [run]);

  // On opening: the scenarios for the goal in progress, or (with the user's permission) a fresh check of the plan.
  useEffect(() => {
    if (draft) void act('get_plan');
    else if (plan) void act(watching(plan.monitor) ? 'recheck_plan' : 'get_plan');
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!draft && !plan) {
    return (
      <div className="content">
        <div className="title">Plan a goal</div>
        <Card padded><p className="t-empty">Thinking about something big? Ask Revi and see what it really costs, how long it takes and what you would give up for it.</p></Card>
        <Btn label="Could I buy a car next year?" primary block onClick={() => nav.ask('Could I buy a car next year?')} />
        <Btn label="Could I afford a €3,000 trip in 8 months?" block onClick={() => nav.ask('Could I afford a €3,000 trip in 8 months?')} />
      </div>
    );
  }
  const goal = draft ?? plan!.goal;
  return (
    <div className="content">
      <div className="title">{draft ? `What if: ${draft.name}` : 'Your agreed plan'}</div>
      {error && <div className="warn" role="alert">{error}</div>}

      {plan && !draft && (
        <>
          <PlanCard plan={plan} />
          {plan.lastCheck && (
            <Card padded>
              <b>{STATUS_LABEL[plan.lastCheck.status]}</b>
              <ul className="t-changes">{plan.lastCheck.changes.map((c) => <li key={c}>{c}</li>)}</ul>
              <p className="foot">Checked {shortDate(plan.lastCheck.checkedOn)}</p>
            </Card>
          )}
          <div className="actions">
            <Btn label={busy ? 'Checking…' : 'Re-check plan'} primary onClick={() => { void act('recheck_plan'); }} />
            <Btn label="Adjust" onClick={() => { void act('what_if'); }} />
          </div>
          {answer?.choices && answer.choices.length > 0 && (
            <>
              <Section title="Something changed: your choice" />
              <Choices choices={answer.choices} busy={busy} onPick={(c) => { void act('choose_path', { id: c.id }); }} />
            </>
          )}
          <Section title="What Revi may keep an eye on" />
          {MONITORS.map((m) => (
            <label key={m.key} className="t-toggle">
              <input type="checkbox" checked={plan.monitor[m.key]} disabled={busy} onChange={(e) => { void act('set_monitoring', { [m.key]: e.target.checked }); }} />
              <span>{m.label}</span>
            </label>
          ))}
          <p className="foot t-hint">Checked each time you open this screen, never in the background.</p>
        </>
      )}

      {draft && (
        <>
          {answer && <Card padded><Markdown text={answer.text} /></Card>}
          {!draft.confirmed && draft.price > 0 && <Btn label="Yes, that is right" primary block onClick={() => { void act('confirm_brief'); }} />}
          <Section title={draft.confirmed ? 'Try a change' : 'Change the brief'} />
          <GoalSliders goal={draft} busy={busy} onChange={(args) => { void act('what_if', args); }} />
        </>
      )}

      {answer?.scenarios && (
        <>
          <Section title={draft ? 'Compare' : 'Where you stand today'} />
          <ScenarioCards scenarios={answer.scenarios} />
        </>
      )}
      {answer?.nextStep && <NextStepCard step={answer.nextStep} onGo={(s) => (s.screen ? nav.go(s.screen) : s.ask === 'Agree this plan' ? void act('agree_plan') : s.ask && nav.ask(s.ask))} />}
      {goal.options.length > 0 && <GoalOptions goal={goal} busy={busy} onPick={(i) => { void act('choose_option', { index: i }); }} />}
      <Section title="What it costs" />
      <Card padded><GoalCosts goal={goal} /></Card>
      {answer?.sources && answer.sources.length > 0 && <Sources sources={answer.sources} />}

      {draft && (
        <>
          <div className="actions">
            {draft.confirmed && <Btn label="Agree this plan" primary onClick={() => { void act('agree_plan'); }} />}
            <Btn label={busy ? 'Working…' : 'Research with Exa'} onClick={() => { void act('research_goal'); }} />
          </div>
          <Btn label={plan ? 'Discard changes' : 'Drop this goal'} block onClick={() => model.patchTrainer({ draft: null })} />
        </>
      )}
      <p className="foot">{DISCLAIMER}</p>
    </div>
  );
}
