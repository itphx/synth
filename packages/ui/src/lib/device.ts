export type DeviceType = 'phone' | 'tablet' | 'desktop'

export const BREAKPOINTS = {
  phoneMax: 768,
  tabletMax: 1199,
  desktopMin: 1200,
} as const

const QUERIES = {
  phone: '(max-width: 768px)',
  tablet: '(min-width: 769px) and (max-width: 1199px)',
  desktop: '(min-width: 1200px)',
} as const

const POINTER_QUERIES = ['(pointer: coarse)'] as const

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

/**
 * Применяет device-классы на <html>: device-phone / device-tablet / device-desktop
 * (по ширине вьюпорта) и pointer-coarse (есть грубый указатель).
 * Возвращает функцию отписки. Вызывать один раз при старте (main.tsx).
 */
export function initDeviceClasses(): () => void {
  if (!hasMatchMedia() || typeof document === 'undefined') {
    return () => {}
  }

  const root = document.documentElement
  const mqls = [
    window.matchMedia(QUERIES.phone),
    window.matchMedia(QUERIES.tablet),
    window.matchMedia(QUERIES.desktop),
    window.matchMedia(POINTER_QUERIES[0]),
  ]

  const apply = () => {
    root.classList.toggle('device-phone', mqls[0]!.matches)
    root.classList.toggle('device-tablet', mqls[1]!.matches)
    root.classList.toggle('device-desktop', mqls[2]!.matches)
    const coarse = mqls[3]!.matches
    root.classList.toggle('pointer-coarse', coarse)
  }

  apply()
  for (const mql of mqls) {
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', apply)
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(apply)
    }
  }

  return () => {
    for (const mql of mqls) {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', apply)
      } else if (typeof mql.removeListener === 'function') {
        mql.removeListener(apply)
      }
    }
  }
}

export function getDeviceType(): DeviceType {
  if (!hasMatchMedia()) return 'desktop'
  if (window.matchMedia(QUERIES.phone).matches) return 'phone'
  if (window.matchMedia(QUERIES.tablet).matches) return 'tablet'
  return 'desktop'
}

export function isCoarsePointer(): boolean {
  if (!hasMatchMedia()) return false
  return window.matchMedia(POINTER_QUERIES[0]).matches
}
