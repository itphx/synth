import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore/useAuthStore пишет в localStorage — в Node/vitest его нет.
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

const mocks = vi.hoisted(() => ({
  getExecutionProfiles: vi.fn(),
  getExecutionPools: vi.fn(),
  drainExecutionPool: vi.fn(),
  releaseExecutionPool: vi.fn(),
  getExecutionSettings: vi.fn(),
  saveExecutionSettings: vi.fn(),
  resetExecutionSettings: vi.fn(),
  restartInstance: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { useAuthStore } from '@/stores/authStore'
import { ExecutionSettings } from './ExecutionSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PROFILES_HTTP = {
  provider: 'http' as const,
  pooling: 'project' as const,
  defaultProfile: 'default',
  profiles: ['default', 'devops'],
  details: [
    {
      name: 'default',
      description: 'Базовый исполнитель',
      image: 'registry.example/synth-executor:latest',
      network: 'restricted' as const,
      resources: { limits: { cpu: '2', memory: '4Gi' } },
      runtimeClass: 'gvisor',
      mcpServers: ['playwright'],
    },
    { name: 'devops' },
  ],
}

/** Runtime-каталог (ADR-135): `GET /settings/execution`. */
const SETTINGS_DTO = {
  saved: null,
  running: {
    defaultProfile: 'default',
    browserProfile: 'browser',
    browserProfiles: ['browser'],
    profiles: { default: { image: 'registry.example/synth-executor:latest' } },
  },
  restartRequired: false,
  effective: {
    defaultProfile: 'default',
    browserProfile: 'browser',
    browserProfiles: ['browser'],
    profiles: {
      default: {
        description: 'Базовый исполнитель',
        image: 'registry.example/synth-executor:latest',
        network: 'restricted' as const,
        resources: { limits: { cpu: '2', memory: '4Gi' } },
        runtimeClass: 'gvisor',
        mcpServers: ['playwright'],
      },
      devops: { image: 'registry.example/synth-executor:devops' },
    },
  },
  defaults: {
    defaultProfile: 'default',
    browserProfile: 'browser',
    browserProfiles: ['browser'],
    profiles: { default: { image: 'registry.example/synth-executor:latest' } },
  },
  isOverridden: false,
}

const POOLS_HTTP = {
  provider: 'http' as const,
  pools: [
    {
      key: 'project:p1:exec:devops',
      profile: 'devops',
      state: 'ready' as const,
      createdAt: '2026-11-12T10:00:00.000Z',
      lastUsedAt: '2026-11-12T10:05:00.000Z',
    },
    { key: 'instance:exec:default', profile: 'default', state: 'configured' as const },
  ],
}

async function render(roles: string[] = ['ADMIN']): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useAuthStore.setState({ user: { id: 'u1', username: 'alice', roles } as never })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ExecutionSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

const byTestId = (container: HTMLElement, id: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

/** Ввод значения в поле (React-controllled: событие `input`). */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  mocks.getExecutionProfiles.mockResolvedValue(PROFILES_HTTP)
  mocks.getExecutionPools.mockResolvedValue(POOLS_HTTP)
  mocks.getExecutionSettings.mockResolvedValue(SETTINGS_DTO)
  mocks.saveExecutionSettings.mockResolvedValue(SETTINGS_DTO)
  mocks.resetExecutionSettings.mockResolvedValue(SETTINGS_DTO)
  mocks.restartInstance.mockResolvedValue({ status: 'restarting', restartId: 'rst_1' })
  mocks.drainExecutionPool.mockResolvedValue(undefined)
  mocks.releaseExecutionPool.mockResolvedValue(undefined)
  mocks.confirm.mockResolvedValue(true)
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
})

describe('ExecutionSettings — сводка и списки', () => {
  it('показывает провайдера, пулинг, профиль по умолчанию, профили и пулы', async () => {
    const container = await render()

    const summary = byTestId(container, 'execution-summary')!
    expect(summary.textContent).toContain('http (provisioner)')
    expect(summary.textContent).toContain('per project')
    expect(summary.textContent).toContain('default')

    expect(byTestId(container, 'execution-catalog')!.textContent).toContain('devops')

    const pools = byTestId(container, 'execution-pools')!
    expect(pools.textContent).toContain('project:p1:exec:devops')
    expect(pools.textContent).toContain('devops')
    expect(pools.textContent).toContain('ready')
    expect(pools.textContent).toContain('instance:exec:default')
    // Метки времени — в локали UI (en-US → mm/dd/yyyy).
    expect(pools.textContent).toContain('11/12/2026')
  })

  it('карточка профиля каталога: описание, образ, сеть, ресурсы, runtime, MCP и метка default', async () => {
    const container = await render()

    const card = byTestId(container, 'execution-catalog-profile-0')!
    expect(card.textContent).toContain('default')
    expect(card.textContent).toContain('Базовый исполнитель')
    expect(card.textContent).toContain('registry.example/synth-executor:latest')
    // Сеть — локализованная подпись, не сырое значение.
    expect(card.textContent).toContain(enDict['settings.execution.network.restricted'])
    expect(card.textContent).toContain('cpu 2 · mem 4Gi')
    expect(card.textContent).toContain('gvisor')
    expect(card.textContent).toContain('playwright')
    expect(byTestId(container, 'execution-catalog-profile-0-default-badge')!.textContent).toBe(
      enDict['settings.execution.profile.defaultBadge'],
    )
  })

  it('профиль без метаданных: имя из каталога и «—» в пустых полях', async () => {
    const container = await render()

    const card = byTestId(container, 'execution-catalog-profile-1')!
    expect(card.textContent).toContain('devops')
    expect(card.textContent).not.toContain('Базовый исполнитель')
    expect(byTestId(container, 'execution-catalog-profile-1-default-badge')).toBeNull()
  })

  it('каталог без runtime-секции: показываются рабочие профили (только показ)', async () => {
    mocks.getExecutionSettings.mockResolvedValue({
      ...SETTINGS_DTO,
      effective: { defaultProfile: 'default', profiles: {} },
    })

    const container = await render()

    expect(byTestId(container, 'execution-catalog-profile-0')!.textContent).toContain('default')
    // Правки нет — каталог не задан.
    expect(byTestId(container, 'execution-catalog-profile-0-edit')).toBeNull()
  })

  it('пустой список пулов — честное пустое состояние', async () => {
    mocks.getExecutionPools.mockResolvedValue({ provider: 'http', pools: [] })

    const container = await render()

    expect(byTestId(container, 'execution-pools-empty')).not.toBeNull()
  })
})

describe('ExecutionSettings — действия с пулами', () => {
  it('«Остановить» — confirm, drain с ключом, успех и перечитывание пулов', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-pool-0-drain')!.click()
    })

    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.drainExecutionPool).toHaveBeenCalledWith('project:p1:exec:devops')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['settings.execution.drained'], type: 'success' }),
    )
    expect(mocks.getExecutionPools).toHaveBeenCalledTimes(2)
  })

  it('«Удалить» — release с ключом', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-pool-1-release')!.click()
    })

    expect(mocks.releaseExecutionPool).toHaveBeenCalledWith('instance:exec:default')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['settings.execution.released'], type: 'success' }),
    )
  })

  it('отказ в confirm — запрос не уходит', async () => {
    mocks.confirm.mockResolvedValue(false)
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-pool-0-drain')!.click()
    })

    expect(mocks.drainExecutionPool).not.toHaveBeenCalled()
    expect(mocks.releaseExecutionPool).not.toHaveBeenCalled()
  })
})

