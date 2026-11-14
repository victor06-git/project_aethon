// Trainer screens: the three baskets with tap-to-correct lines and the safe-to-spend math,
// and the plan screen with what-if sliders, scenario comparison and the agreed plan tracker.
import { useCallback, useEffect, useState } from 'react';
import type { Answer } from '../../../../backend/src/domain/types';
import { CUT_GROUPS, type CashLine, type GoalDraft, type GoalScenario, type LineBasis, type Monitoring, type SpendingCut } from '../../../../backend/src/domain/trainer';
import { useModel } from '../../models/hooks';
import { isError, type CashflowView } from '../../models/phoneModel';
import { useNav } from '../../controllers/nav';
import { money, shortDate } from '../format';
import { Btn, Card, Failed, List, Loading, Section } from '../components';
import { Markdown } from './Markdown';
import { BasketBar, BriefCard, Choices, Fixes, GoalCosts, GoalOptions, MathSteps, NextStepCard, PlanCard, STATUS_LABEL, ScenarioCards, Sources } from './TrainerCards';

const BASIS_TEXT: Record<LineBasis, string> = {
  recurring: 'every month', assumed: 'assumed monthly: check', average: 'monthly average', corrected: 'set by you'
};
const BASKET_CHOICES = [
  { value: 'regular', label: 'Regular' }, { value: 'irregular', label: 'Irregular' },
  { value: 'everyday', label: 'Everyday' }, { value: 'one_off', label: 'One-off' }
];
const SLIDER = { months: { min: 1, max: 60 }, step: 5, startCut: 20 };
const LOAN = { step: 100, maxYears: 15, maxRate: 30 };
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

function Slider({ label, value, unit = '', min, max, step, disabled, show, onChange, onCommit }: {
  label: string; value: number; unit?: string; min: number; max: number; step: number;
  disabled: boolean; show?: (v: number) => string; onChange: (v: number) => void; onCommit: () => void;
}) {
  return (
    <label className="t-slider">
      <span>{label}<b>{show ? show(value) : `${value}${unit}`}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} onPointerUp={onCommit} onKeyUp={onCommit} />
    </label>
  );
}

type Change = (args: Record<string, unknown>) => void;
const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0];
const nameOf = (group: string) => (group === 'everyday' ? 'All everyday spending' : CUT_GROUPS[group]?.label ?? group);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// The user's own everyday spending, by category: what they could choose to spend less on.
function everydayOf(flow: CashflowView) {
  const lines = flow.baskets.find((b) => b.basket === 'everyday')?.lines ?? [];
  const byCategory = new Map<string, number>();
  for (const l of lines) byCategory.set(l.category, (byCategory.get(l.category) ?? 0) + l.monthly);
  const categories = [...byCategory].map(([name, monthly]) => ({ name, monthly })).sort((a, b) => b.monthly - a.monthly);
  const total = lines.reduce((sum, l) => sum + l.monthly, 0);
  const spentOn = (group: string) => {
    if (group === 'everyday') return total;
    const matches = (l: CashLine) => (CUT_GROUPS[group] ? CUT_GROUPS[group].match.test(`${l.label} ${l.category}`) : l.category.toLowerCase() === group.toLowerCase());
    return lines.filter(matches).reduce((sum, l) => sum + l.monthly, 0);
  };
  return { categories, total, spentOn };
}

function CutRow({ cut, spent, busy, onChange }: { cut: SpendingCut; spent: number; busy: boolean; onChange: Change }) {
  const [pct, setPct] = useState(cut.pct);
  useEffect(() => setPct(cut.pct), [cut.pct]);
  return (
    <div className="t-cut">
      <div className="t-cut-head">
        <b>{capital(nameOf(cut.group))}</b>
        <span>{money(spent, 0)} a month now</span>
        <button type="button" disabled={busy} aria-label={`Stop cutting ${nameOf(cut.group)}`} onClick={() => onChange({ cut_group: cut.group, cut_pct: 0 })}>Remove</button>
      </div>
      <Slider label="Spend less" value={pct} min={SLIDER.step} max={100} step={SLIDER.step} disabled={busy}
        show={(v) => `${v}% · saves ${money((spent * v) / 100, 0)} a month`} onChange={setPct}
        onCommit={() => { if (pct !== cut.pct) onChange({ cut_group: cut.group, cut_pct: pct }); }} />
    </div>
  );
}

