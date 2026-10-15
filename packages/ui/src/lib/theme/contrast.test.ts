import { describe, expect, it } from 'vitest'

import { themes } from '@/lib/theme/themes'
import type { Theme } from '@/types/theme'

/**
 * Контраст тем по WCAG 2.1 — считается прямо в тесте (нулевые зависимости,
 * детерминировано). Проверяются пары «текст на фоне» из `types/theme.ts`:
 * обычный текст — ≥ 4.5:1 (AA), крупный текст/код (`syntax.base`) — ≥ 3.0:1.
 *
 * Полупрозрачные цвета (8-значный hex, `#RRGGBBAA`) раскладываются compositing-ом
 * на непрозрачный фон (по умолчанию — белый; для пар из реестра тем alpha не
 * встречается, поэтому результат совпадает с «плоским» расчётом).
 */

type Rgba = { r: number; g: number; b: number; a: number }

const OPAQUE_WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 }

/** Порог AA для обычного текста. */
const AA_NORMAL_TEXT = 4.5
/** Порог AA для крупного текста (в т.ч. блоки кода). */
const AA_LARGE_TEXT = 3.0

/** `#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA` → sRGB-каналы в 0..1. */
function parseHex(input: string): Rgba {
  const hex = input.trim().replace(/^#/, '')
  const expanded =
    hex.length === 3 || hex.length === 4 ? hex.split('').map((c) => c + c).join('') : hex

  if (expanded.length !== 6 && expanded.length !== 8) {
    throw new Error(`Ожидался hex-цвет (#RGB/#RGBA/#RRGGBB/#RRGGBBAA), получено: ${input}`)
  }

  const channel = (from: number) => parseInt(expanded.slice(from, from + 2), 16) / 255
  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    a: expanded.length === 8 ? channel(6) : 1,
  }
}

/** Source-over: наложение слоя `fg` на `bg`. */
function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  }
}

/** Раскладывает цвет на непрозрачный backdrop. */
function flatten(color: Rgba, backdrop: Rgba = OPAQUE_WHITE): Rgba {
  const base = backdrop.a >= 1 ? backdrop : compositeOver(backdrop, OPAQUE_WHITE)
  return compositeOver(color, base)
}

