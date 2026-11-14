// Cards the trainer answers with, used in the chat and on the trainer screens: the
// safe-to-spend math, the three-baskets pill bar, tap-to-correct assumptions, scenario
// comparison, what a goal costs, web sources and the agreed plan.
import { useState } from 'react';
import type {
  AgreedPlan, BasketTotal, CashLine, FigureSource, GapFix, GoalDraft, GoalScenario, MathStep, NextStep, PlanStatus, Source, TraceStep
} from '../../../../backend/src/domain/trainer';
import { useModel } from '../../models/hooks';
import { money, shortDate } from '../format';

const SOURCE_TAG: Record<FigureSource, string> = { assumption: 'Estimate', research: 'Web evidence', user: 'Your input' };
const CUT_LABEL: Record<string, string> = {
  dining: 'eating out', groceries: 'groceries', taxi: 'taxis', leisure: 'leisure', transport: 'transport', shopping: 'shopping', everyday: 'all everyday spending'
};
export const STATUS_LABEL: Record<PlanStatus, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' };

const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0];
export const fullDate = (iso: string) => `${shortDate(iso)} ${iso.slice(0, 4)}`;
const sourceDate = (date: string) => /^\d{4}-\d\d-\d\d/.test(date) ? fullDate(date.slice(0, 10)) : date;

function validLink(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

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
export function BasketBar({ baskets, explain, onPick }: { baskets: BasketTotal[]; explain?: boolean; onPick?: (basket: string) => void }) {
  const total = baskets.reduce((s, b) => s + b.monthly, 0) || 1;
  return (
    <div className="t-baskets">
      <div className="t-pill" aria-hidden="true">
        {baskets.map((b) => (
          <span key={b.basket} className={`seg ${b.basket}`} style={{ width: `${(b.monthly / total) * 100}%` }} />
        ))}
      </div>
      <div className="t-legend">
        {baskets.map((b) => {
          const content = <><i className={`dot ${b.basket}`} /><span>{b.label}</span><b>{money(b.monthly, 0)}/mo</b>{explain && <small>{b.hint}</small>}</>;
          return onPick
            ? <button key={b.basket} className="t-basket-row" type="button" onClick={() => onPick(b.basket)}>{content}</button>
            : <div key={b.basket} className="t-basket-row">{content}</div>;
        })}
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
  if (scenarios.length === 0) return null;
  const [primary, ...alternatives] = scenarios;
  const card = (s: GoalScenario) => (
    <div key={s.id} className={`t-scenario${s.feasible ? ' ok' : ''}`}>
      <div className="t-scenario-head"><b>{s.label}</b><span className={`t-chip ${s.feasible ? 'ok' : 'alert'}`}>{scenarioVerdict(s)}</span></div>
      <div className="t-scenario-figure">{money(s.monthlyNeeded, 0)}<small> a month for {s.months} months</small></div>
      <dl>
        <div><dt>Needed upfront</dt><dd>{money(s.upfront, 0)}</dd></div>
        <div><dt>Available to save</dt><dd>{money(s.monthlyCapacity, 0)}/mo</dd></div>
        <div><dt>Target date</dt><dd>{fullDate(s.readyDate)}</dd></div>
        {s.loan && <div><dt>Loan</dt><dd>{money(s.loan.amount, 0)}, {money(s.loan.payment, 0)}/mo</dd></div>}
        {s.afterMonthly > 0 && (
          <div><dt>After buying</dt>
            <dd>{money(s.afterMonthly, 0)}/mo, {s.afterFree >= 0 ? `${money(s.afterFree, 0)} left` : `${money(-s.afterFree, 0)} short`}</dd></div>
        )}
      </dl>
    </div>
  );
  return (
    <div className="t-scenarios">
      {card(primary)}
      {alternatives.length > 0 && <details className="t-evidence">
        <summary>{alternatives.length === 1 ? 'Compare with an alternative' : `Compare ${alternatives.length} alternatives`}</summary>
        {alternatives.map(card)}
      </details>}
    </div>
  );
}

export function ScenarioChange({ previous, current }: { previous: GoalScenario; current: GoalScenario }) {
  const timing = previous.months !== current.months;
  const contribution = current.monthlyNeeded - previous.monthlyNeeded;
  const costs = current.afterMonthly - previous.afterMonthly;
  const capacity = current.monthlyCapacity - previous.monthlyCapacity;
  if (!timing && !contribution && !costs && !capacity) return null;
  return <dl className="t-scenario-change" aria-label="Changes from your previous scenario">
    {timing && <div><dt>Time to save</dt><dd>{previous.months} → {current.months} months</dd></div>}
    {contribution !== 0 && <div><dt>Monthly savings needed</dt><dd>{money(previous.monthlyNeeded, 0)} → {money(current.monthlyNeeded, 0)}</dd></div>}
    {costs !== 0 && <div><dt>Monthly cost after buying</dt><dd>{money(previous.afterMonthly, 0)} → {money(current.afterMonthly, 0)}</dd></div>}
    {capacity !== 0 && <div><dt>Monthly room to save</dt><dd>{money(previous.monthlyCapacity, 0)} → {money(current.monthlyCapacity, 0)}</dd></div>}
  </dl>;
}

// Where a figure comes from. A researched figure links to its source.
function SourceTag({ source, url }: { source: FigureSource; url?: string }) {
  const href = validLink(url);
  if (source === 'research' && href) return <a className="t-src research" href={href} target="_blank" rel="noopener noreferrer" title={host(href)}>Web evidence ↗</a>;
  return <i className={`t-src ${source}`}>{SOURCE_TAG[source]}</i>;
}

// Current options found on the web, each with its source and a way to use its price.
export function GoalOptions({ goal, busy, onPick }: { goal: GoalDraft; busy: boolean; onPick?: (index: number) => void }) {
  return (
    <div className="t-options">
      <div className="t-sources-title">Listings found with Exa</div>
      {goal.options.map((o, i) => {
        const href = validLink(o.url);
        const selected = goal.selectedOptionUrl === o.url && goal.price === o.price;
        return (
          <div key={`${o.url}-${o.name}-${o.price}`} className={`t-option${selected ? ' on' : ''}`}>
            <div className="t-option-listing"><b>{o.name}</b>{href && <a href={href} target="_blank" rel="noopener noreferrer">{host(href)} ↗</a>}</div>
            <strong>{money(o.price, 0)}</strong>
            {onPick && <button type="button" disabled={busy || selected} onClick={() => onPick(i)}>{selected ? 'In plan' : 'Use price'}</button>}
            {o.conditions && <p className="t-option-conditions">{o.conditions}</p>}
            {o.evidence?.snippet && <details className="t-evidence">
              <summary>Listing evidence{o.evidence.published ? ` · ${sourceDate(o.evidence.published)}` : ''}</summary>
              <blockquote>“{o.evidence.snippet}”</blockquote>
            </details>}
            {selected && onPick && href && goal.kind === 'car' && <SellerInquiry name={o.name} price={o.price} url={href} />}
          </div>
        );
      })}
    </div>
  );
}

function SellerInquiry({ name, price, url }: { name: string; price: number; url: string }) {
  const [copyState, setCopyState] = useState('');
  const draft = `Hi, is the ${name} in this listing still available?\n${url}\n\nCan you confirm the advertised ${money(price, 0)} is the total cash price, including any fees? Could you share the current mileage, service and inspection history, and whether a test drive is possible? Thanks!`;
  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopyState('Copied.');
    } catch {
      setCopyState('Copy the text above.');
    }
  }
  return <details className="t-evidence">
    <summary>Draft a seller inquiry</summary>
    <p className="foot">Review and send it yourself if you want to contact the seller.</p>
    <blockquote style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{draft}</blockquote>
    <button type="button" onClick={() => { void copyDraft(); }}>Copy draft</button>
    <span className="foot" role="status">{copyState}</span>
  </details>;
}