describe('ExecutionSettings — каталог профилей (runtime)', () => {
  it('создание профиля: форма → каталог → PUT с новым профилем', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-create')!.click()
    })
    expect(byTestId(container, 'execution-catalog-editor')).not.toBeNull()

    const name = byTestId(container, 'execution-catalog-name') as HTMLInputElement
    const image = byTestId(container, 'execution-catalog-image') as HTMLInputElement
    await act(async () => {
      setInputValue(name, 'light')
      setInputValue(image, 'registry.example/synth-executor:light')
    })
    await act(async () => {
      byTestId(container, 'execution-catalog-apply')!.click()
    })

    expect(byTestId(container, 'execution-catalog-profile-2')!.textContent).toContain('light')

    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })

    expect(mocks.saveExecutionSettings).toHaveBeenCalled()
    const sent = mocks.saveExecutionSettings.mock.calls[0]![0] as {
      profiles: Record<string, { image?: string }>
    }
    expect(sent.profiles.light).toEqual({ image: 'registry.example/synth-executor:light' })
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['settings.execution.catalog.saved'], type: 'success' }),
    )
  })

  it('правка профиля: форма предзаполнена, изменения уходят в PUT', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-profile-0-edit')!.click()
    })
    const description = byTestId(container, 'execution-catalog-description') as HTMLInputElement
    expect(description.value).toBe('Базовый исполнитель')

    await act(async () => {
      setInputValue(description, 'Новый базовый')
      byTestId(container, 'execution-catalog-apply')!.click()
    })
    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })

    const sent = mocks.saveExecutionSettings.mock.calls[0]![0] as {
      profiles: Record<string, { description?: string }>
    }
    expect(sent.profiles.default?.description).toBe('Новый базовый')
  })

  it('удаление профиля — с подтверждением; дефолтный удалить нельзя', async () => {
    const container = await render()

    // Профиль по умолчанию удалить нельзя — кнопка заблокирована.
    expect(
      (byTestId(container, 'execution-catalog-profile-0-delete') as HTMLButtonElement).disabled,
    ).toBe(true)

    await act(async () => {
      byTestId(container, 'execution-catalog-profile-1-delete')!.click()
    })
    expect(mocks.confirm).toHaveBeenCalled()
    expect(byTestId(container, 'execution-catalog-profile-1')).toBeNull()

    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })
    const sent = mocks.saveExecutionSettings.mock.calls[0]![0] as {
      profiles: Record<string, unknown>
    }
    expect(sent.profiles.devops).toBeUndefined()
  })

  it('отказ в подтверждении удаления — профиль остаётся', async () => {
    mocks.confirm.mockResolvedValue(false)
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-profile-1-delete')!.click()
    })
    expect(byTestId(container, 'execution-catalog-profile-1')).not.toBeNull()
  })

  it('«По умолчанию» и «Браузерный по умолчанию» меняют дефолты в PUT', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-profile-1-set-default')!.click()
    })
    await act(async () => {
      byTestId(container, 'execution-catalog-profile-1-set-browser')!.click()
    })
    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })

    const sent = mocks.saveExecutionSettings.mock.calls[0]![0] as {
      defaultProfile?: string
      browserProfile?: string
      browserProfiles?: string[]
    }
    expect(sent.defaultProfile).toBe('devops')
    expect(sent.browserProfile).toBe('devops')
    // Явный список браузерных профилей должен содержать новый дефолт.
    expect(sent.browserProfiles).toContain('devops')
  })

  it('restartRequired: баннер «Применится после перезапуска» + кнопка перезапуска', async () => {
    mocks.getExecutionSettings.mockResolvedValue({ ...SETTINGS_DTO, restartRequired: true })
    const container = await render()

    const banner = byTestId(container, 'execution-restart-banner')!
    expect(banner.textContent).toContain(enDict['settings.execution.restartRequired'])

    await act(async () => {
      byTestId(container, 'execution-restart')!.click()
    })
    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.restartInstance).toHaveBeenCalled()
  })

  it('ошибка 400 при сохранении — понятное сообщение', async () => {
    mocks.saveExecutionSettings.mockRejectedValue(
      Object.assign(new Error('execution.defaultProfile: профиль "x" отсутствует в каталоге профилей'), {
        status: 400,
        code: 'VALIDATION_ERROR',
      }),
    )
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', category: 'error' }),
    )
  })

  it('сброс каталога — DELETE с подтверждением', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-reset')!.click()
    })
    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.resetExecutionSettings).toHaveBeenCalled()
  })

  it('LEAD: каталог не правится (только ADMIN)', async () => {
    const container = await render(['LEAD'])

    expect(byTestId(container, 'execution-catalog-readonly')).not.toBeNull()
    expect(byTestId(container, 'execution-catalog-create')).toBeNull()
    expect(mocks.getExecutionSettings).not.toHaveBeenCalled()
  })
})

