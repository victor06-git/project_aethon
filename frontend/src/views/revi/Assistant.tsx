// Revi assistant: launcher, suggested questions and conversation.
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { Answer } from '../../../../backend/src/domain/types';
import { useModel } from '../../models/hooks';
import type { ChatMessage } from '../../models/phoneModel';
import { useNav } from '../../controllers/nav';
import { money } from '../format';
import { CarPlanner } from './chatWidgets';
import { Icon } from '../icons';
import { AuroraOrb } from './AuroraOrb';
import { Markdown } from './Markdown';
import { BasketBar, BriefCard, Choices, Fixes, GoalCosts, GoalOptions, MathSteps, NextStepCard, PlanCard, ReviewLines, SavingsSetup, ScenarioCards, ScenarioChange, Sources, TraceView } from './TrainerCards';
import { CAR_QUESTION, SPENDING_QUESTION, WEEKLY_QUESTION, demoDataLabel, useTrainerStatus } from './demo';

const MAX_CHIPS = 3;   // a simple user should never face a wall of buttons

const STARTERS = [
  { title: 'Plan a first car', question: CAR_QUESTION },
  { title: 'Understand my spending', question: SPENDING_QUESTION },
  { title: 'Check my weekly budget', question: WEEKLY_QUESTION }
];

// Keeps an element mounted while it animates out, and flips "shown" one frame after mount.
function usePresence(visible: boolean, exitMs: number) {
  const [mounted, setMounted] = useState(visible);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(t);
  }, [visible, exitMs]);
  return { mounted, shown };
}

