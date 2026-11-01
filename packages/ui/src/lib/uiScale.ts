import { isPwaStandalone } from './pwa'

export const UI_SCALE_MIN = 0.5
export const UI_SCALE_MAX = 1.2
export const UI_SCALE_STEP = 0.05
export const UI_SCALE_MOBILE_DEFAULT = 0.85
export const UI_SCALE_DESKTOP_DEFAULT = 1
export const UI_SCALE_DEFAULT = UI_SCALE_DESKTOP_DEFAULT
export const UI_SCALE_STORAGE_KEY = 'synth-ui-scale'

/**
 * Масштаб области чата — независимый множитель **поверх** общего `--ui-scale`:
 * итог = `ui-scale × chat-scale`. Меняет только ленту сообщений
 * (`.chat-column`), панели/дерево/настройки/композер не затрагивает.
 */
export const CHAT_SCALE_DEFAULT = 1
export const CHAT_SCALE_MIN = 0.75
export const CHAT_SCALE_MAX = 1.5
export const CHAT_SCALE_STEP = 0.05
/** Нижняя граница в мобильной/тач-зоне: мельче текст в ленте уже не читается. */
export const CHAT_SCALE_MIN_TOUCH = 0.85
export const CHAT_SCALE_STORAGE_KEY = 'synth-chat-scale'

const PERSIST_DEBOUNCE_MS = 300

let persistTimer: ReturnType<typeof setTimeout> | null = null
// Отдельный таймер: масштаб UI и масштаб чата не должны схлопывать записи друг друга.
let chatPersistTimer: ReturnType<typeof setTimeout> | null = null

let serverScaleMobile: number | null = null
let serverScaleDesktop: number | null = null
// Серверные умолчания масштаба чата (паритет с uiScale: mobile/desktop).
let serverChatScaleMobile: number | null = null
let serverChatScaleDesktop: number | null = null
// Личный масштаб чата уже применён (профиль или явный выбор пользователя):
// серверное умолчание не должно его перекрывать, даже если в localStorage
// значения ещё нет (запись дебаунсится).
let personalChatScale = false

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

/**
 * Нижняя граница масштаба чата для текущего устройства: на телефоне/планшете
 * (и в PWA) — `CHAT_SCALE_MIN_TOUCH` (тач-эргономика), на десктопе — `CHAT_SCALE_MIN`.
 */
export function getChatScaleMin(): number {
  return isMobileScaleDevice() ? CHAT_SCALE_MIN_TOUCH : CHAT_SCALE_MIN
}

/**
 * Кламп масштаба чата к общему диапазону `0.75…1.5` **без** мобильного минимума.
 *
 * Нужен там, где значение задаётся для всех устройств сразу (админ-панель
 * умолчаний): мобильный предел `0.85` применяется уже на клиенте при показе.
 */
export function clampChatScale(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value))
  if (!Number.isFinite(parsed)) {
    return CHAT_SCALE_DEFAULT
  }
  return Math.min(CHAT_SCALE_MAX, Math.max(CHAT_SCALE_MIN, parsed))
}

export function normalizeChatScale(value: unknown): number {
  const clamped = clampChatScale(value)
  return Math.max(getChatScaleMin(), clamped)
}

export function readChatScale(): number {
  if (typeof window === 'undefined') {
    return CHAT_SCALE_DEFAULT
  }
  try {
    const raw = window.localStorage.getItem(CHAT_SCALE_STORAGE_KEY)
    if (raw === null) {
      return CHAT_SCALE_DEFAULT
    }
    return normalizeChatScale(raw)
  } catch {
    return CHAT_SCALE_DEFAULT
  }
}

export function hasLocalChatScale(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  try {
    return window.localStorage.getItem(CHAT_SCALE_STORAGE_KEY) !== null
  } catch {
    return false
  }
}

/**
 * Есть ли у пользователя личный масштаб чата: сохранённый локально или уже
 * применённый из профиля/настроек в этой сессии (запись в localStorage идёт
 * с дебаунсом, поэтому одного ключа недостаточно).
 */
export function hasPersonalChatScale(): boolean {
  return personalChatScale || hasLocalChatScale()
}

function toServerChatScale(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null
  }
  const parsed = typeof value === 'number' ? value : parseFloat(String(value))
  if (!Number.isFinite(parsed)) {
    return null
  }
  // Серверное значение храним в общем диапазоне: мобильный предел
  // применяется при выдаче (`getServerDefaultChatScale`).
  return clampChatScale(parsed)
}

/** Серверные умолчания масштаба чата инстанса (mobile/desktop). */
export function setServerChatScaleDefaults(next: {
  mobile?: number | null
  desktop?: number | null
}): void {
  serverChatScaleMobile = toServerChatScale(next.mobile)
  serverChatScaleDesktop = toServerChatScale(next.desktop)
}

/**
 * Серверное умолчание масштаба чата для текущего устройства (с мобильным
 * минимумом). `null` — умолчание не задано.
 */
export function getServerDefaultChatScale(): number | null {
  const server = isMobileScaleDevice() ? serverChatScaleMobile : serverChatScaleDesktop
  return server === null ? null : normalizeChatScale(server)
}

export function getDefaultChatScale(): number {
  return getServerDefaultChatScale() ?? CHAT_SCALE_DEFAULT
}

/**
 * Применить личный масштаб чата (из профиля) — только если у пользователя
 * ещё нет своего значения (localStorage или явный выбор в этой сессии).
 * Возвращает `true`, если значение применено.
 */
export function applyPersonalChatScale(scale: number): boolean {
  if (hasPersonalChatScale()) {
    return false
  }
  personalChatScale = true
  applyChatScale(scale)
  return true
}

/**
 * Применить серверное умолчание масштаба чата, только если личного значения
 * нет. Возвращает `true`, если значение применено.
 */
export function applyServerDefaultChatScale(): boolean {
  if (hasPersonalChatScale()) {
    return false
  }
  applyChatScale(getDefaultChatScale())
  return true
}

/** Ставит `--chat-scale` инлайном на `<html>`; общий `--ui-scale` не трогает. */
export function applyChatScale(scale: number): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.style.setProperty('--chat-scale', String(normalizeChatScale(scale)))
}

export function persistChatScale(scale: number): void {
  if (typeof window === 'undefined') {
    return
  }
  const normalized = normalizeChatScale(scale)
  // Запись личного значения (Save в настройках): умолчания его не перекрывают.
  personalChatScale = true
  if (chatPersistTimer !== null) {
    clearTimeout(chatPersistTimer)
  }
  chatPersistTimer = setTimeout(() => {
    chatPersistTimer = null
    try {
      window.localStorage.setItem(CHAT_SCALE_STORAGE_KEY, String(normalized))
    } catch {
      // localStorage может быть недоступен (приватный режим) — молча пропускаем
    }
  }, PERSIST_DEBOUNCE_MS)
}

export function setChatScale(scale: number): void {
  const normalized = normalizeChatScale(scale)
  // Явный выбор пользователя: серверное/профильное умолчание его не перекрывает.
  personalChatScale = true
  applyChatScale(normalized)
  persistChatScale(normalized)
}
