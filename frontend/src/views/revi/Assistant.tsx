// Revi assistant: round launcher with the echo mark, an intro bubble that appears for a few
// seconds after the app opens, and the compact chat: the input slides out of the launcher,
// "Welcome to Revi!" and the starter questions flow above it as wrapping text, answers stack
// up there. After the second question the chat fills the screen with white and gets a back arrow.
// Answers are cards: math steps, the three baskets, scenarios, sources, the agreed plan.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Answer } from '../../../../backend/src/domain/types';
import { useData, useModel } from '../../models/hooks';
import { isError, type ChatMessage } from '../../models/phoneModel';
import { useNav } from '../../controllers/nav';
import { money } from '../format';
import { Icon } from '../icons';
import { AuroraOrb } from './AuroraOrb';
import { Markdown } from './Markdown';
import { BasketBar, BriefCard, Choices, Fixes, GoalCosts, GoalOptions, MathSteps, NextStepCard, PlanCard, ReviewLines, ScenarioCards, Sources, TraceView } from './TrainerCards';

const MAX_CHIPS = 3;   // a simple user should never face a wall of buttons

const DEFAULT_STARTERS = ['What can I safely spend this week?', 'Where did my money go?', 'Could I buy a car next year?'];

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

function AnswerBubble({ a }: { a: Answer }) {
  const nav = useNav();
  const model = useModel();
  const max = a.rows ? Math.max(...a.rows.map((r) => r.amount), 1) : 1;
  const open = (screen: string) => { nav.closeAssistant(); nav.go(screen); };
  const sendLetter = async (e: FormEvent) => {
    e.preventDefault();
    const res = await model.post<{ note: string }>('/api/letters/send', { subject: a.letter?.subject });
    nav.showModal('Confirmation', res.note);
  };
  return (
    <div className="k-msg bot">
      <Markdown text={a.text} />
      {a.figure && !a.steps && <div className="figure">{a.figure}</div>}
      {a.range && <div className="range">{a.range}</div>}
      {a.steps && <MathSteps steps={a.steps} />}
      {a.baskets && <BasketBar baskets={a.baskets} onPick={() => open('cashflow')} />}
      {a.review && a.review.length > 0 && <ReviewLines lines={a.review} />}
      {a.rows && a.rows.length > 0 && (
        <div className="bars">{a.rows.map((r) => (
          <div key={r.label} className="bar-row"><span>{r.label}</span>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${(r.amount / max) * 100}%` }} /></div>
            <span>{money(r.amount, 0)}</span></div>))}
        </div>
      )}
      {a.type === 'brief' && a.goal && (
        <BriefCard key={`${a.goal.price}-${a.goal.months}`} goal={a.goal} busy={model.busy}
          onConfirm={() => { void model.act('Yes, that is right', 'confirm_brief'); }}
          onChange={(change, said) => { void model.act(said, 'what_if', change); }} />
      )}
      {a.scenarios && <ScenarioCards scenarios={a.scenarios} />}
      {a.fixes && a.fixes.length > 0 && (
        <>
          <div className="t-sources-title">Ways to close the gap</div>
          <Fixes fixes={a.fixes} busy={model.busy} onPick={(f) => { void model.act(f.label, 'what_if', f.args); }} />
        </>
      )}
      {a.goal && a.goal.options.length > 0 && a.type !== 'plan' && (
        <GoalOptions goal={a.goal} busy={model.busy} onPick={(i) => { void model.act(`Use option ${i + 1}`, 'choose_option', { index: i }); }} />
      )}
      {a.goal && (a.type === 'scenario' || a.type === 'research') && <GoalCosts goal={a.goal} />}
      {a.plan && <PlanCard plan={a.plan} />}
      {a.choices && a.choices.length > 0 && (
        <Choices choices={a.choices} busy={model.busy} onPick={(c) => { void model.act(c.label, 'choose_path', { id: c.id }); }} />
      )}
      {a.nextStep && <NextStepCard step={a.nextStep} onGo={(s) => (s.screen ? open(s.screen) : s.ask && nav.ask(s.ask))} />}
      {a.sources && a.sources.length > 0 && <Sources sources={a.sources} />}
      {a.letter && (
        <form onSubmit={sendLetter}>
          <div className="letter"><strong>{a.letter.subject}</strong>{'\n\n'}{a.letter.body}</div>
          <button type="submit" className="k-action">Send letter (your decision)</button>
        </form>
      )}
      {a.scenarioId && <button type="button" className="k-action" onClick={() => nav.openCity(a.scenarioId)}>View in 3D City <Icon name="arrow" size={16} /></button>}
      {(a.scenarios || a.plan || a.type === 'brief') && <button type="button" className="k-action" onClick={() => open('plan')}>Open plan and sliders <Icon name="arrow" size={16} /></button>}
      {a.examples && a.examples.length > 0 && (
        <div className="k-suggest">{a.examples.map((x) => <button key={x} type="button" onClick={() => nav.ask(x)}>{x}</button>)}</div>
      )}
      {a.followUps && a.followUps.length > 0 && a.type !== 'brief' && (
        <div className="k-chips">{a.followUps.slice(0, MAX_CHIPS).map((x) => <button key={x} type="button" disabled={model.busy} onClick={() => nav.ask(x)}>{x}</button>)}</div>
      )}
      {a.source === 'model' && <div className="k-by">Explained by Gemini. Every figure is computed from your data.</div>}
      {a.trace && a.trace.length > 0 && <TraceView steps={a.trace} />}
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  const model = useModel();
  if (m.role === 'user') return <div className="k-msg user">{m.text}</div>;
  if ('pending' in m) return <div className="k-msg bot working" aria-label="Revi is working"><TraceView steps={m.steps} live /></div>;
  if ('error' in m) {
    return (
      <div className="k-msg bot error" role="alert">
        <div>That did not work: {m.error}</div>
        <button type="button" className="k-action" onClick={() => model.retry(m)}>Try again</button>
      </div>
    );
  }
  return <AnswerBubble a={m.answer} />;
}

export function Assistant({ open, intro }: { open: boolean; intro: 'pending' | 'shown' | 'done' }) {
  const nav = useNav();
  const model = useModel();
  const status = useData<{ starters: string[] }>(open ? '/api/trainer/status' : null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const layer = usePresence(open, 320);
  const teaser = usePresence(intro === 'shown', 400);
  const chat = model.chat;
  const starters = status && !isError(status) ? status.starters : DEFAULT_STARTERS;
  // From the second question on, the compact chat becomes a full white chat screen with a back arrow.
  const full = open && chat.filter((m) => m.role === 'user').length >= 2;

  useEffect(() => { if (panel.current) panel.current.scrollTop = panel.current.scrollHeight; }, [chat, layer.shown]);
  useEffect(() => { if (open) { const t = setTimeout(() => input.current?.focus({ preventScroll: true }), 330); return () => clearTimeout(t); } }, [open]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (model.busy) return;
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    e.currentTarget.reset();
    if (q) nav.ask(q);
  };
  const keyAsk = (q: string) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav.ask(q); } };

  return (
    <>
      <button type="button" className={`k-launcher${open ? ' open' : ''}${full ? ' hidden' : ''}`} onClick={open ? nav.closeAssistant : nav.openAssistant}
        aria-label={`${open ? 'Close' : 'Open'} Revi assistant`} title="Revi: ask what happens next">
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
        <div className={`k-layer${layer.shown ? ' open' : ''}${full ? ' full' : ''}`}>
          {full && (
            <header className="k-head">
              <button type="button" className="k-back" onClick={nav.closeAssistant} aria-label="Back"><Icon name="back" size={22} /></button>
              <span className="k-head-orb"><AuroraOrb waves="none" /></span>
              <b>Revi</b>
            </header>
          )}
          <div ref={panel} className={`k-stack${chat.length ? ' started' : ''}`} role="dialog" aria-label="Revi assistant">
            {chat.length ? (
              <div className="k-msgs" aria-live="polite">{chat.map((m, i) => <Message key={i} m={m} />)}</div>
            ) : (
              <>
                <div className="k-hello">Welcome to Revi!</div>
                <p className="k-flow">{starters.map((q, i) => (
                  <span key={q}>
                    <span className="k-q" role="button" tabIndex={0} onClick={() => nav.ask(q)} onKeyDown={keyAsk(q)}>{q}</span>
                    {i < starters.length - 1 ? ' ' : ''}
                  </span>
                ))}</p>
              </>
            )}
          </div>
          <form className="k-input" onSubmit={submit}>
            <input ref={input} name="q" placeholder="Ask Revi about your money" autoComplete="off" aria-label="Ask Revi" maxLength={500} />
            <button type="submit" aria-label="Send" disabled={model.busy}><Icon name="send" size={18} /></button>
          </form>
        </div>
      )}
    </>
  );
}
