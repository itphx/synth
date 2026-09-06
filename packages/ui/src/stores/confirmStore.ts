import { create } from 'zustand'
import type { ConfirmVariant } from '@/components/ui/confirm-dialog'
import type { IconName } from '@/components/icon/icons'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: ConfirmVariant
  icon?: IconName
}

interface ConfirmState {
  open: boolean
  options: ConfirmOptions | null
  onResolve: ((confirmed: boolean) => void) | null
  /** Открывает подтверждение и возвращает Promise<boolean>. Вызывается вне React (zustand-сторы). */
  openConfirm: (opts: ConfirmOptions) => Promise<boolean>
  /** Закрывает подтверждение и резолвит ожидающий Promise (true/false). */
  closeConfirm: (confirmed: boolean) => void
}

/**
 * Глобальный сервис подтверждения (Phase 2): заменяет window.confirm и доступен
 * вне React-компонентов (zustand-сторы). Один <ConfirmDialog> рендерится в App.tsx,
 * прочитав состояние этого стора.
 */
export const useConfirmStore = create<ConfirmState>((set, get) => ({
  open: false,
  options: null,
  onResolve: null,

  openConfirm: (opts) =>
    new Promise<boolean>((resolve) => {
      set({ open: true, options: opts, onResolve: resolve })
    }),

  closeConfirm: (confirmed) => {
    const resolve = get().onResolve
    set({ open: false, options: null, onResolve: null })
    resolve?.(confirmed)
  },
}))
