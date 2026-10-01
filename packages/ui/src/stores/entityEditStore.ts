import { create } from 'zustand'

export type EntityEditKind = 'project' | 'session'

/** Снимок редактируемой сущности для центрального диалога `EntityEditDialog`. */
export interface EntityEditTarget {
  kind: EntityEditKind
  id: string
  name: string
  /** Описание — только у проекта (у сессии его нет). */
  description?: string
  icon: string | null
  color: string | null
}

interface EntityEditState {
  target: EntityEditTarget | null
  openEntityEdit: (target: EntityEditTarget) => void
  closeEntityEdit: () => void
}

/**
 * Глобальный сервис редактирования проекта/сессии: один `EntityEditDialog`
 * рендерится в `App.tsx`, а триггеры (контекстное меню дерева, клик по
 * имени/иконке в правых вкладках) лишь открывают его через этот стор.
 */
export const useEntityEditStore = create<EntityEditState>((set) => ({
  target: null,
  openEntityEdit: (target) => set({ target }),
  closeEntityEdit: () => set({ target: null }),
}))
