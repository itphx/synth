import { describe, it, expect, beforeEach } from 'vitest'
import { useProvidersStore } from './providersStore'
import type { ModelGroup, ProviderInfo } from '@/lib/api/synthApi'

function provider(name: string, extra: Partial<ProviderInfo> = {}): ProviderInfo {
  return { name, type: 'openai', icon: '', url: '', model: '', enabled: true, ...extra }
}

function group(providerName: string, models: Array<{ name: string; enabled?: boolean; isDefault?: boolean }>): ModelGroup {
  return {
    provider: { name: providerName, type: 'openai', icon: '', defaultModel: '' },
    models: models.map((m) => ({
      id: `${providerName}/${m.name}`,
      name: m.name,
      provider: providerName,
      enabled: m.enabled !== false,
      isDefault: !!m.isDefault,
    })),
  }
}

beforeEach(() => {
  useProvidersStore.setState({
    providers: [],
    modelGroups: [],
    models: [],
    loading: false,
    error: null,
    selectedProviderName: null,
    selectedModelName: null,
    favorites: [],
    recents: [],
  })
})

describe('providersStore.applyProviders', () => {
  it('не трогает валидный текущий выбор провайдера', () => {
    useProvidersStore.setState({ selectedProviderName: 'b' })
    useProvidersStore.getState().applyProviders(
      [provider('a'), provider('b'), provider('c')],
      'a',
    )
    expect(useProvidersStore.getState().selectedProviderName).toBe('b')
  })

  it('сбрасывает исчезнувший выбор на провайдера из пары по умолчанию', () => {
    useProvidersStore.setState({ selectedProviderName: 'gone' })
    useProvidersStore.getState().applyProviders([provider('a'), provider('b')], 'b')
    expect(useProvidersStore.getState().selectedProviderName).toBe('b')
  })

  it('без пары выбирает провайдера с непустым model, иначе первый enabled', () => {
    useProvidersStore.getState().applyProviders(
      [provider('a', { enabled: false }), provider('b', { model: 'm' }), provider('c')],
      '',
    )
    expect(useProvidersStore.getState().selectedProviderName).toBe('b')

    useProvidersStore.setState({ selectedProviderName: null })
    useProvidersStore.getState().applyProviders(
      [provider('a', { enabled: false }), provider('b'), provider('c')],
      '',
    )
    expect(useProvidersStore.getState().selectedProviderName).toBe('b')
  })

  it('пустой список очищает выбор', () => {
    useProvidersStore.setState({ selectedProviderName: 'a' })
    useProvidersStore.getState().applyProviders([], '')
    expect(useProvidersStore.getState().selectedProviderName).toBeNull()
  })
})

describe('providersStore.applyModelGroups', () => {
  it('выбирает модель из пары (isDefault), если выбора ещё нет', () => {
    useProvidersStore.setState({ selectedProviderName: 'a' })
    useProvidersStore.getState().applyModelGroups([
      group('a', [{ name: 'a1' }, { name: 'a2' }]),
      group('b', [{ name: 'b1', isDefault: true }, { name: 'b2' }]),
    ])
    expect(useProvidersStore.getState().selectedModelName).toBe('b1')
    expect(useProvidersStore.getState().models.map((m) => m.name)).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  it('при выборе пары выставляет и провайдера, и модель', () => {
    useProvidersStore.setState({ selectedProviderName: 'a', selectedModelName: null })
    useProvidersStore.getState().applyModelGroups([
      group('a', [{ name: 'a1' }]),
      group('b', [{ name: 'b1', isDefault: true }]),
    ])
    // Модель `b1` принадлежит провайдеру `b` — провайдер тоже переключается, иначе
    // отправка ушла бы с парой `a` + `b1`.
    expect(useProvidersStore.getState().selectedProviderName).toBe('b')
    expect(useProvidersStore.getState().selectedModelName).toBe('b1')
  })

  it('модель с тем же именем у другого провайдера не считается валидной', () => {
    useProvidersStore.setState({ selectedProviderName: 'b', selectedModelName: 'a2' })
    useProvidersStore.getState().applyModelGroups([
      group('a', [{ name: 'a1' }, { name: 'a2' }]),
      group('b', [{ name: 'b1' }, { name: 'b2' }]),
    ])
    expect(useProvidersStore.getState().selectedProviderName).toBe('b')
    expect(useProvidersStore.getState().selectedModelName).toBe('b1')
  })

  it('не перезаписывает существующий валидный выбор', () => {
    useProvidersStore.setState({ selectedProviderName: 'a', selectedModelName: 'a2' })
    useProvidersStore.getState().applyModelGroups([
      group('a', [{ name: 'a1' }, { name: 'a2' }]),
      group('b', [{ name: 'b1', isDefault: true }]),
    ])
    expect(useProvidersStore.getState().selectedModelName).toBe('a2')
  })

  it('сбрасывает исчезнувшую/выключенную модель на дефолтную', () => {
    useProvidersStore.setState({ selectedProviderName: 'a', selectedModelName: 'a2' })
    useProvidersStore.getState().applyModelGroups([
      group('a', [{ name: 'a1' }, { name: 'a2', enabled: false }]),
      group('b', [{ name: 'b1', isDefault: true }]),
    ])
    expect(useProvidersStore.getState().selectedModelName).toBe('b1')
  })

  it('без пары берёт первую enabled модель выбранного провайдера', () => {
    useProvidersStore.setState({ selectedProviderName: 'b', selectedModelName: null })
    useProvidersStore.getState().applyModelGroups([
      group('a', [{ name: 'a1' }]),
      group('b', [{ name: 'b1', enabled: false }, { name: 'b2' }]),
    ])
    expect(useProvidersStore.getState().selectedModelName).toBe('b2')
  })
})
