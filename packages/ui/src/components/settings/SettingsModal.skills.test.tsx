import { describe, it, expect } from 'vitest'
import { CATEGORIES } from './SettingsModal'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'

function visibleFor(roles: string[]) {
  return CATEGORIES.filter((cat) => !cat.roles || cat.roles.some((r) => roles.includes(r)))
}

describe('SettingsModal — категории скиллов и команд (AD-046 §9.3)', () => {
  it('`skills` — пользовательская категория без roles', () => {
    const skills = CATEGORIES.find((cat) => cat.id === 'skills')!
    expect(skills).toBeDefined()
    expect(skills.roles).toBeUndefined()
    expect(skills.labelKey).toBe('settings.category.skills')
  })

  it('`skillsAdmin` и `commands` — только ADMIN (за границей админ-блока)', () => {
    const skillsAdmin = CATEGORIES.find((cat) => cat.id === 'skillsAdmin')!
    expect(skillsAdmin.roles).toEqual(['ADMIN'])
    expect(skillsAdmin.labelKey).toBe('settings.category.skillsAdmin')

    const commands = CATEGORIES.find((cat) => cat.id === 'commands')!
    expect(commands.roles).toEqual(['ADMIN'])
    expect(commands.labelKey).toBe('settings.category.commands')

    const adminIds = visibleFor(['ADMIN']).map((cat) => cat.id)
    expect(adminIds).toContain('skillsAdmin')
    expect(adminIds).toContain('commands')

    const userIds = visibleFor(['USER']).map((cat) => cat.id)
    expect(userIds).toContain('skills')
    expect(userIds).not.toContain('skillsAdmin')
    expect(userIds).not.toContain('commands')
  })

  it('пользовательская `skills` идёт до админ-границы', () => {
    const order = CATEGORIES.map((cat) => cat.id)
    const firstAdmin = CATEGORIES.findIndex((cat) => cat.roles !== undefined)
    expect(order.indexOf('skills')).toBeLessThan(firstAdmin)
  })

  it('ключи категорий переведены (ru/en)', () => {
    expect(enDict['settings.category.skills']).toBe('Skills')
    expect(ruDict['settings.category.skills']).toBe('Скиллы')
    expect(enDict['settings.category.skillsAdmin']).toBe('Skills')
    expect(ruDict['settings.category.skillsAdmin']).toBe('Скиллы')
    expect(enDict['settings.category.commands']).toBe('Commands')
    expect(ruDict['settings.category.commands']).toBe('Команды')
  })
})