function AnswerBubble({ a, previous, active }: { a: Answer; previous?: Answer; active: boolean }) {
  const nav = useNav();
  const model = useModel();
  const busy = model.busy || !active;
  const scenario = a.scenarios?.[0];
  const previousScenario = previous?.goal?.name === a.goal?.name ? previous?.scenarios?.[0] : undefined;
  const canSave = a.goal?.confirmed && scenario?.feasible && active;
  const splitAt = a.type === 'research' && a.goal ? a.text.indexOf('\n') : -1;
  const reply = splitAt < 0 ? a.text : a.text.slice(0, splitAt);
  const whatIf = (change: Record<string, unknown>, said: string) => { void model.act(said, 'what_if', change); };
  const max = a.rows ? Math.max(...a.rows.map((r) => r.amount), 1) : 1;
  const open = (screen: string, arg?: string) => { nav.closeAssistant(); nav.go(screen, arg); };
  const sendLetter = async (e: FormEvent) => {
    e.preventDefault();
    const res = await model.post<{ note: string }>('/api/letters/send', { subject: a.letter?.subject });
    nav.showModal('Confirmation', res.note);
  };
  return (
    <div className="k-msg bot">
      <Markdown text={reply} />
      {a.figure && !a.steps && <div className="figure">{a.figure}</div>}
      {a.range && <div className="range">{a.range}</div>}
      {a.steps && <MathSteps steps={a.steps} />}
      {a.baskets && <BasketBar baskets={a.baskets} explain onPick={() => open('cashflow')} />}
      {active && a.review && a.review.length > 0 && <ReviewLines lines={a.review} />}
      {a.planner && <CarPlanner planner={a.planner} />}
      {!a.planner && a.rows && a.rows.length > 0 && (
        <div className="bars">{a.rows.map((r) => (
          <div key={r.label} className="bar-row"><span>{r.label}</span>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${(r.amount / max) * 100}%` }} /></div>
            <span>{money(r.amount, 0)}</span></div>))}
        </div>
      )}
      {active && a.goal && !a.goal.confirmed && (
        <BriefCard key={`${a.goal.name}-${a.goal.price}-${a.goal.months}`} goal={a.goal} busy={busy}
          onConfirm={() => { void model.act('Confirm brief', 'confirm_brief'); }}
          onChange={whatIf} />
      )}
      {scenario && previousScenario && <ScenarioChange current={scenario} previous={previousScenario} />}
      {a.scenarios && <ScenarioCards scenarios={a.scenarios} />}
      {active && a.goal?.confirmed && scenario && (
        <div className="t-chat-actions">
          {/* Waiting only helps when saving is the problem, not the running costs afterwards. */}
          {(scenario.gap > 0 || scenario.afterFree >= 0) && <button type="button" className="k-action" disabled={busy || a.goal.months > 237}
            onClick={() => { void model.act('What if I wait 3 more months?', 'what_if', { add_months: 3 }); }}>
            Try 3 more months
          </button>}
          {canSave && <button type="button" className="k-action" disabled={busy}
            onClick={() => { void model.act('Save this plan', 'agree_plan'); }}>Save this plan</button>}
        </div>
      )}
      {a.goal && a.goal.options.length > 0 && a.type !== 'plan' && (
        <GoalOptions goal={a.goal} busy={busy} onPick={active ? (i) => { void model.act(`Use option ${i + 1}`, 'choose_option', { index: i }); } : undefined} />
      )}
      {a.goal && (a.type === 'scenario' || a.type === 'research') && <GoalCosts goal={a.goal} />}
      {splitAt >= 0 && <details className="t-evidence">
        <summary>Research findings and limits</summary>
        <Markdown text={a.text.slice(splitAt + 1)} />
      </details>}
      {active && a.goal?.confirmed && <details className="t-evidence">
        <summary>Edit purchase brief</summary>
        <BriefCard key={`${a.goal.name}-${a.goal.price}-${a.goal.months}`} goal={a.goal} busy={busy} onChange={whatIf} />
      </details>}
      {active && a.fixes && a.fixes.length > 0 && (
        <details className="t-evidence">
          <summary>Ways to close the gap</summary>
          <Fixes fixes={a.fixes} busy={busy} onPick={(f) => { void model.act(f.label, 'what_if', f.args); }} />
        </details>
      )}
      {a.plan && <PlanCard plan={a.plan} />}
      {a.plan?.lastCheck?.proposedGoal && <GoalCosts goal={a.plan.lastCheck.proposedGoal} label="Evidence for the proposed update" />}
      {active && a.choices && a.choices.length > 0 && (
        <Choices choices={a.choices} busy={busy} onPick={(c) => { void model.act(c.label, 'choose_path', { id: c.id }); }} />
      )}
      {active && a.plan && a.nextStep?.screen === 'transfer'
        ? <SavingsSetup plan={a.plan} detail={a.nextStep.detail} onOpen={() => open('transfer', 'savings-plan')} />
        : active && a.nextStep && a.nextStep.ask !== 'Agree this plan' &&
          <NextStepCard step={a.nextStep} busy={busy} onGo={(s) => (s.screen ? open(s.screen) : s.ask && nav.ask(s.ask))} />}
      {a.sources && a.sources.length > 0 && <Sources sources={a.sources} />}
      {active && a.letter && (
        <form onSubmit={sendLetter}>
          <div className="letter"><strong>{a.letter.subject}</strong>{'\n\n'}{a.letter.body}</div>
          <button type="submit" className="k-action">Send letter (your decision)</button>
        </form>
      )}
      {a.scenarioId && <button type="button" className="k-action" onClick={() => nav.openCity(a.scenarioId)}>View in 3D City <Icon name="arrow" size={16} /></button>}
      {/* Plan screen only once there are numbers to play with: after the brief is confirmed. */}
      {active && (a.scenarios || a.plan) && <button type="button" className="k-action" onClick={() => open('plan')}>{a.plan ? 'Open plan and recheck settings' : 'Open plan and sliders'} <Icon name="arrow" size={16} /></button>}
      {a.examples && a.examples.length > 0 && (
        <div className="k-suggest">{a.examples.map((x) => <button key={x} type="button" onClick={() => nav.ask(x)}>{x}</button>)}</div>
      )}
      {active && a.followUps && a.followUps.length > 0 && !a.goal && !a.plan && (
        <div className="k-chips">{a.followUps.slice(0, MAX_CHIPS).map((x) => <button key={x} type="button" disabled={busy} onClick={() => nav.ask(x)}>{x}</button>)}</div>
      )}
      {a.source === 'model' && <div className="k-by">Explained by ChatGPT using Revi’s tools.</div>}
      {a.trace && a.trace.length > 0 && <TraceView steps={a.trace} />}
    </div>
  );
}

function Message({ m, previous, active }: { m: ChatMessage; previous?: Answer; active: boolean }) {
  const model = useModel();
  if (m.role === 'user') return <div className="k-msg user">{m.text}</div>;
  if ('pending' in m) return <div className="k-msg bot working" aria-label="Revi is working"><TraceView steps={m.steps} live /></div>;
  if ('error' in m) {
    return (
      <div className="k-msg bot error" role="alert">
        <div>That did not work: {m.error}</div>
        {active && <button type="button" className="k-action" onClick={() => model.retry(m)}>Try again</button>}
      </div>
    );
  }
  return <AnswerBubble a={m.answer} previous={previous} active={active} />;
}

// The question field grows with its text (up to a few lines, then it scrolls), so a long
// question can be read back in full before sending.
const INPUT_MAX_PX = 120;
const INPUT_LINE_PX = 22;
function fitInput(field: HTMLTextAreaElement) {
  field.style.height = 'auto';
  field.style.height = `${Math.min(field.scrollHeight, INPUT_MAX_PX)}px`;
  field.style.overflowY = field.scrollHeight > INPUT_MAX_PX ? 'auto' : 'hidden';
  // The compact chat sits above the field: lift it by as much as the field grew.
  const grown = Math.max(0, field.offsetHeight - INPUT_LINE_PX);
  (field.closest('.k-layer') as HTMLElement | null)?.style.setProperty('--k-input-grow', `${grown}px`);
}

// Above this height a reply no longer looks good over the banking screen: open the full chat.
const TALL_REPLY_PX = 300;

export function Assistant({ open, intro }: { open: boolean; intro: 'pending' | 'shown' | 'done' }) {
  const nav = useNav();
  const model = useModel();
  const status = useTrainerStatus(open);
  const panel = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const layer = usePresence(open, 320);
  const teaser = usePresence(intro === 'shown', 400);
  const chat = model.chat;
  const previousReply = chat.at(-3);
  const previousAnswer = previousReply && 'answer' in previousReply ? previousReply.answer : undefined;
  const last = chat.at(-1);
  const pending = last && 'pending' in last;
  // Compact chat first (slides out of the launcher, "Welcome to Revi!" and the questions above it);
  // from the second question on, or as soon as one reply is too tall for the compact view,
  // it fills the screen with white and gets a back arrow.
  const [tall, setTall] = useState(false);
  const full = open && (tall || chat.filter((m) => m.role === 'user').length >= 2);
  useLayoutEffect(() => {
    if (!chat.length) { setTall(false); return; }
    const stack = panel.current;
    if (!tall && !pending && stack && stack.scrollHeight > TALL_REPLY_PX) setTall(true);
  }, [chat.length, pending, layer.shown, tall]);
  useEffect(() => {
    if (!layer.shown) return;
    const from = document.activeElement;
    back.current?.focus({ preventScroll: true });
    return () => {
      if (from instanceof HTMLElement && from.isConnected) from.focus({ preventScroll: true });
    };
  }, [layer.shown]);
  useEffect(() => {
    const stack = panel.current;
    const reply = stack?.querySelector('.k-msg:last-child');
    if (!layer.shown || !stack || !reply) return;
    stack.scrollTop += reply.getBoundingClientRect().top - stack.getBoundingClientRect().top - 4;
  }, [chat.length, pending, layer.shown]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (model.busy) return;
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    e.currentTarget.reset();
    const field = e.currentTarget.elements.namedItem('q') as HTMLTextAreaElement | null;
    if (field) fitInput(field);
    if (q) {
      field?.blur();
      nav.ask(q);
    }
  };

  return (
    <>
      <button type="button" className={`k-launcher${open ? ' open' : ''}${full ? ' hidden' : ''}`} onClick={open ? nav.closeAssistant : nav.openAssistant}
        tabIndex={full ? -1 : undefined} aria-hidden={full || undefined} aria-label={`${open ? 'Close' : 'Open'} Revi assistant`}>
        <span className="k-ico k-ico-mark"><AuroraOrb /></span>
        <span className="k-ico k-ico-close"><Icon name="close" size={22} /></span>
      </button>

      {teaser.mounted && (
        <button type="button" className={`k-teaser${teaser.shown ? ' show' : ''}`} onClick={nav.openAssistant}>
          <b>Hi, I'm Revi</b>
          <span>Every financial decision has an echo. Ask what could happen before you decide.</span>
        </button>
      )}

      {layer.mounted && (
        <div className={`k-layer${layer.shown ? ' open' : ''}${full ? ' full' : ' compact'}`} role="dialog" aria-modal={full} aria-label="Revi assistant" inert={!open}>
          {full && <header className="k-head">
            <button ref={back} type="button" className="k-back" onClick={nav.closeAssistant} aria-label="Back to banking"><Icon name="back" size={22} /></button>
            <span className="k-head-orb"><AuroraOrb waves="none" /></span>
            <b>Revi</b>
            <span className="k-demo-label">{demoDataLabel(status?.data)}</span>
          </header>}
          <div ref={panel} className="k-stack">
            {chat.length ? (
              <div className="k-msgs" role="log" aria-label="Conversation">{chat.map((m, i) => (
                <Message key={i} m={m} active={i === chat.length - 1} previous={i === chat.length - 1 ? previousAnswer : undefined} />
              ))}</div>
            ) : (
              <>
                <div className="k-hello">Welcome to Revi!</div>
                <p className="k-flow">{STARTERS.map(({ title, question }, i) => (
                  <span key={question}>
                    <span className="k-q" role="button" tabIndex={0} title={title}
                      onClick={() => nav.ask(question)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav.ask(question); } }}>{question}</span>
                    {i < STARTERS.length - 1 ? ' ' : ''}
                  </span>
                ))}</p>
              </>
            )}
          </div>
          <form className="k-input" onSubmit={submit}>
            <textarea name="q" rows={1} placeholder="Ask Revi about your money" autoComplete="off" aria-label="Ask Revi" maxLength={500}
              onInput={(e) => fitInput(e.currentTarget)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            <button type="submit" aria-label="Send" disabled={model.busy}><Icon name="send" size={18} /></button>
          </form>
        </div>
      )}
    </>
  );
}