/** Относительная яркость по WCAG 2.1. */
function relativeLuminance({ r, g, b }: Rgba): number {
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** Контрастное отношение `(L_hi + 0.05) / (L_lo + 0.05)`. */
function contrastRatio(fgHex: string, bgHex: string, backdrop: Rgba = OPAQUE_WHITE): number {
  const bg = flatten(parseHex(bgHex), backdrop)
  const fg = flatten(parseHex(fgHex), bg)
  const l1 = relativeLuminance(fg)
  const l2 = relativeLuminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

type TextPairId =
  | 'text'
  | 'mutedText'
  | 'mutedOnMuted'
  | 'subtleText'
  | 'elevated'
  | 'raised'
  | 'primary'
  | 'error'
  | 'warning'
  | 'success'
  | 'info'

interface TextPair {
  id: TextPairId
  /** Что за пара — для сообщения об ошибке. */
  label: string
  resolve: (theme: Theme) => [string, string]
  /**
   * Исторический минимум по всем темам (измерен на наборе из 62 тем). Падение
   * ниже означает регрессию палитры: значение нужно осознанно обновить, а не
   * ослабить порог. Минимум может расти (улучшение) — это тест не ломает.
   */
  minRatio: number
}

const surface = (theme: Theme) => theme.colors.surface

/**
 * 11 текстовых пар (по полям `Theme['colors']`), порог AA 4.5 для каждой темы.
 * Минимумы: surface 5.76, muted/background 4.62, muted 5.09, subtle 6.44,
 * elevated 4.50, raised 4.51, primary 4.71, error 4.75, warning 4.55,
 * success 4.62, info 4.58.
 */
const TEXT_PAIRS: TextPair[] = [
  {
    id: 'text',
    label: 'surface.foreground на surface.background',
    resolve: (t) => [surface(t).foreground, surface(t).background],
    minRatio: 5.7638,
  },
  {
    id: 'mutedText',
    label: 'surface.mutedForeground на surface.background',
    resolve: (t) => [surface(t).mutedForeground, surface(t).background],
    minRatio: 4.6193,
  },
  {
    id: 'mutedOnMuted',
    label: 'surface.mutedForeground на surface.muted',
    resolve: (t) => [surface(t).mutedForeground, surface(t).muted],
    minRatio: 5.0921,
  },
  {
    id: 'subtleText',
    label: 'surface.foreground на surface.subtle',
    resolve: (t) => [surface(t).foreground, surface(t).subtle],
    minRatio: 6.4388,
  },
  {
    id: 'elevated',
    label: 'surface.elevatedForeground на surface.elevated',
    resolve: (t) => [surface(t).elevatedForeground, surface(t).elevated],
    minRatio: 4.5001,
  },
  {
    id: 'raised',
    label: 'surface.raisedForeground на surface.raised (фоллбек на elevated)',
    resolve: (t) => [
      surface(t).raisedForeground ?? surface(t).elevatedForeground,
      surface(t).raised ?? surface(t).elevated,
    ],
    minRatio: 4.5092,
  },
  {
    id: 'primary',
    label: 'primary.foreground на primary.base (фоллбек #ffffff, как в cssGenerator)',
    resolve: (t) => [t.colors.primary.foreground || '#ffffff', t.colors.primary.base],
    minRatio: 4.7096,
  },
  {
    id: 'error',
    label: 'status.errorForeground на status.error',
    resolve: (t) => [t.colors.status.errorForeground, t.colors.status.error],
    minRatio: 4.7461,
  },
  {
    id: 'warning',
    label: 'status.warningForeground на status.warning',
    resolve: (t) => [t.colors.status.warningForeground, t.colors.status.warning],
    minRatio: 4.5488,
  },
  {
    id: 'success',
    label: 'status.successForeground на status.success',
    resolve: (t) => [t.colors.status.successForeground, t.colors.status.success],
    minRatio: 4.6173,
  },
  {
    id: 'info',
    label: 'status.infoForeground на status.info',
    resolve: (t) => [t.colors.status.infoForeground, t.colors.status.info],
    minRatio: 4.5767,
  },
]

/** Допуск сравнения зафиксированного минимума (плавающие операции). */
const MIN_RATIO_EPSILON = 1e-4

/**
 * Пары «чип статуса»/`syntax` считаются по 4.5, кроме тем ниже: там контраст
 * `syntax.base` ниже AA, но выше порога крупного текста. Это свойство исходных
 * апстрим-палитр (низкоконтрастный фон блоков кода), а не дефект токенов —
 * править палитры не нужно.
 */
const SYNTAX_BELOW_AA: Record<string, { ratio: number; reason: string }> = {
  'solarized-dark': { ratio: 3.29, reason: 'апстрим Solarized: намеренно приглушённый base03' },
  'solarized-light': { ratio: 3.31, reason: 'апстрим Solarized: приглушённый base3' },
  'everforest-light': { ratio: 3.42, reason: 'апстрим Everforest (light): мягкий фон' },
  'palenight-dark': { ratio: 3.51, reason: 'апстрим Palenight' },
  'one-dark-dark': { ratio: 3.74, reason: 'апстрим One Dark' },
  'catppuccin-light': { ratio: 4.14, reason: 'апстрим Catppuccin Latte' },
  'everforest-dark': { ratio: 4.27, reason: 'апстрим Everforest (dark)' },
  'ayu-light': { ratio: 4.47, reason: 'апстрим Ayu Light: на границе AA' },
}

/** Допуск сравнения зафиксированного контраста синтаксиса (записан с 2 знаками). */
const RECORDED_SYNTAX_RATIO_TOLERANCE = 0.0051

/** `palette.colors[].contrast` записан с округлением до 2 знаков. */
const PALETTE_CONTRAST_TOLERANCE = 0.0051

const syntaxRatio = (theme: Theme) =>
  contrastRatio(
    theme.colors.syntax.base.foreground,
    theme.colors.syntax.base.background,
  )

describe('contrast — расчёт контраста (WCAG 2.1)', () => {
  it('крайние случаи: белое на чёрном — 21:1, цвет на самом себе — 1:1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 10)
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10)
    expect(contrastRatio('#3aa99f', '#3aa99f')).toBeCloseTo(1, 10)
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 10)
  })

  it('полупрозрачный текст раскладывается на фон (а не считается как чёрный)', () => {
    // #00000080 ≈ 50.2% чёрного на белом = #7f7f7f (127/255) — эталонный серый.
    expect(contrastRatio('#00000080', '#ffffff')).toBeCloseTo(
      contrastRatio('#7f7f7f', '#ffffff'),
      3,
    )
    // Полупрозрачный фон так же раскладывается на backdrop.
    expect(contrastRatio('#ffffff', '#00000080')).toBeCloseTo(
      contrastRatio('#ffffff', '#7f7f7f'),
      3,
    )
  })
})

