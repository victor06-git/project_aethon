// Controller: one phone. Owns navigation and assistant state, turns user actions into model
// calls, and picks the screen to render. Views stay pure; the model holds the data.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PhoneModel } from '../models/phoneModel';
import { ModelContext } from '../models/hooks';
import { NavContext, type Nav } from './nav';
import { screensFor } from '../views/screens';
import { StatusBar, Header, TabBar, Modal } from '../views/layout/Layout';
import { Assistant } from '../views/revi/Assistant';
import { Failed } from '../views/components';
import { Splash, splashMs } from '../views/layout/Splash';

interface Step { name: string; arg: string | null }
type Intro = 'pending' | 'shown' | 'done';

export function PhoneController({ revi, label }: { revi: boolean; label: string }) {
  const model = useMemo(() => new PhoneModel(), []);
  useSyncExternalStore(model.subscribe, model.snapshot);   // the text-size setting changes the frame's class
  const screens = useMemo(() => screensFor(revi), [revi]);
  const [tab, setTabState] = useState<{ id: string; arg: string | null }>({ id: 'home', arg: null });
  const [stack, setStack] = useState<Step[]>([]);
  const [modal, setModal] = useState<{ title: string; body: string } | null>(null);
  const [assistant, setAssistant] = useState<'closed' | 'open'>('closed');
  const [intro, setIntro] = useState<Intro>(revi ? 'pending' : 'done');
  const screenRef = useRef<HTMLElement>(null);

  // Intro bubble next to the launcher: in 0.7 s after the splash, out ~4.5 s later, once per visit.
  useEffect(() => {
    if (!revi) return;
    const start = splashMs(true) + 500;
    const a = setTimeout(() => setIntro((s) => (s === 'pending' ? 'shown' : s)), start + 700);
    const b = setTimeout(() => setIntro('done'), start + 5200);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [revi]);

  const top: Step = stack.length ? stack[stack.length - 1] : { name: tab.id, arg: tab.arg };
  const scrollTop = useCallback(() => { if (screenRef.current) screenRef.current.scrollTop = 0; }, []);

  const nav: Nav = useMemo(() => ({
    revi,
    go: (name, arg = null) => { setStack((s) => [...s, { name, arg }]); scrollTop(); },
    back: () => { setStack((s) => s.slice(0, -1)); scrollTop(); },
    setTab: (id, arg = null) => { setTabState({ id, arg }); setStack([]); scrollTop(); },
    setArg: (arg) => {
      setStack((s) => {
        if (!s.length) { setTabState((t) => ({ ...t, arg })); return s; }
        return [...s.slice(0, -1), { ...s[s.length - 1], arg }];
      });
    },
    home: () => { setAssistant('closed'); setTabState({ id: 'home', arg: null }); setStack([]); scrollTop(); },
    openCity: (id = 'stop_food') => { setAssistant('closed'); setTabState({ id: 'invest', arg: id }); setStack([]); scrollTop(); },
    showModal: (title, body) => setModal({ title, body }),
    openAssistant: () => { if (revi) { setIntro('done'); setAssistant('open'); } },
    closeAssistant: () => setAssistant('closed'),
    ask: (q) => { setIntro('done'); setAssistant('open'); model.ask(q); }
  }), [revi, model, scrollTop]);

  const screen = screens[top.name];
  const Screen = screen?.Component;

  return (
    <ModelContext.Provider value={model}>
      <NavContext.Provider value={nav}>
        <section className={`phone${model.large ? ' large' : ''}`} aria-label={label}
          onKeyDown={(e) => { if (e.key === 'Escape' && assistant === 'open') nav.closeAssistant(); }}>
          <StatusBar />
          <div className="phone-banking" inert={assistant === 'open'}>
            <Header subTitle={stack.length ? (screen?.title ?? '') : null} />
            <main className="screen" ref={screenRef}>
              {Screen ? <Screen key={top.name} arg={top.arg} /> : <Failed message="Unknown screen" />}
            </main>
            <TabBar active={stack.length ? null : tab.id} />
          </div>
          {revi && <Assistant open={assistant === 'open'} intro={intro} />}
          <Splash revi={revi} />
          {modal && <Modal title={modal.title} body={modal.body} onClose={() => setModal(null)} />}
        </section>
      </NavContext.Provider>
    </ModelContext.Provider>
  );
}
