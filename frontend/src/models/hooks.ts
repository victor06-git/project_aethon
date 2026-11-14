// React bindings for the model: one PhoneModel per phone, provided by the controller
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Loaded, PhoneModel } from './phoneModel';

export const ModelContext = createContext<PhoneModel | null>(null);

export function useModel(): PhoneModel {
  const m = useContext(ModelContext);
  if (!m) throw new Error('useModel outside a phone');
  useSyncExternalStore(m.subscribe, m.snapshot);
  return m;
}

export function useData<T = any>(path: string | null): Loaded<T> {
  const m = useModel();
  return path ? m.data<T>(path) : undefined;
}
