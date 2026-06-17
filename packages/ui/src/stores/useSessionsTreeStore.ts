import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SortMode = 'date' | 'name'

interface SessionsTreeStore {
  sortMode: SortMode
  setSortMode: (mode: SortMode) => void
  toggleSortMode: () => void

  selectionMode: boolean
  selectedIds: Set<string>

  toggleSelectionMode: () => void
  toggleSelected: (id: string) => void
  clearSelection: () => void
}

export const useSessionsTreeStore = create<SessionsTreeStore>()(
  persist(
    (set) => ({
      sortMode: 'date',
      setSortMode: (mode) => set({ sortMode: mode }),
      toggleSortMode: () =>
        set((s) => ({ sortMode: s.sortMode === 'date' ? 'name' : 'date' })),

      selectionMode: false,
      selectedIds: new Set<string>(),

      toggleSelectionMode: () =>
        set((s) => ({
          selectionMode: !s.selectionMode,
          selectedIds: s.selectionMode ? s.selectedIds : new Set<string>(),
        })),

      toggleSelected: (id: string) =>
        set((s) => {
          const next = new Set(s.selectedIds)
          if (next.has(id)) {
            next.delete(id)
          } else {
            next.add(id)
          }
          return { selectedIds: next }
        }),

      clearSelection: () => set({ selectedIds: new Set<string>() }),
    }),
    {
      name: 'synth-ui-sessions-tree',
      partialize: (state) => ({
        selectedIds: [...state.selectedIds],
      }),
      merge: (persisted, current) => {
        const p = persisted as Record<string, unknown> | undefined
        return {
          ...current,
          selectedIds: Array.isArray(p?.selectedIds)
            ? new Set(p.selectedIds as string[])
            : current.selectedIds,
        }
      },
    }
  )
)