// A prepared next step: one thing the user can do now.
export function NextStepCard({ step, onGo, busy }: { step: NextStep; onGo: (step: NextStep) => void; busy?: boolean }) {
  return (
    <div className="t-next">
      <div className="t-sources-title">{step.title}</div>
      <div>{step.detail}</div>
      {(step.ask || step.screen) && <button type="button" disabled={busy} onClick={() => onGo(step)}>{step.screen === 'transfer' ? 'Review transfer preview' : step.screen === 'plan' ? 'Open plan and sliders' : step.ask ?? 'Open banking'}</button>}
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
const MAX_BUDGET = 10_000_000;
const MAX_MONTHS = 240;
export function BriefCard({ goal, busy, onChange, onConfirm }: {
  goal: GoalDraft; busy: boolean; onChange: (change: { name?: string; price?: number; months: number }, said: string) => void; onConfirm?: () => void;
}) {
  const [name, setName] = useState(goal.name);
  const [price, setPrice] = useState(goal.price > 0 ? String(goal.price) : '');
  const [months, setMonths] = useState(goal.months);
  const budget = Number(price);
  const changedName = name.trim() !== goal.name;
  const valid = name.trim().length > 0 && Number.isFinite(budget) && budget >= 1 && budget <= MAX_BUDGET;
  const change = changedName || budget !== goal.price || months !== goal.months;
  const confirm = () => {
    if (change) onChange({
      ...(changedName ? { name: name.trim() } : {}),
      ...(budget !== goal.price ? { price: budget } : {}),
      months
    }, `${name.trim()}, budget ${money(budget, 0)}, in ${months} months`);
    else onConfirm?.();
  };
  return (
    <div className="t-brief">
      <label>What are you buying?
        <input type="text" value={name} maxLength={60} disabled={busy} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>Budget (€)
        <input type="number" inputMode="decimal" min={1} max={MAX_BUDGET} step={0.01} value={price} placeholder="e.g. 8,000" disabled={busy} onChange={(e) => setPrice(e.target.value)} />
      </label>
      <div className="t-stepper">
        <span>In how many months?</span>
        <div>
          <button type="button" aria-label="One month less" disabled={busy || months <= 1} onClick={() => setMonths(months - 1)}>−</button>
          <b>{months}</b>
          <button type="button" aria-label="One month more" disabled={busy || months >= MAX_MONTHS} onClick={() => setMonths(months + 1)}>+</button>
        </div>
      </div>
      <button type="button" className="t-primary" disabled={busy || !valid || (!change && !onConfirm)} onClick={confirm}>{change || !onConfirm ? 'Update brief' : 'Confirm brief'}</button>
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
            {step.sources.map((s) => {
              const href = validLink(s.url);
              return href && <a key={s.url} href={href} target="_blank" rel="noopener noreferrer">{s.title || host(href)} <span>{host(href)}</span></a>;
            })}
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
export function GoalCosts({ goal, label = 'Cost breakdown and assumptions' }: { goal: GoalDraft; label?: string }) {
  const quoted = goal.benchmarks.filter((b) => b.quote && b.url);
  const priceUrl = goal.priceSource === 'research' ? goal.benchmarks.find((b) => b.topic === 'price')?.url : undefined;
  const rate = goal.benchmarks.find((b) => b.topic === 'loan_rate' && b.value !== undefined);
  return (
    <details className="t-evidence">
      <summary>{label}</summary>
      <div className="t-costs">
        {goal.price > 0 && <div className="t-cost"><span>Purchase price</span><b>{money(goal.price, 0)}</b><SourceTag source={goal.priceSource} url={priceUrl} /></div>}
        {goal.running.map((c) => (
          <div key={c.id} className="t-cost"><span>{c.label}</span><b>{money(c.monthly, 0)}/mo</b><SourceTag source={c.source} url={c.url} /></div>
        ))}
        {goal.cuts.map((c) => <div key={c.group} className="t-cost"><span>Cut {CUT_LABEL[c.group] ?? c.group}</span><b>−{c.pct}%</b><i className="t-src user">Your choice</i></div>)}
        {goal.loan && <div className="t-cost"><span>Loan</span><b>{goal.loan.years} years at {goal.loan.ratePct}%</b><SourceTag source={goal.loan.rateSource ?? 'assumption'} url={goal.loan.rateUrl} /></div>}
        {!goal.loan && rate && <div className="t-cost"><span>Example loan rate</span><b>{rate.value}%</b><SourceTag source="research" url={rate.url} /></div>}
        {quoted.map((b) => {
          const href = validLink(b.url);
          const source = b.sources.find((s) => s.url === b.url);
          return <blockquote key={b.topic} className="t-quote">
            <b>{b.label}</b>
            <p>“{b.quote}”</p>
            {href && <a href={href} target="_blank" rel="noopener noreferrer">{host(href)}{source?.published ? ` · ${sourceDate(source.published)}` : ''} ↗</a>}
          </blockquote>;
        })}
      </div>
    </details>
  );
}

export function Sources({ sources }: { sources: Source[] }) {
  const unique = [...new Map(sources.map((s) => [s.url, s])).values()];
  return (
    <details className="t-evidence">
      <summary>Inspect {unique.length} Exa source{unique.length !== 1 ? 's' : ''}</summary>
      <div className="t-sources">
        {unique.map((s) => {
          const href = validLink(s.url);
          return <article key={s.url} className="t-source-card">
            {href ? <a href={href} target="_blank" rel="noopener noreferrer">{s.title || host(href)} ↗</a> : <b>{s.title}</b>}
            <span>{host(s.url)}{s.published ? ` · Published ${sourceDate(s.published)}` : ' · Publication date unavailable'}</span>
            {s.snippet && <blockquote>“{s.snippet}”</blockquote>}
          </article>;
        })}
      </div>
    </details>
  );
}

export function SavingsSetup({ plan, detail, onOpen }: { plan: AgreedPlan; detail?: string; onOpen: () => void }) {
  return <div className="t-next">
    <b>Review your savings setup</b>
    <p>{detail ?? `Set aside ${money(plan.monthlySaving, 2)} per month until ${fullDate(plan.targetDate)}.`}</p>
    <p className="t-setup-note">Your plan is saved on this device. Transfers are simulated in this preview.</p>
    {plan.monthlySaving > 0 && <button type="button" onClick={onOpen}>Preview savings transfer</button>}
  </div>;
}

export function PlanCard({ plan }: { plan: AgreedPlan }) {
  const status = plan.lastCheck?.status;
  const reachable = plan.lastCheck?.proposedGoal ? undefined : status;
  return (
    <div className="t-plan">
      <div className="t-plan-head"><b>Agreed plan: {plan.goal.name}</b>{reachable && <span className={`t-chip ${reachable === 'on_track' ? 'ok' : 'alert'}`}>{STATUS_LABEL[reachable]}</span>}</div>
      <div className="t-scenario-figure">{money(plan.monthlySaving, 0)}<small> a month until {fullDate(plan.targetDate)}</small></div>
      <div className="t-plan-sub">{money(plan.goal.price, 0)} · agreed {fullDate(plan.agreedOn)}{plan.bufferMonthly > 0 ? ` · plus ${money(plan.bufferMonthly, 0)}/mo into your buffer` : ''}</div>
    </div>
  );
}