// "I could spend less on…": any category of the user's own spending, as many as they like.
function CutEditor({ goal, flow, freed, busy, onChange }: { goal: GoalDraft; flow: CashflowView; freed: number; busy: boolean; onChange: Change }) {
  const { categories, total, spentOn } = everydayOf(flow);
  const taken = new Set(goal.cuts.map((c) => c.group.toLowerCase()));
  const open = categories.filter((c) => !taken.has(c.name.toLowerCase()));
  return (
    <div className="t-cuts">
      <div className="t-sub">What could you spend less on?</div>
      {!goal.cuts.length && <p className="foot">Pick anything from your own spending. You know best what is worth keeping.</p>}
      {goal.cuts.map((c) => <CutRow key={c.group} cut={c} spent={spentOn(c.group)} busy={busy} onChange={onChange} />)}
      <div className="t-add">
        {open.map((c) => (
          <button key={c.name} type="button" disabled={busy} onClick={() => onChange({ cut_group: c.name, cut_pct: SLIDER.startCut })}>+ {c.name}<span>{money(c.monthly, 0)}/mo</span></button>
        ))}
        {!taken.has('everyday') && <button type="button" disabled={busy} onClick={() => onChange({ cut_group: 'everyday', cut_pct: SLIDER.startCut })}>+ Everything<span>{money(total, 0)}/mo</span></button>}
      </div>
      {freed > 0 && <p className="t-freed">Together this frees about <b>{money(freed, 0)}</b> a month.</p>}
    </div>
  );
}

// A loan is only an option. It says why it appears, what it costs, and where its rate comes from.
function LoanPanel({ goal, scenarios, busy, onChange }: { goal: GoalDraft; scenarios: GoalScenario[]; busy: boolean; onChange: Change }) {
  const plan = scenarios[0];
  const loan = goal.loan;
  const borrowed = plan.loan?.amount ?? 0;
  const toSave = plan.monthlyNeeded * plan.months + borrowed;
  const max = Math.max(LOAN.step, Math.ceil(toSave / LOAN.step) * LOAN.step);
  const [amount, setAmount] = useState(borrowed);
  const [years, setYears] = useState(loan?.years ?? 5);
  const [rate, setRate] = useState(String(loan?.ratePct ?? ''));
  useEffect(() => { setAmount(borrowed); setYears(loan?.years ?? 5); setRate(String(loan?.ratePct ?? '')); }, [borrowed, loan?.years, loan?.ratePct]);

  if (!loan) {
    const short = plan.gap > 0;
    return (
      <div className="t-loan">
        <div className="t-sub">Borrow part of it?</div>
        <p>{short ? `Saving alone leaves you ${money(plan.gap, 0)} a month short. A loan could cover some of that, but you pay interest on it.`
          : 'You can reach this by saving alone, so you do not need a loan. You can still see what one would cost.'} It is only an option: Revi has not chosen it for you.</p>
        <button type="button" disabled={busy} onClick={() => onChange({ loan: true })}>Show me a loan option</button>
      </div>
    );
  }
  const commitRate = () => { const r = Number(rate); if (rate !== '' && Number.isFinite(r) && r >= 0 && r !== loan.ratePct) onChange({ loan_rate_pct: r }); };
  return (
    <div className="t-loan">
      <div className="t-sub">Borrow part of it?</div>
      <Slider label="How much to borrow" value={amount} min={0} max={max} step={LOAN.step} disabled={busy} show={(v) => money(v, 0)} onChange={setAmount}
        onCommit={() => { if (amount !== borrowed) onChange({ loan_amount: amount }); }} />
      <Slider label="Over how many years" value={years} unit=" years" min={1} max={LOAN.maxYears} step={1} disabled={busy} onChange={setYears}
        onCommit={() => { if (years !== loan.years) onChange({ loan_years: years }); }} />
      <label className="t-rate">Yearly interest (%)
        <input type="number" inputMode="decimal" min={0} max={LOAN.maxRate} step={0.1} value={rate} disabled={busy}
          onChange={(e) => setRate(e.target.value)} onBlur={commitRate} onKeyDown={(e) => { if (e.key === 'Enter') commitRate(); }} />
      </label>
      <p className="foot">
        {loan.rateSource === 'research' && loan.rateUrl ? <>Rate found by Exa on <a href={loan.rateUrl} target="_blank" rel="noopener noreferrer">{host(loan.rateUrl)}</a>. Your own offer may differ.</>
          : loan.rateSource === 'user' ? 'The rate you entered.' : 'My assumption, not an offer. Ask S-Pankki for your real rate.'}
      </p>
      <p className="t-loan-result">{plan.loan
        ? <>You pay <b>{money(plan.loan.payment, 0)}</b> a month for {loan.years} years, and <b>{money(plan.loan.totalInterest, 0)}</b> in interest on top.</>
        : 'At this amount you are not borrowing anything.'}</p>
      <button type="button" disabled={busy} onClick={() => onChange({ loan: false })}>No loan</button>
    </div>
  );
}

