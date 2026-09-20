import { describe, it, expect } from 'vitest'
import { CATEGORIES } from './SettingsModal'

function visibleFor(roles: string[]) {
  return CATEGORIES.filter((cat) => !cat.roles || cat.roles.some((r) => roles.includes(r)))
}

describe('SettingsModal — разделение MCP-категорий (AD-071 §2.5/§2.6)', () => {
  it('`mcp` — пользовательская категория без roles, `mcpAdmin` — только ADMIN', () => {
    const mcp = CATEGORIES.find((cat) => cat.id === 'mcp')!
    expect(mcp.roles).toBeUndefined()
    const mcpAdmin = CATEGORIES.find((cat) => cat.id === 'mcpAdmin')!
    expect(mcpAdmin.roles).toEqual(['ADMIN'])
  })

  it('ADMIN видит обе категории, USER — только пользовательскую', () => {
    const adminIds = visibleFor(['ADMIN']).map((cat) => cat.id)
    expect(adminIds).toContain('mcp')
    expect(adminIds).toContain('mcpAdmin')

    const userIds = visibleFor(['USER']).map((cat) => cat.id)
    expect(userIds).toContain('mcp')
    expect(userIds).not.toContain('mcpAdmin')
  })

  it('«Встроенные инструменты» — отдельная ADMIN-категория рядом с «MCP (админ)»', () => {
    const builtin = CATEGORIES.find((cat) => cat.id === 'builtinTools')!
    expect(builtin).toBeDefined()
    expect(builtin.roles).toEqual(['ADMIN'])
    expect(builtin.labelKey).toBe('settings.category.builtinTools')

    const order = CATEGORIES.map((cat) => cat.id)
    expect(order.indexOf('builtinTools')).toBe(order.indexOf('mcpAdmin') + 1)

    const userIds = visibleFor(['USER']).map((cat) => cat.id)
    expect(userIds).not.toContain('builtinTools')
  })
})
