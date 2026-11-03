import { describe, it, expect } from 'vitest'
import {
  isSelectableModel,
  isSelectableProvider,
  selectableModels,
  selectableProvidersByName,
} from './modelOptions'

describe('modelOptions', () => {
  it('провайдер отключён только при явном enabled:false', () => {
    expect(isSelectableProvider({ enabled: true })).toBe(true)
    expect(isSelectableProvider({})).toBe(true)
    expect(isSelectableProvider({ enabled: undefined })).toBe(true)
    expect(isSelectableProvider({ enabled: false })).toBe(false)
  })

  it('модель отключённого провайдера не предлагается', () => {
    const providers = selectableProvidersByName([
      { name: 'on', enabled: true },
      { name: 'off', enabled: false },
    ])
    expect(isSelectableModel({ provider: 'on', enabled: true }, providers)).toBe(true)
    expect(isSelectableModel({ provider: 'off', enabled: true }, providers)).toBe(false)
    // Отключённая модель у включённого провайдера — тоже нет.
    expect(isSelectableModel({ provider: 'on', enabled: false }, providers)).toBe(false)
  })

  it('провайдер не найден — модель не отбрасываем (гибрид/legacy)', () => {
    const providers = selectableProvidersByName([{ name: 'on', enabled: true }])
    expect(isSelectableModel({ provider: 'remote-only', enabled: true }, providers)).toBe(true)
    expect(isSelectableModel({ enabled: true }, providers)).toBe(true)
  })

  it('selectableModels фильтрует только недоступные пары', () => {
    const providers = selectableProvidersByName([
      { name: 'on', enabled: true },
      { name: 'off', enabled: false },
    ])
    const models = [
      { provider: 'on', name: 'a', enabled: true },
      { provider: 'off', name: 'b', enabled: true },
      { provider: 'on', name: 'c', enabled: false },
      { provider: 'unknown', name: 'd', enabled: true },
    ]
    expect(selectableModels(models, providers).map((m) => m.name)).toEqual(['a', 'd'])
  })
})