// Everything the user can change about a goal: when, what to spend less on, and whether to borrow.
function PlanControls({ goal, flow, scenarios, busy, onChange }: { goal: GoalDraft; flow: CashflowView | null; scenarios: GoalScenario[]; busy: boolean; onChange: Change }) {
  const [months, setMonths] = useState(goal.months);
  useEffect(() => setMonths(goal.months), [goal.months]);
  const freed = Math.max(0, scenarios[0].monthlyCapacity - (scenarios.find((s) => s.id === 'current')?.monthlyCapacity ?? scenarios[0].monthlyCapacity));
  return (
    <Card padded>
      <Slider label="When do you want it?" value={months} unit=" months" min={SLIDER.months.min} max={Math.max(SLIDER.months.max, goal.months)} step={1}
        disabled={busy} onChange={setMonths} onCommit={() => { if (months !== goal.months) onChange({ months }); }} />
      {flow && <CutEditor goal={goal} flow={flow} freed={freed} busy={busy} onChange={onChange} />}
      <LoanPanel goal={goal} scenarios={scenarios} busy={busy} onChange={onChange} />
    </Card>
  );
}

export function PlanScreen() {
  const model = useModel();
  const nav = useNav();
  const { run, error, busy } = useTool();
  const { draft, plan } = model.trainer;
  const flowNow = model.cashflow();
  const flow = flowNow && !isError(flowNow) ? flowNow : null;
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
          {!draft.confirmed ? (
            <BriefCard key={`${draft.price}-${draft.months}`} goal={draft} busy={busy}
              onConfirm={() => { void act('confirm_brief'); }} onChange={(change) => { void act('what_if', change); }} />
          ) : (
            <>
              {answer?.fixes && answer.fixes.length > 0 && (
                <>
                  <Section title="Ways to close the gap" />
                  <Fixes fixes={answer.fixes} busy={busy} onPick={(f) => { void act('what_if', f.args); }} />
                </>
              )}
              {answer?.scenarios && (
                <>
                  <Section title="Compare" />
                  <ScenarioCards scenarios={answer.scenarios} />
                </>
              )}
              {answer?.scenarios && (
                <>
                  <Section title="Play with your plan" />
                  <PlanControls goal={draft} flow={flow} scenarios={answer.scenarios} busy={busy} onChange={(args) => { void act('what_if', args); }} />
                </>
              )}
            </>
          )}
        </>
      )}

      {answer?.scenarios && !draft && (
        <>
          <Section title="Where you stand today" />
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
