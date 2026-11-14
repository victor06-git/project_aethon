// What views may ask the controller to do. Views never change state themselves.
import { createContext, useContext } from 'react';

export interface Nav {
  revi: boolean;
  go(name: string, arg?: string | null): void;
  back(): void;
  setTab(id: string, arg?: string | null): void;
  setArg(arg: string | null): void;       // change what the current screen shows, without a Back step
  home(): void;
  openCity(scenarioId?: string): void;    // opens the 3D City screen on top of the current tab
  showModal(title: string, body: string): void;
  openAssistant(): void;
  closeAssistant(): void;
  ask(question: string): void;
}

export const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
  const n = useContext(NavContext);
  if (!n) throw new Error('useNav outside a phone');
  return n;
}
