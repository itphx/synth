import { describe, it, expect } from 'vitest'
import {
  ANSI_COLOR_KEYS,
  DEFAULT_TERMINAL_PALETTE,
  TERMINAL_SCHEMES,
  TERMINAL_SCHEME_IDS,
  contrastRatio,
  resolveTerminalTheme,
  shiftLightness,
  themeToTerminalPalette,
  type TerminalPalette,
} from './terminal'
import { themes, getThemeById } from './themes'

const SYNTH_DARK = getThemeById('synthesis-dark')
const SYNTH_LIGHT = getThemeById('synthesis-light')

function expectFullPalette(palette: TerminalPalette, label: string) {
  for (const key of ANSI_COLOR_KEYS) {
    expect(typeof palette[key], `${label}.${key}`).toBe('string')
    expect(palette[key].length, `${label}.${key} пуст`).toBeGreaterThan(0)
  }
  expect(palette.background.length, `${label}.background`).toBeGreaterThan(0)
  expect(palette.foreground.length, `${label}.foreground`).toBeGreaterThan(0)
  expect(palette.cursor.length, `${label}.cursor`).toBeGreaterThan(0)
  expect(palette.selectionBackground.length, `${label}.selectionBackground`).toBeGreaterThan(0)
}

describe('палитра терминала (PROP-132)', () => {
  it('встроенные схемы: контраст текста к фону ≥ 4.5:1', () => {
    for (const id of TERMINAL_SCHEME_IDS) {
      const scheme = TERMINAL_SCHEMES[id]
      const ratio = contrastRatio(scheme.foreground, scheme.background)
      expect(ratio, `${id}: fg/bg`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('встроенные схемы: на месте все 16 ANSI-цветов', () => {
    for (const id of TERMINAL_SCHEME_IDS) {
      expectFullPalette(TERMINAL_SCHEMES[id], id)
      expect(Object.keys(TERMINAL_SCHEMES[id]).length).toBe(ANSI_COLOR_KEYS.length + 5)
    }
  })

  it('встроенные схемы: красный и зелёный не совпадают с фоном', () => {
    for (const id of TERMINAL_SCHEME_IDS) {
      const scheme = TERMINAL_SCHEMES[id]
      expect(scheme.red.toLowerCase(), `${id}.red`).not.toBe(scheme.background.toLowerCase())
      expect(scheme.green.toLowerCase(), `${id}.green`).not.toBe(scheme.background.toLowerCase())
    }
  })

  it('встроенных схем восемь: Synth/Solarized/Dracula/One Dark/GitHub', () => {
    expect(TERMINAL_SCHEME_IDS.sort()).toEqual(
      [
        'dracula',
        'github-dark',
        'github-light',
        'one-dark',
        'solarized-dark',
        'solarized-light',
        'synth-dark',
        'synth-light',
      ].sort(),
    )
  })

  it('маппинг темы интерфейса даёт полную палитру', () => {
    for (const theme of themes) {
      expectFullPalette(themeToTerminalPalette(theme), theme.metadata.id)
    }
  })

  it('маппинг темы интерфейса детерминирован', () => {
    expect(SYNTH_DARK).toBeDefined()
    if (!SYNTH_DARK) return
    expect(themeToTerminalPalette(SYNTH_DARK)).toEqual(themeToTerminalPalette(SYNTH_DARK))
  })

  it('маппинг темы: красный/зелёный/жёлтый/синий берутся из статусных токенов', () => {
    expect(SYNTH_DARK).toBeDefined()
    if (!SYNTH_DARK) return
    const palette = themeToTerminalPalette(SYNTH_DARK)
    expect(palette.red.toLowerCase()).toBe(SYNTH_DARK.colors.status.error.toLowerCase())
    expect(palette.green.toLowerCase()).toBe(SYNTH_DARK.colors.status.success.toLowerCase())
    expect(palette.yellow.toLowerCase()).toBe(SYNTH_DARK.colors.status.warning.toLowerCase())
    expect(palette.blue.toLowerCase()).toBe(SYNTH_DARK.colors.status.info.toLowerCase())
    expect(palette.magenta.toLowerCase()).toBe(SYNTH_DARK.colors.primary.base.toLowerCase())
    expect(palette.background.toLowerCase()).toBe(SYNTH_DARK.colors.surface.background.toLowerCase())
  })

  it('resolveTerminalTheme: «ui» → маппинг темы, схема → статическая палитра', () => {
    expect(SYNTH_DARK).toBeDefined()
    if (!SYNTH_DARK) return
    expect(resolveTerminalTheme('ui', SYNTH_DARK)).toEqual(themeToTerminalPalette(SYNTH_DARK))
    expect(resolveTerminalTheme('dracula', SYNTH_DARK)).toEqual(TERMINAL_SCHEMES.dracula)
  })

  it('resolveTerminalTheme: неизвестная схема → палитра темы (без молчаливого сбоя)', () => {
    expect(SYNTH_LIGHT).toBeDefined()
    if (!SYNTH_LIGHT) return
    expect(resolveTerminalTheme('no-such-scheme', SYNTH_LIGHT)).toEqual(
      themeToTerminalPalette(SYNTH_LIGHT),
    )
    expect(resolveTerminalTheme(undefined, SYNTH_LIGHT)).toEqual(
      themeToTerminalPalette(SYNTH_LIGHT),
    )
  })

  it('shiftLightness меняет светлоту в нужную сторону', () => {
    expect(shiftLightness('#808080', 0.2)).toBe('#b3b3b3')
    expect(shiftLightness('#808080', -0.2)).toBe('#4d4d4d')
    // Нераспознанный цвет не ломает палитру.
    expect(shiftLightness('не цвет', 0.2)).toBe('не цвет')
  })

  it('без темы возвращается палитра по умолчанию, а не исключение', () => {
    expect(themeToTerminalPalette(undefined)).toEqual(DEFAULT_TERMINAL_PALETTE)
    expect(themeToTerminalPalette(null)).toEqual(DEFAULT_TERMINAL_PALETTE)
    expect(DEFAULT_TERMINAL_PALETTE).toEqual(TERMINAL_SCHEMES['synth-dark'])
    expectFullPalette(DEFAULT_TERMINAL_PALETTE, 'default')
  })

  it('resolveTerminalTheme без темы: «ui» → дефолт, схема → своя палитра', () => {
    expect(resolveTerminalTheme('ui', undefined)).toEqual(DEFAULT_TERMINAL_PALETTE)
    expect(resolveTerminalTheme('ui', null)).toEqual(DEFAULT_TERMINAL_PALETTE)
    expect(resolveTerminalTheme('dracula', undefined)).toEqual(TERMINAL_SCHEMES.dracula)
    expect(resolveTerminalTheme('no-such-scheme', undefined)).toEqual(DEFAULT_TERMINAL_PALETTE)
  })
})
