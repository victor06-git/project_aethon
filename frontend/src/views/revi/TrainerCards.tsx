// Cards the trainer answers with, used in the chat and on the trainer screens: the
// safe-to-spend math, the three-baskets pill bar, tap-to-correct assumptions, scenario
// comparison, what a goal costs, web sources and the agreed plan.
import { useState } from 'react';
import type {
  AgreedPlan, BasketTotal, CashLine, FigureSource, GapFix, GoalDraft, GoalScenario, MathStep, NextStep, PlanStatus, Source, TraceStep
} from '../../../../backend/src/domain/trainer';
import { useModel } from '../../models/hooks';
import { money, shortDate } from '../format';

const SOURCE_TAG: Record<FigureSource, string> = { assumption: 'assumption', research: 'from the web', user: 'your figure' };
const CUT_LABEL: Record<string, string> = {
  dining: 'eating out', groceries: 'groceries', taxi: 'taxis', leisure: 'leisure', transport: 'transport', shopping: 'shopping', everyday: 'all everyday spending'
};
const SNIPPET_SHOWN = 180;
export const STATUS_LABEL: Record<PlanStatus, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' };

const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0];
const fullDate = (iso: string) => `${shortDate(iso)} ${iso.slice(0, 4)}`;

export function MathSteps({ steps }: { steps: MathStep[] }) {
  return (
    <div className="t-math">
      {steps.map((s) => (
        <div key={s.label} className={`t-math-row ${s.kind}`}>
          <span>{s.label}</span>
          <b>{s.kind === 'minus' ? `− ${money(Math.abs(s.amount))}` : money(s.amount)}</b>
        </div>
      ))}
    </div>
  );
}

// The three baskets as one pill bar with a legend. With onPick, each basket is a button.
export function BasketBar({ baskets, onPick }: { baskets: BasketTotal[]; onPick?: (basket: string) => void }) {
  const total = baskets.reduce((s, b) => s + b.monthly, 0) || 1;
  return (
    <div className="t-baskets">
      <div className="t-pill">
        {baskets.map((b) => (
          <button key={b.basket} type="button" className={`seg ${b.basket}`} style={{ width: `${(b.monthly / total) * 100}%` }}
            disabled={!onPick} onClick={() => onPick?.(b.basket)} aria-label={`${b.label}: ${money(b.monthly, 0)} a month`} title={b.hint} />
        ))}
      </div>
      <div className="t-legend">
        {baskets.map((b) => (
          <button key={b.basket} type="button" disabled={!onPick} onClick={() => onPick?.(b.basket)} title={b.hint}>
            <i className={`dot ${b.basket}`} /><span>{b.label}</span><b>{money(b.monthly, 0)}</b>
          </button>
        ))}
      </div>
    </div>
  );
}

