/**
 * Палитра терминала (PROP-132, Ф4a).
 *
 * Два источника палитры:
 *
 * 1. **«Как интерфейс»** (`themeToTerminalPalette`) — детерминированный маппинг
 *    токенов темы Synth в ANSI-16 + `fg/bg/cursor/selection`.
 * 2. **Встроенные терминальные схемы** (`TERMINAL_SCHEMES`) — статические
 *    палитры (Synth Dark/Light, Solarized Dark/Light, Dracula, One Dark,
 *    GitHub Dark/Light). Они не зависят от темы интерфейса и выбираются явно.
 *
 * Маппинг токенов (почему именно такие):
 *
 * | ANSI          | токен темы                                    | почему |
 * |---------------|-----------------------------------------------|--------|
 * | `black`       | `surface.muted`                               | приглушённый «фоновый» тон; ANSI-чёрный редко несёт смысловой текст |
 * | `red`         | `status.error`                                | единственный семантический красный в теме |
 * | `green`       | `status.success`                              | единственный семантический зелёный |
 * | `yellow`      | `status.warning`                              | единственный семантический жёлтый |
 * | `blue`        | `status.info`                                 | единственный семантический синий |
 * | `magenta`     | `primary.base`                                | акцент темы — самый «свой» цвет палитры |
 * | `cyan`        | `syntax.base.string`                          | строки в подсветке синтаксиса — холодный тон |
 * | `white`       | `surface.foreground`                          | основной текст |
 * | `bright*`     | тот же токен, светлость скорректирована        | «яркая» пара — более заметная к фону |
 * | `brightCyan`  | `syntax.base.function`                        | отличается от `cyan` (`string`), иначе два тона совпали бы |
 * | `brightWhite` | `surface.raisedForeground`                    | самый светлый текстовый тон |
 * | `brightBlack` | `surface.mutedForeground`                     | приглушённый, но читаемый серый |
 *
 * Чего в `Theme` не хватает для полного ANSI-16: отдельных токенов
 * «жёлтый/зелёный/синий/пурпурный» вне семантических статусов — палитра
 * ограничена 4 статусными + акцентом + синтаксисом, поэтому 16 цветов
 * собираются из этих шести источников. Отдельного токена «коричневый» (ANSI
 * `yellow` в некоторых схемах) тоже нет — `status.warning` его замещает.
 *
 * Правило «яркости»: на тёмном фоне яркие тона светлее (`+16 %` светлоты),
 * на светлом — темнее (`−14 %`): «яркий» = «более заметный на своём фоне».
 */

import type { Theme } from '@/types/theme'

/** Палитра xterm.js: ANSI-16 + оформление. */
export interface TerminalPalette {
  foreground: string
  background: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** Имена 16 базовых ANSI-цветов (для проверок полноты палитры). */
export const ANSI_COLOR_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

export type AnsiColorKey = (typeof ANSI_COLOR_KEYS)[number]

// ─── Работа с цветом ────────────────────────────────────────────────────────

interface Rgb {
  r: number
  g: number
  b: number
}

function parseHex(value: string | undefined | null): Rgb | null {
  if (!value) return null
  const raw = value.trim().replace(/^#/, '')
  if (raw.length === 3) {
    const [r, g, b] = raw.split('')
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16) }
  }
  if (raw.length === 6 || raw.length === 8) {
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16),
    }
  }
  return null
}

function toHex(rgb: Rgb): string {
  const part = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const delta = max - min
  if (delta === 0) return { h: 0, s: 0, l }
  const s = delta / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / delta) % 6
  else if (max === gn) h = (bn - rn) / delta + 2
  else h = (rn - gn) / delta + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const seg = Math.floor(h / 60) % 6
  const table: Array<[number, number, number]> = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ]
  const [r, g, b] = table[seg] ?? [0, 0, 0]
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

