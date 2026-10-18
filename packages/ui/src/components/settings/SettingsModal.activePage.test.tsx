import { describe, it, expect } from 'vitest'
import { CATEGORIES, resolveActiveSettingsPage } from './SettingsModal'

function visibleFor(roles: string[]) {
  return CATEGORIES.filter((cat) => !cat.roles || cat.roles.some((r) => roles.includes(r)))
}

/**
 * Регрессия: при смене пользователя в одной SPA-сессии `settingsPage` может
 * остаться на скрытом для новой роли ADMIN-разделе. Содержимое такого раздела
 * рендериться не должно — показывается первая доступная категория.
 */
describe('SettingsModal — активная категория недоступна роли', () => {
  it('скрытый ADMIN-раздел не остаётся активным: показывается первая доступная', () => {
    const visible = visibleFor(['USER'])
    expect(visible.some((cat) => cat.id === 'eventsConfig')).toBe(false)

    expect(resolveActiveSettingsPage(visible, 'eventsConfig')).toBe(visible[0].id)
  })

  it('доступная пользовательская категория сохраняется', () => {
    const visible = visibleFor(['USER'])
    expect(visible.some((cat) => cat.id === 'eventsAdmin')).toBe(true)

    expect(resolveActiveSettingsPage(visible, 'eventsAdmin')).toBe('eventsAdmin')
  })

  it('ADMIN сохраняет доступный ему admin-раздел', () => {
    const visible = visibleFor(['ADMIN'])
    expect(resolveActiveSettingsPage(visible, 'eventsConfig')).toBe('eventsConfig')
  })

  it('категория «Метрики» видна ADMIN и скрыта USER', () => {
    expect(visibleFor(['ADMIN']).some((cat) => cat.id === 'metrics')).toBe(true)
    expect(visibleFor(['USER']).some((cat) => cat.id === 'metrics')).toBe(false)
    expect(visibleFor(['LEAD']).some((cat) => cat.id === 'metrics')).toBe(false)
  })

  it('«Метрики» идут сразу после «Обслуживания» в админ-блоке', () => {
    const ids = CATEGORIES.map((cat) => cat.id)
    expect(ids.indexOf('metrics')).toBe(ids.indexOf('maintenance') + 1)
  })
})
