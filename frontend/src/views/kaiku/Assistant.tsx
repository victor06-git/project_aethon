// Kaiku assistant: round launcher with the echo mark, an intro bubble that appears for a few
// seconds after the app opens, and the compact chat: the input slides out of the launcher,
// "Welcome to Kaiku!" and the questions flow above it as wrapping text, answers stack up there.
// After the second question the chat fills the screen with white and gets a back arrow.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Answer } from '../../../../backend/src/domain/types';
import { useModel } from '../../models/hooks';
import { useNav } from '../../controllers/nav';
import { money } from '../format';
import { Icon } from '../icons';
import { AuroraOrb } from './AuroraOrb';

const DEFAULT_SUGGESTIONS = [
  { id: 'stop_food', text: 'What happens if I stop ordering food delivery?' },
  { id: 'mortgage_rate', text: 'What happens if my mortgage interest rate goes up?' },
  { id: 'breakdown', text: 'Where is my money going?' }
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

function AnswerBubble({ a }: { a: Answer }) {
  const nav = useNav();
  const model = useModel();
  const max = a.rows ? Math.max(...a.rows.map((r) => r.amount), 1) : 1;
  const sendLetter = async (e: FormEvent) => {
    e.preventDefault();
    const res = await model.post<{ note: string }>('/api/letters/send', { subject: a.letter?.subject });
    nav.showModal('Confirmation', res.note);
  };
  return (
    <div className="k-msg bot">
      <div>{a.text}</div>
      {a.figure && <div className="figure">{a.figure}</div>}
      {a.range && <div className="range">{a.range}</div>}
      {a.rows && (
        <div className="bars">{a.rows.map((r) => (
          <div key={r.label} className="bar-row"><span>{r.label}</span>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${(r.amount / max) * 100}%` }} /></div>
            <span>{money(r.amount, 0)}</span></div>))}
        </div>
      )}
      {a.letter && (
        <form onSubmit={sendLetter}>
          <div className="letter"><strong>{a.letter.subject}</strong>{'\n\n'}{a.letter.body}</div>
          <button type="submit" className="k-action">Send letter (your decision)</button>
        </form>
      )}
      {a.scenarioId && <button type="button" className="k-action" onClick={() => nav.openCity(a.scenarioId)}>View in 3D City <Icon name="arrow" size={16} /></button>}
      {a.examples && a.examples.length > 0 && (
        <div className="k-suggest">{a.examples.map((x) => <button key={x} type="button" onClick={() => nav.ask(x)}>{x}</button>)}</div>
      )}
    </div>
  );
}

export function Assistant({ open, intro }: { open: boolean; intro: 'pending' | 'shown' | 'done' }) {
  const nav = useNav();
  const model = useModel();
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const layer = usePresence(open, 320);
  const teaser = usePresence(intro === 'shown', 400);
  const chat = model.chat;
  const suggestions = model.suggestions() ?? DEFAULT_SUGGESTIONS;
  // From the second question on, the compact chat becomes a full white chat screen with a back arrow.
  const full = open && chat.filter((m) => m.role === 'user').length >= 2;

  useEffect(() => { if (panel.current) panel.current.scrollTop = panel.current.scrollHeight; }, [chat, layer.shown]);
  useEffect(() => { if (open) { const t = setTimeout(() => input.current?.focus({ preventScroll: true }), 330); return () => clearTimeout(t); } }, [open]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    e.currentTarget.reset();
    if (q) nav.ask(q);
  };
  const keyAsk = (q: string) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav.ask(q); } };

  return (
    <>
      <button type="button" className={`k-launcher${open ? ' open' : ''}${full ? ' hidden' : ''}`} onClick={open ? nav.closeAssistant : nav.openAssistant}
        aria-label={`${open ? 'Close' : 'Open'} Kaiku assistant`} title="Kaiku: ask what happens next">
        <span className="k-ico k-ico-mark"><AuroraOrb /></span>
        <span className="k-ico k-ico-close"><Icon name="close" size={22} /></span>
      </button>

      {teaser.mounted && (
        <button type="button" className={`k-teaser${teaser.shown ? ' show' : ''}`} onClick={nav.openAssistant}>
          <b>Hi, I'm Kaiku</b>
          <span>Every financial decision has an echo. Ask what could happen before you decide.</span>
        </button>
      )}

      {layer.mounted && (
        <div className={`k-layer${layer.shown ? ' open' : ''}${full ? ' full' : ''}`}>
          {full && (
            <header className="k-head">
              <button type="button" className="k-back" onClick={nav.closeAssistant} aria-label="Back"><Icon name="back" size={22} /></button>
              <span className="k-head-orb"><AuroraOrb waves="none" /></span>
              <b>Kaiku</b>
            </header>
          )}
          <div ref={panel} className={`k-stack${chat.length ? ' started' : ''}`} role="dialog" aria-label="Kaiku assistant">
            {chat.length ? (
              <div className="k-msgs">{chat.map((m, i) => (
                m.role === 'user' ? <div key={i} className="k-msg user">{m.text}</div>
                  : 'pending' in m ? <div key={i} className="k-msg bot typing"><i /><i /><i /></div>
                    : <AnswerBubble key={i} a={m.answer} />
              ))}</div>
            ) : (
              <>
                <div className="k-hello">Welcome to Kaiku!</div>
                <p className="k-flow">{suggestions.map((q, i) => (
                  <span key={q.id}>
                    <span className="k-q" role="button" tabIndex={0} title={'note' in q ? (q as { note?: string }).note : undefined}
                      onClick={() => nav.ask(q.text)} onKeyDown={keyAsk(q.text)}>{q.text}</span>
                    {i < suggestions.length - 1 ? ' ' : ''}
                  </span>
                ))}</p>
              </>
            )}
          </div>
          <form className="k-input" onSubmit={submit}>
            <input ref={input} name="q" placeholder="Ask Kaiku about your money" autoComplete="off" aria-label="Ask Kaiku" />
            <button type="submit" aria-label="Send"><Icon name="send" size={18} /></button>
          </form>
        </div>
      )}
    </>
  );
}
