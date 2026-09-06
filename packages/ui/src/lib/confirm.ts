import { useConfirmStore, type ConfirmOptions } from '@/stores/confirmStore'

/**
 * Подтверждение вне React-хуков (zustand-сторы, обработчики). Возвращает Promise,
 * значение которого резолвится при закрытии диалога: true — подтверждено.
 *
 * Аналог `window.confirm`, но рендерит UI-диалог <ConfirmDialog> (см. App.tsx).
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().openConfirm(opts)
}