describe('ExecutionSettings — провайдер и права', () => {
  it('static: действия недоступны с пояснением', async () => {
    mocks.getExecutionProfiles.mockResolvedValue({
      provider: 'static',
      pooling: 'instance',
      defaultProfile: 'default',
      profiles: ['default'],
    })
    mocks.getExecutionPools.mockResolvedValue({
      provider: 'static',
      pools: [{ profile: 'default', state: 'configured' }],
    })

    const container = await render()

    expect(
      container.querySelector('[data-settings-section="execution-pools"]')!.textContent,
    ).toContain('nothing to manage at runtime')
    expect((byTestId(container, 'execution-pool-0-drain') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId(container, 'execution-pool-0-release') as HTMLButtonElement).disabled).toBe(true)
  })

  it('inline: профили не применимы — пояснение вместо карточек и пулов', async () => {
    mocks.getExecutionProfiles.mockResolvedValue({
      provider: 'inline',
      pooling: 'instance',
      defaultProfile: 'default',
      profiles: [],
      details: [],
    })
    mocks.getExecutionPools.mockResolvedValue({ provider: 'inline', pools: [] })

    const container = await render()

    expect(byTestId(container, 'execution-not-applicable')!.textContent).toContain(
      enDict['settings.execution.notApplicable'],
    )
    // Карточек профилей и пулов нет — значит, и действий drain/release тоже.
    expect(byTestId(container, 'execution-profiles')).toBeNull()
    expect(byTestId(container, 'execution-pools')).toBeNull()
    expect(byTestId(container, 'execution-pool-0-drain')).toBeNull()
    expect(byTestId(container, 'execution-pool-0-release')).toBeNull()
    expect(byTestId(container, 'execution-pools-refresh')).toBeNull()
  })

  it('503 провайдера пулов — понятное сообщение вместо списка', async () => {
    mocks.getExecutionPools.mockRejectedValue(
      Object.assign(new Error('provider unavailable'), {
        status: 503,
        code: 'EXECUTION_PROVIDER_UNAVAILABLE',
      }),
    )

    const container = await render()

    expect(byTestId(container, 'execution-pools-error')!.textContent).toContain(
      enDict['settings.execution.providerUnavailable'],
    )
  })

  it('LEAD читает раздел, но мутации недоступны (только ADMIN)', async () => {
    const container = await render(['LEAD'])

    expect(mocks.getExecutionPools).toHaveBeenCalled()
    expect((byTestId(container, 'execution-pool-0-drain') as HTMLButtonElement).disabled).toBe(true)
    expect(byTestId(container, 'execution-admin-only')!.textContent).toContain('ADMIN only')
  })

  it('USER не видит раздел и не дёргает API', async () => {
    const container = await render(['USER'])

    expect(byTestId(container, 'execution-forbidden')).not.toBeNull()
    expect(byTestId(container, 'execution-summary')).toBeNull()
    expect(mocks.getExecutionPools).not.toHaveBeenCalled()
    expect(mocks.getExecutionProfiles).not.toHaveBeenCalled()
  })
})
