/**
 * Настройки внешнего вида терминала (PROP-132, Ф4a).
 *
 * Хранятся в `ProfileData.preferences.terminal` (сервер, `PATCH
 * /auth/profile/preferences`) и дублируются в локальном кэше
 * `useUIStore.terminalPreferences` — чтобы терминал стартовал сразу, до
 * ответа профиля.
 *
 * Диапазоны значений — здесь (единое место): валидация на сервере не нужна,
 * клиент режет значения сам, а нормализация при чтении профиля гарантирует,
 * что битое значение не сломает xterm.
 */

import type { TerminalThemePreference } from '@/lib/theme/terminal'

/** Настройки терминала. */
export interface TerminalPreferences {
  /** Тема: «как интерфейс» или id встроенной схемы. */
  theme: TerminalThemePreference
  /** Моноширинный шрифт (семейство). */
  fontFamily: string
  /** Размер шрифта, px. */
  fontSize: number
  /** Межстрочный интервал. */
  lineHeight: number
  /** Межбуквенный интервал, px. */
  letterSpacing: number
  /** Стиль курсора. */
  cursorStyle: TerminalCursorStyle
  /** Мигающий курсор. */
  cursorBlink: boolean
  /** Размер буфера прокрутки, строк. */
  scrollback: number
  /** Звонок терминала. */
  bell: boolean
}

export type TerminalCursorStyle = 'block' | 'underline' | 'bar'

/** Стили курсора xterm.js. */
export const TERMINAL_CURSOR_STYLES: TerminalCursorStyle[] = ['block', 'underline', 'bar']

/** Моноширинные шрифты, доступные в терминале (совпадают со стеком интерфейса). */
export const TERMINAL_FONT_OPTIONS: string[] = [
  'IBM Plex Mono',
  'JetBrains Mono',
  'Fira Code',
  'SF Mono',
  'Menlo',
  'Consolas',
  'monospace',
]

export const TERMINAL_FONT_SIZE_MIN = 10
export const TERMINAL_FONT_SIZE_MAX = 24
export const TERMINAL_LINE_HEIGHT_MIN = 1
export const TERMINAL_LINE_HEIGHT_MAX = 1.6
export const TERMINAL_LETTER_SPACING_MIN = 0
export const TERMINAL_LETTER_SPACING_MAX = 4
export const TERMINAL_SCROLLBACK_MIN = 1000
export const TERMINAL_SCROLLBACK_MAX = 20000

/** Значения по умолчанию (и «Reset» в настройках). */
export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  theme: 'ui',
  fontFamily: 'IBM Plex Mono',
  fontSize: 13,
  lineHeight: 1.2,
  letterSpacing: 0,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 5000,
  bell: false,
}

/** Минимальный размер шрифта на мобильном (ADR-044: не мельче 12 px). */
export const TERMINAL_FONT_SIZE_MOBILE_MIN = 12

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max))
}

/**
 * Санитизация настроек: битые значения из профиля/кэша заменяются дефолтом,
 * значения вне диапазонов — подрезаются. Функция не бросает исключений —
 * кривой профиль не должен ломать запуск терминала.
 */
export function normalizeTerminalPreferences(raw: unknown): TerminalPreferences {
  const input = (raw ?? {}) as Partial<TerminalPreferences>
  const fontFamily =
    typeof input.fontFamily === 'string' && input.fontFamily.trim() !== ''
      ? input.fontFamily.trim()
      : DEFAULT_TERMINAL_PREFERENCES.fontFamily
  const cursorStyle = TERMINAL_CURSOR_STYLES.includes(input.cursorStyle as TerminalCursorStyle)
    ? (input.cursorStyle as TerminalCursorStyle)
    : DEFAULT_TERMINAL_PREFERENCES.cursorStyle
  return {
    theme:
      typeof input.theme === 'string' && (input.theme as string) !== ''
        ? (input.theme as TerminalThemePreference)
        : DEFAULT_TERMINAL_PREFERENCES.theme,
    fontFamily,
    fontSize: clampInt(
      Number(input.fontSize ?? DEFAULT_TERMINAL_PREFERENCES.fontSize),
      TERMINAL_FONT_SIZE_MIN,
      TERMINAL_FONT_SIZE_MAX,
    ),
    lineHeight: clamp(
      Number(input.lineHeight ?? DEFAULT_TERMINAL_PREFERENCES.lineHeight),
      TERMINAL_LINE_HEIGHT_MIN,
      TERMINAL_LINE_HEIGHT_MAX,
    ),
    letterSpacing: clamp(
      Number(input.letterSpacing ?? DEFAULT_TERMINAL_PREFERENCES.letterSpacing),
      TERMINAL_LETTER_SPACING_MIN,
      TERMINAL_LETTER_SPACING_MAX,
    ),
    cursorStyle,
    cursorBlink:
      typeof input.cursorBlink === 'boolean'
        ? input.cursorBlink
        : DEFAULT_TERMINAL_PREFERENCES.cursorBlink,
    scrollback: clampInt(
      Number(input.scrollback ?? DEFAULT_TERMINAL_PREFERENCES.scrollback),
      TERMINAL_SCROLLBACK_MIN,
      TERMINAL_SCROLLBACK_MAX,
    ),
    bell: typeof input.bell === 'boolean' ? input.bell : DEFAULT_TERMINAL_PREFERENCES.bell,
  }
}

/** Стек шрифтов терминала: выбранный моноширинный + символьный шрифт + fallback. */
export function terminalFontStack(fontFamily: string): string {
  const family = fontFamily.trim() || DEFAULT_TERMINAL_PREFERENCES.fontFamily
  if (family === 'monospace') return 'monospace, "Synth Nerd Symbols", monospace'
  return `"${family}", "Synth Nerd Symbols", monospace`
}