describe('contrast — текстовые пары в реестре тем', () => {
  it('реестр тем не пустой', () => {
    expect(themes.length).toBeGreaterThanOrEqual(62)
  })

  it(`все ${themes.length} тем: 11 текстовых пар ≥ ${AA_NORMAL_TEXT}:1`, () => {
    const failures: string[] = []

    for (const theme of themes) {
      for (const pair of TEXT_PAIRS) {
        const [fg, bg] = pair.resolve(theme)
        const ratio = contrastRatio(fg, bg)
        if (ratio < AA_NORMAL_TEXT) {
          failures.push(
            `${theme.metadata.id} · ${pair.id}: ${ratio.toFixed(3)} (${fg} на ${bg}) — ${pair.label}`,
          )
        }
      }
    }

    expect(failures).toEqual([])
  })

  it('минимум по каждой паре не ниже зафиксированного (регрессия палитр)', () => {
    const regressions: string[] = []

    for (const pair of TEXT_PAIRS) {
      let min = Number.POSITIVE_INFINITY
      let minTheme = ''

      for (const theme of themes) {
        const [fg, bg] = pair.resolve(theme)
        const ratio = contrastRatio(fg, bg)
        if (ratio < min) {
          min = ratio
          minTheme = theme.metadata.id
        }
      }

      if (min < pair.minRatio - MIN_RATIO_EPSILON) {
        regressions.push(
          `${pair.id}: минимум ${min.toFixed(4)} (${minTheme}) < ${pair.minRatio.toFixed(4)} — ${pair.label}`,
        )
      }
    }

    expect(regressions).toEqual([])
  })

  it('raised подставляет elevated, если поля не заданы (фоллбек пары)', () => {
    const pair = TEXT_PAIRS.find((p) => p.id === 'raised')!
    const theme = structuredClone(themes[0])
    delete theme.colors.surface.raised
    delete theme.colors.surface.raisedForeground

    expect(pair.resolve(theme)).toEqual([
      theme.colors.surface.elevatedForeground,
      theme.colors.surface.elevated,
    ])
  })

  it('primary подставляет #ffffff, если foreground не задан (фоллбек cssGenerator)', () => {
    const pair = TEXT_PAIRS.find((p) => p.id === 'primary')!
    const theme = structuredClone(themes[0])
    delete theme.colors.primary.foreground

    expect(pair.resolve(theme)).toEqual(['#ffffff', theme.colors.primary.base])
  })
})

describe('contrast — синтаксис (крупный текст)', () => {
  it(`syntax.base ≥ ${AA_LARGE_TEXT}:1 во всех темах`, () => {
    const failures = themes
      .map((theme) => [theme.metadata.id, syntaxRatio(theme)] as const)
      .filter(([, ratio]) => ratio < AA_LARGE_TEXT)
      .map(([id, ratio]) => `${id}: ${ratio.toFixed(3)}`)

    expect(failures).toEqual([])
  })

  it('ниже AA (4.5) — только 8 апстрим-тем из allowlist, значения совпадают', () => {
    const belowAA = themes
      .map((theme) => ({ id: theme.metadata.id, ratio: syntaxRatio(theme) }))
      .filter(({ ratio }) => ratio < AA_NORMAL_TEXT)

    expect(belowAA.map(({ id }) => id).sort()).toEqual(Object.keys(SYNTAX_BELOW_AA).sort())

    const mismatches = belowAA
      .filter(
        ({ id, ratio }) =>
          Math.abs(ratio - SYNTAX_BELOW_AA[id].ratio) > RECORDED_SYNTAX_RATIO_TOLERANCE,
      )
      .map(
        ({ id, ratio }) =>
          `${id}: расчёт ${ratio.toFixed(4)} ≠ зафиксировано ${SYNTAX_BELOW_AA[id].ratio}`,
      )

    expect(mismatches).toEqual([])
  })

  it('allowlist актуален: в нём нет тем с AA-контрастом', () => {
    const stale = Object.entries(SYNTAX_BELOW_AA)
      .filter(([id]) => {
        const theme = themes.find((t) => t.metadata.id === id)
        return !theme || syntaxRatio(theme) >= AA_NORMAL_TEXT
      })
      .map(([id]) => id)

    expect(stale).toEqual([])
  })
})

describe('contrast — поле palette.colors[].contrast', () => {
  it('заявленный контраст совпадает с расчётом (hex × foreground)', () => {
    const mismatches: string[] = []
    let checked = 0

    for (const theme of themes) {
      for (const color of theme.palette?.colors ?? []) {
        checked += 1
        const computed = contrastRatio(color.foreground, color.hex)
        if (Math.abs(computed - color.contrast) > PALETTE_CONTRAST_TOLERANCE) {
          mismatches.push(
            `${theme.metadata.id} ${color.key}: расчёт ${computed.toFixed(3)} ≠ заявлено ${color.contrast} (${color.hex} / ${color.foreground})`,
          )
        }
      }
    }

    expect(mismatches).toEqual([])
    // 62 темы × 16 цветов палитры.
    expect(checked).toBeGreaterThanOrEqual(992)
  })
})
