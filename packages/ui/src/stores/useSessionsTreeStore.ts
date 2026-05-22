import { create } from 'zustand'

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

export const useSessionsTreeStore = create<SessionsTreeStore>((set) => ({
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
}))