/**
 * Сдвиг светлоты цвета (HSL). `delta > 0` — светлее, `delta < 0` — темнее.
 * Нераспознанный цвет возвращается как есть.
 */
export function shiftLightness(color: string, delta: number): string {
  const rgb = parseHex(color)
  if (!rgb) return color
  const hsl = rgbToHsl(rgb)
  return toHex(hslToRgb({ ...hsl, l: Math.max(0, Math.min(1, hsl.l + delta)) }))
}

/** Относительная яркость по WCAG. */
export function relativeLuminance(color: string): number {
  const rgb = parseHex(color)
  if (!rgb) return 0
  const channel = (value: number) => {
    const v = value / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/** Контраст двух цветов по WCAG (1:1 … 21:1). */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

// ─── Маппинг темы интерфейса ────────────────────────────────────────────────

/**
 * Палитра терминала из темы интерфейса.
 *
 * Детерминированная функция: одна и та же тема — одна и та же палитра.
 * Неизвестные/отсутствующие токены заменяются безопасными значениями
 * (палитра всегда полная — 16 ANSI).
 *
 * Тема может не прийти (тема ещё не загружена, мок без `currentTheme`) —
 * тогда возвращается `DEFAULT_TERMINAL_PALETTE`, а не исключение: падать
 * на пустом `theme.colors` нельзя.
 */
export function themeToTerminalPalette(theme: Theme | undefined | null): TerminalPalette {
  if (!theme || !theme.colors || !theme.colors.surface) return DEFAULT_TERMINAL_PALETTE
  const colors = theme.colors
  const surface = colors.surface
  const interactive = colors.interactive
  const status = colors.status
  const syntax = colors.syntax?.base
  const isDark = theme.metadata?.variant === 'dark'
  const delta = isDark ? 0.16 : -0.14

  const background = surface.background || '#000000'
  const foreground = surface.foreground || '#ffffff'
  const bright = (color: string) => shiftLightness(color, delta)

  const black = surface.muted || background
  const brightBlack = surface.mutedForeground || foreground
  const white = foreground
  const brightWhite = surface.raisedForeground || foreground

  const red = status.error || '#cd3131'
  const green = status.success || '#0dbc79'
  const yellow = status.warning || '#e5e510'
  const blue = status.info || '#2472c8'
  const magenta = colors.primary?.base || '#bc3fbc'
  const cyan = syntax?.string || '#11a8cd'
  const brightCyan = syntax?.function || cyan

  return {
    background,
    foreground,
    cursor: interactive.cursor || foreground,
    cursorAccent: background,
    selectionBackground: interactive.selection || interactive.active || 'rgba(128,128,128,0.35)',
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed: bright(red),
    brightGreen: bright(green),
    brightYellow: bright(yellow),
    brightBlue: bright(blue),
    brightMagenta: bright(magenta),
    brightCyan,
    brightWhite,
  }
}

// ─── Встроенные схемы ───────────────────────────────────────────────────────

function palette(input: {
  background: string
  foreground: string
  cursor: string
  selection: string
  ansi: [string, string, string, string, string, string, string, string]
  bright: [string, string, string, string, string, string, string, string]
}): TerminalPalette {
  const [black, red, green, yellow, blue, magenta, cyan, white] = input.ansi
  const [
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = input.bright
  return {
    background: input.background,
    foreground: input.foreground,
    cursor: input.cursor,
    cursorAccent: input.background,
    selectionBackground: input.selection,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  }
}

/**
 * Встроенные терминальные схемы.
 *
 * Значения статические и не зависят от темы интерфейса — это «настоящие»
 * палитры известных терминальных тем (палитры те же, что у VS Code/Dracula/
 * Solarized), чтобы переключение не зависело от наличия соответствующей темы
 * в каталоге Synth.
 */
export const TERMINAL_SCHEMES = {
  'synth-dark': palette({
    background: '#1C1917',
    foreground: '#E7E5E4',
    cursor: '#fafaf9',
    selection: '#e7e5e429',
    ansi: ['#302d2b', '#d55c51', '#879A39', '#D0A215', '#3AA99F', '#CA6008', '#3fb8ad', '#ada7a3'],
    bright: ['#a8a29e', '#e07a70', '#a3b455', '#e0b93b', '#5cc4ba', '#e0782b', '#5cc4ba', '#E7E5E4'],
  }),
  'synth-light': palette({
    background: '#FAF8F3',
    foreground: '#1C1917',
    cursor: '#100f0f',
    selection: '#1c191724',
    ansi: ['#cccac5', '#AF3029', '#627b0b', '#8f6c01', '#237f77', '#CA6008', '#1a5f59', '#555450'],
    bright: ['#474743', '#8f2019', '#485a08', '#6b5101', '#1a5f59', '#a64f07', '#1d5495', '#1C1917'],
  }),
  'solarized-dark': palette({
    background: '#002b36',
    foreground: '#93a1a1',
    cursor: '#93a1a1',
    selection: '#07364280',
    ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
    bright: ['#586e75', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'],
  }),
  'solarized-light': palette({
    background: '#fdf6e3',
    foreground: '#586e75',
    cursor: '#586e75',
    selection: '#eee8d580',
    ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
    bright: ['#002b36', '#cb4b16', '#657b83', '#93a1a1', '#839496', '#6c71c4', '#586e75', '#073642'],
  }),
  dracula: palette({
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    selection: '#44475a80',
    ansi: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'],
    bright: ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'],
  }),
  'one-dark': palette({
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#abb2bf',
    selection: '#3e445180',
    ansi: ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf'],
    bright: ['#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'],
  }),
  'github-dark': palette({
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#c9d1d9',
    selection: '#30363d80',
    ansi: ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4'],
    bright: ['#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc'],
  }),
  'github-light': palette({
    background: '#ffffff',
    foreground: '#24292f',
    cursor: '#24292f',
    selection: '#afb8c180',
    ansi: ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781'],
    bright: ['#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#24292f'],
  }),
} as const

export type TerminalSchemeId = keyof typeof TERMINAL_SCHEMES

/**
 * Палитра по умолчанию — «Synth Dark».
 *
 * Используется, когда тема интерфейса недоступна (тема ещё не загружена,
 * битый ответ сервера, мок без `currentTheme`): терминал обязан показать
 * читаемую картинку, а не упасть.
 */
export const DEFAULT_TERMINAL_PALETTE: TerminalPalette = TERMINAL_SCHEMES['synth-dark']

/** Идентификаторы встроенных схем (для выпадающих списков и i18n). */
export const TERMINAL_SCHEME_IDS = Object.keys(TERMINAL_SCHEMES) as TerminalSchemeId[]

/** Выбор пользователя: «как интерфейс» или конкретная схема. */
export type TerminalThemePreference = 'ui' | TerminalSchemeId

/** Значение по умолчанию — палитра как в интерфейсе. */
export const DEFAULT_TERMINAL_THEME: TerminalThemePreference = 'ui'

/**
 * Разрешение палитры терминала.
 *
 * `'ui'` → маппинг токенов темы; иначе — встроенная схема. Неизвестная схема
 * (старый профиль/битое значение) — фоллбек на палитру темы интерфейса,
 * «молчаливый» сбой не допускается.
 *
 * Тема может отсутствовать (`undefined`/`null`) — тогда маппинг даёт
 * `DEFAULT_TERMINAL_PALETTE`; встроенная схема при этом работает как обычно.
 */
export function resolveTerminalTheme(
  preference: TerminalThemePreference | string | undefined | null,
  theme: Theme | undefined | null,
): TerminalPalette {
  if (!preference || preference === 'ui') return themeToTerminalPalette(theme)
  const scheme = TERMINAL_SCHEMES[preference as TerminalSchemeId]
  if (scheme) return scheme
  return themeToTerminalPalette(theme)
}
