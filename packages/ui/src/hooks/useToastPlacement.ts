import type { ToastPosition } from 'react-toastify'
import { useDevice } from './useDevice'

export type ToastPlacement = Extract<ToastPosition, 'top-center' | 'bottom-right'>

/**
 * Позиция тостов в зоне телефона. Сверху — чтобы уведомление не перекрывало
 * панель ввода чата (композер живёт внизу экрана и на телефоне занимает
 * существенную часть высоты).
 */
export const TOAST_PLACEMENT_MOBILE: ToastPlacement = 'top-center'

/** Прежняя позиция для десктопа и планшета. */
export const TOAST_PLACEMENT_DEFAULT: ToastPlacement = 'bottom-right'

/**
 * Реактивная позиция тостов: телефон → `top-center`, планшет/десктоп → `bottom-right`.
 *
 * Источник признака — `useDevice()`, а не собственный media query:
 * - он уже единственный источник зоны устройства в UI (его же использует
 *   раскладка в `App.tsx`), строится на тех же `BREAKPOINTS`, по которым
 *   `initDeviceClasses` вешает классы `device-*` на `<html>`. Значит JS-позиция
 *   и CSS (`html.device-phone .Toastify__toast-container--top-center`,
 *   `styles/index.css`) не могут разойтись по границе зоны;
 * - `useDevice` собран из `useMediaQuery` (`useSyncExternalStore` над
 *   `matchMedia`), поэтому поворот экрана / ресайз / смена `pointer`
 *   пересчитывают позицию без перезагрузки;
 * - своя подписка на `matchMedia` в компоненте была бы вторым источником правды
 *   и лишним слушателем на каждое монтирование.
 */
export function useToastPlacement(): ToastPlacement {
  const { deviceType } = useDevice()
  return deviceType === 'phone' ? TOAST_PLACEMENT_MOBILE : TOAST_PLACEMENT_DEFAULT
}
