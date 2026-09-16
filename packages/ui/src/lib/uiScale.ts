import { isPwaStandalone } from './pwa'

export const UI_SCALE_MIN = 0.5
export const UI_SCALE_MAX = 1.2
export const UI_SCALE_STEP = 0.05
export const UI_SCALE_MOBILE_DEFAULT = 0.85
export const UI_SCALE_DESKTOP_DEFAULT = 1
export const UI_SCALE_DEFAULT = UI_SCALE_DESKTOP_DEFAULT
export const UI_SCALE_STORAGE_KEY = 'synth-ui-scale'

const PERSIST_DEBOUNCE_MS = 300

let persistTimer: ReturnType<typeof setTimeout> | null = null

let serverScaleMobile: number | null = null
let serverScaleDesktop: number | null = null

export function isMobileScaleDevice(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  const isMobileViewport =
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1199px)').matches
  return isMobileViewport || isPwaStandalone()
}

function toServerScale(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null
  }
  const parsed = typeof value === 'number' ? value : parseFloat(String(value))
  if (!Number.isFinite(parsed)) {
    return null
  }
  return normalizeUiScale(parsed)
}

export function setServerScaleDefaults(next: {
  mobile?: number | null
  desktop?: number | null
}): void {
  serverScaleMobile = toServerScale(next.mobile)
  serverScaleDesktop = toServerScale(next.desktop)
}

export function getBuiltInDefaultUiScale(): number {
  return isMobileScaleDevice() ? UI_SCALE_MOBILE_DEFAULT : UI_SCALE_DESKTOP_DEFAULT
}

export function getServerDefaultUiScale(): number | null {
  return isMobileScaleDevice() ? serverScaleMobile : serverScaleDesktop
}

export function getDefaultUiScale(): number {
  return getServerDefaultUiScale() ?? getBuiltInDefaultUiScale()
}

export function normalizeUiScale(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value))
  if (!Number.isFinite(parsed)) {
    return getDefaultUiScale()
  }
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, parsed))
}

export function readUiScale(): number {
  if (typeof window === 'undefined') {
    return UI_SCALE_DESKTOP_DEFAULT
  }
  try {
    const raw = window.localStorage.getItem(UI_SCALE_STORAGE_KEY)
    if (raw === null) {
      return getDefaultUiScale()
    }
    return normalizeUiScale(raw)
  } catch {
    return getDefaultUiScale()
  }
}

export function hasLocalUiScale(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  try {
    return window.localStorage.getItem(UI_SCALE_STORAGE_KEY) !== null
  } catch {
    return false
  }
}

export function applyServerDefaultUiScale(): boolean {
  if (hasLocalUiScale()) {
    return false
  }
  applyUiScale(getDefaultUiScale())
  return true
}

export function applyUiScale(scale: number): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.style.setProperty('--ui-scale', String(normalizeUiScale(scale)))
}

export function persistUiScale(scale: number): void {
  if (typeof window === 'undefined') {
    return
  }
  const normalized = normalizeUiScale(scale)
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
  }
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      window.localStorage.setItem(UI_SCALE_STORAGE_KEY, String(normalized))
    } catch {
      // localStorage может быть недоступен (приватный режим) — молча пропускаем
    }
  }, PERSIST_DEBOUNCE_MS)
}

export function setUiScale(scale: number): void {
  const normalized = normalizeUiScale(scale)
  applyUiScale(normalized)
  persistUiScale(normalized)
}
