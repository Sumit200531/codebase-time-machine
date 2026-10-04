import { useSyncExternalStore } from "react";

export type ViewId = "map" | "galaxy" | "architecture" | "compare" | "people";
export type Selection = { kind: "commit"; step: number } | { kind: "file"; lineage: number } | null;
export const SPEEDS = [0.5, 1, 2, 5, 10] as const;
export type Speed = (typeof SPEEDS)[number];

export interface ExplorerState {
  readonly step: number;
  readonly playing: boolean;
  readonly speed: Speed;
  readonly milestonesOnly: boolean;
  readonly view: ViewId;
  readonly selection: Selection;
  readonly compare: { readonly from: number; readonly to: number };
  readonly listMode: boolean;
}

type Listener = () => void;

/** The timeline cursor and UI state: one small store every panel derives from. */
export function createExplorerStore(initial: ExplorerState) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(update: Partial<ExplorerState> | ((current: ExplorerState) => Partial<ExplorerState>)) {
      const patch = typeof update === "function" ? update(state) : update;
      state = { ...state, ...patch };
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ExplorerStore = ReturnType<typeof createExplorerStore>;

export function useExplorer<T>(store: ExplorerStore, select: (state: ExplorerState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
