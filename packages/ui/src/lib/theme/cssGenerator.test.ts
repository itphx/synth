import { describe, expect, it } from 'vitest'

import { CSSVariableGenerator } from './cssGenerator'
import { getDefaultTheme } from './themes'
import type { Theme } from '@/types/theme'

const baseTheme = getDefaultTheme(false)

const clone = (): Theme => structuredClone(baseTheme)

describe('CSSVariableGenerator — surface.raised', () => {
  it('подставляет elevated, если raised не задан (фоллбек)', () => {
    const theme = clone()
    delete theme.colors.surface.raised
    delete theme.colors.surface.raisedForeground

    const css = new CSSVariableGenerator().generate(theme)

    expect(css).toContain(`--surface-raised: ${theme.colors.surface.elevated};`)
    expect(css).toContain(
      `--surface-raised-foreground: ${theme.colors.surface.elevatedForeground};`,
    )
    expect(css).toContain(`--popover: ${theme.colors.surface.elevated} !important;`)
    expect(css).toContain(
      `--popover-foreground: ${theme.colors.surface.elevatedForeground} !important;`,
    )
  })

  it('эмитит raised и переводит popover на него, если поле задано', () => {
    const theme = clone()
    theme.colors.surface.raised = '#112233'
    theme.colors.surface.raisedForeground = '#aabbcc'

    const css = new CSSVariableGenerator().generate(theme)

    expect(css).toContain('--surface-raised: #112233;')
    expect(css).toContain('--surface-raised-foreground: #aabbcc;')
    expect(css).toContain('--popover: #112233 !important;')
    expect(css).toContain('--popover-foreground: #aabbcc !important;')
  })
})