// Assumptions the trainer made, each with one-tap corrections.
export function ReviewLines({ lines }: { lines: CashLine[] }) {
  const model = useModel();
  const move = (line: CashLine, basket: string, said: string) => model.act(`${line.label} ${said}`, 'reclassify', { line_id: line.id, basket });
  return (
    <div className="t-review">
      {lines.map((l) => (
        <div key={l.id} className="t-review-item">
          <span>I assumed <b>{l.label}</b> ({money(l.lastAmount, 0)}) repeats every month.</span>
          <div className="t-review-actions">
            <button type="button" disabled={model.busy} onClick={() => move(l, 'one_off', 'was a one-off')}>It was a one-off</button>
            <button type="button" disabled={model.busy} onClick={() => move(l, 'regular', 'is a monthly bill')}>Yes, monthly</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function scenarioVerdict(s: GoalScenario): string {
  if (s.feasible) return 'Fits';
  return s.gap > 0 ? `Short ${money(s.gap, 0)}/mo` : 'Too costly to run';
}

export function ScenarioCards({ scenarios }: { scenarios: GoalScenario[] }) {
  return (
    <div className="t-scenarios">
      {scenarios.map((s) => (
        <div key={s.id} className={`t-scenario${s.feasible ? ' ok' : ''}`}>
          <div className="t-scenario-head"><b>{s.label}</b><span className={`t-chip ${s.feasible ? 'ok' : 'alert'}`}>{scenarioVerdict(s)}</span></div>
          <div className="t-scenario-figure">{money(s.monthlyNeeded, 0)}<small> a month for {s.months} months</small></div>
          <dl>
            <div><dt>Needed upfront</dt><dd>{money(s.upfront, 0)}</dd></div>
            <div><dt>You free up</dt><dd>{money(s.monthlyCapacity, 0)} a month</dd></div>
            <div><dt>Ready</dt><dd>{fullDate(s.readyDate)}</dd></div>
            {s.loan && <div><dt>Loan</dt><dd>{money(s.loan.amount, 0)}, {money(s.loan.payment, 0)}/mo</dd></div>}
            {s.afterMonthly > 0 && (
              <div><dt>After buying</dt>
                <dd>{money(s.afterMonthly, 0)}/mo, {s.afterFree >= 0 ? `${money(s.afterFree, 0)} left` : `${money(-s.afterFree, 0)} short`}</dd></div>
            )}
          </dl>
        </div>
      ))}
    </div>
  );
}

// Where a figure comes from. A researched figure links to its source.
function SourceTag({ source, url }: { source: FigureSource; url?: string }) {
  if (source === 'research' && url) return <a className="t-src research" href={url} target="_blank" rel="noopener noreferrer">{host(url)}</a>;
  return <i className={`t-src ${source}`}>{SOURCE_TAG[source]}</i>;
}

// Current options found on the web, each with its source and a way to use its price.
export function GoalOptions({ goal, busy, onPick }: { goal: GoalDraft; busy: boolean; onPick: (index: number) => void }) {
  return (
    <div className="t-options">
      <div className="t-sources-title">Current options (Exa web search)</div>
      {goal.options.map((o, i) => (
        <div key={`${o.name}-${o.price}`} className={`t-option${o.price === goal.price ? ' on' : ''}`}>
          <div><b>{o.name}</b><a href={o.url} target="_blank" rel="noopener noreferrer">{host(o.url)}</a></div>
          <strong>{money(o.price, 0)}</strong>
          <button type="button" disabled={busy || o.price === goal.price} onClick={() => onPick(i)}>{o.price === goal.price ? 'In plan' : 'Use this'}</button>
        </div>
      ))}
    </div>
  );
}

// A prepared next step: one thing the user can do now.
export function NextStepCard({ step, onGo }: { step: NextStep; onGo: (step: NextStep) => void }) {
  return (
    <div className="t-next">
      <div className="t-sources-title">{step.title}</div>
      <div>{step.detail}</div>
      {(step.ask || step.screen) && <button type="button" onClick={() => onGo(step)}>{step.screen ? 'Open transfer' : step.ask}</button>}
    </div>
  );
}

// The user's choices after something changed. The trainer explains; the user decides.
export function Choices<T extends { id: string; label: string; detail: string }>({ choices, busy, onPick }: { choices: T[]; busy: boolean; onPick: (choice: T) => void }) {
  return (
    <div className="t-choices">
      {choices.map((c) => (
        <button key={c.id} type="button" disabled={busy} onClick={() => onPick(c)}><b>{c.label}</b><span>{c.detail}</span></button>
      ))}
    </div>
  );
}

// Ways to close a monthly gap. Each applies a change and shows the result.
export function Fixes({ fixes, busy, onPick }: { fixes: GapFix[]; busy: boolean; onPick: (fix: GapFix) => void }) {
  return <Choices choices={fixes} busy={busy} onPick={onPick} />;
}

// The brief the user confirms. Budget and time are edited here, no typing a sentence needed.
const MONTHS_STEP = 1;
export function BriefCard({ goal, busy, onChange, onConfirm }: {
  goal: GoalDraft; busy: boolean; onChange: (change: { price?: number; months: number }, said: string) => void; onConfirm: () => void;
}) {
  const [price, setPrice] = useState(goal.price > 0 ? String(goal.price) : '');
  const [months, setMonths] = useState(goal.months);
  const budget = Number(price);
  const dirty = (budget > 0 && budget !== goal.price) || months !== goal.months;
  return (
    <div className="t-brief">
      <label>Budget (€)
        <input type="number" inputMode="numeric" min={0} step={100} value={price} placeholder="for example 3000" disabled={busy} onChange={(e) => setPrice(e.target.value)} />
      </label>
      <div className="t-stepper">
        <span>In how many months?</span>
        <div>
          <button type="button" aria-label="One month less" disabled={busy || months <= 1} onClick={() => setMonths(months - MONTHS_STEP)}>−</button>
          <b>{months}</b>
          <button type="button" aria-label="One month more" disabled={busy} onClick={() => setMonths(months + MONTHS_STEP)}>+</button>
        </div>
      </div>
      {dirty
        ? <button type="button" className="t-primary" disabled={busy || !(budget > 0)} onClick={() => onChange({ ...(budget > 0 ? { price: budget } : {}), months }, `${budget > 0 ? `Budget ${money(budget, 0)}, ` : ''}${months} months`)}>Update the brief</button>
        : <button type="button" className="t-primary" disabled={busy || goal.price <= 0} onClick={onConfirm}>Yes, that is right</button>}
    </div>
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

function TraceItem({ step }: { step: TraceStep }) {
  const row = (
    <>
      <i className={`t-mark ${step.status}`} aria-hidden="true" />
      <span className="t-step-title">{step.title}</span>
      {step.ms !== undefined && <em>{seconds(step.ms)}</em>}
    </>
  );
  const more = step.detail || step.items?.length || step.sources?.length;
  if (!more) return <li className={`t-step ${step.status}`}><div className="t-step-row">{row}</div></li>;
  return (
    <li className={`t-step ${step.status}`}>
      <details open={step.status !== 'running' && !!step.sources?.length}>
        <summary className="t-step-row">{row}</summary>
        {step.detail && <p>{step.detail}</p>}
        {step.items && <ul>{step.items.map((item) => <li key={item}>{item}</li>)}</ul>}
        {step.sources && step.sources.length > 0 && (
          <div className="t-step-sources">
            {step.sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">{s.title || host(s.url)} <span>{host(s.url)}</span></a>)}
          </div>
        )}
      </details>
    </li>
  );
}

// What the trainer did, step by step: live while it works, a one-line summary you can open afterwards.
export function TraceView({ steps, live = false }: { steps: TraceStep[]; live?: boolean }) {
  if (!steps.length && !live) return null;
  const list = <ol className="t-trace-list">{steps.map((s) => <TraceItem key={s.id} step={s} />)}</ol>;
  if (live) return <div className="t-trace live"><div className="t-trace-head"><span className="t-dots"><i /><i /><i /></span>Working on it…</div>{list}</div>;
  const total = steps.reduce((sum, s) => sum + (s.ms ?? 0), 0);
  const searched = steps.reduce((n, s) => n + (s.sources?.length ?? 0), 0);
  return (
    <details className="t-trace">
      <summary>How I got this · {steps.length} step{steps.length === 1 ? '' : 's'}{searched ? ` · ${searched} web sources` : ''}{total ? ` · ${seconds(total)}` : ''}</summary>
      {list}
    </details>
  );
}

// What the goal costs and where each figure comes from.
export function GoalCosts({ goal }: { goal: GoalDraft }) {
  const quoted = goal.benchmarks.filter((b) => b.quote && b.url);
  const priceUrl = goal.priceSource === 'research' ? goal.benchmarks.find((b) => b.topic === 'price')?.url : undefined;
  const rate = goal.benchmarks.find((b) => b.topic === 'loan_rate');
  return (
    <div className="t-costs">
      <div className="t-cost"><span>{goal.name}: price</span><b>{money(goal.price, 0)}</b><SourceTag source={goal.priceSource} url={priceUrl} /></div>
      {goal.running.map((c) => (
        <div key={c.id} className="t-cost"><span>{c.label}</span><b>{money(c.monthly, 0)}/mo</b><SourceTag source={c.source} url={c.url} /></div>
      ))}
      {goal.cuts.map((c) => <div key={c.group} className="t-cost"><span>Cut {CUT_LABEL[c.group] ?? c.group}</span><b>−{c.pct}%</b><i className="t-src user">your choice</i></div>)}
      {goal.loan && <div className="t-cost"><span>Loan</span><b>{goal.loan.years} years at {goal.loan.ratePct}%</b><SourceTag source={rate?.value === goal.loan.ratePct ? 'research' : 'assumption'} url={rate?.url} /></div>}
      {!goal.loan && rate && <div className="t-cost"><span>Loan interest today</span><b>{rate.value}%</b><SourceTag source="research" url={rate.url} /></div>}
      {quoted.map((b) => (
        <blockquote key={b.topic} className="t-quote">“{b.quote}”<a href={b.url} target="_blank" rel="noopener noreferrer">{host(b.url!)}</a></blockquote>
      ))}
    </div>
  );
}

export function Sources({ sources }: { sources: Source[] }) {
  return (
    <div className="t-sources">
      <div className="t-sources-title">Sources (Exa web search)</div>
      {sources.map((s) => (
        <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">
          <b>{s.title || host(s.url)}</b>
          {s.snippet && <em>“{s.snippet.length > SNIPPET_SHOWN ? `${s.snippet.slice(0, SNIPPET_SHOWN)}…` : s.snippet}”</em>}
          <span>{host(s.url)}{s.published ? ` · ${s.published}` : ''}</span>
        </a>
      ))}
    </div>
  );
}

export function PlanCard({ plan }: { plan: AgreedPlan }) {
  const status = plan.lastCheck?.status;
  return (
    <div className="t-plan">
      <div className="t-plan-head"><b>Agreed plan: {plan.goal.name}</b>{status && <span className={`t-chip ${status === 'on_track' ? 'ok' : 'alert'}`}>{STATUS_LABEL[status]}</span>}</div>
      <div className="t-scenario-figure">{money(plan.monthlySaving, 0)}<small> a month until {fullDate(plan.targetDate)}</small></div>
      <div className="t-plan-sub">{money(plan.goal.price, 0)} · agreed {fullDate(plan.agreedOn)}{plan.bufferMonthly > 0 ? ` · plus ${money(plan.bufferMonthly, 0)}/mo into your buffer` : ''}</div>
    </div>
  );
}
