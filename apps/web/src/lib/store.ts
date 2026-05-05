import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface ConnectionPick {
  id: string;
  label: string;
}

interface MigratorState {
  /** Current source connection + index. */
  source: { connection: ConnectionPick | null; indexName: string | null };
  setSource: (c: ConnectionPick | null, indexName?: string | null) => void;
  /** Current target connection + index. */
  target: { connection: ConnectionPick | null; indexName: string | null };
  setTarget: (c: ConnectionPick | null, indexName?: string | null) => void;
  /** Selected namespaces (working set). */
  selected: string[];
  setSelected: (s: string[]) => void;
  toggleSelected: (n: string) => void;
}

export const useMigratorStore = create<MigratorState>()(
  persist(
    (set) => ({
      source: { connection: null, indexName: null },
      setSource: (c, indexName) =>
        set((s) => ({ source: { connection: c, indexName: indexName ?? s.source.indexName } })),
      target: { connection: null, indexName: null },
      setTarget: (c, indexName) =>
        set((s) => ({ target: { connection: c, indexName: indexName ?? s.target.indexName } })),
      selected: [],
      setSelected: (s) => set({ selected: s }),
      toggleSelected: (n) =>
        set((state) => {
          const idx = state.selected.indexOf(n);
          if (idx === -1) return { selected: [...state.selected, n] };
          const next = [...state.selected];
          next.splice(idx, 1);
          return { selected: next };
        }),
    }),
    {
      name: 'migrator-state',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ source: s.source, target: s.target }),
    },
  ),
);
