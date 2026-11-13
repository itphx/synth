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

beforeEach(() => {
  mocks.getExecutionProfiles.mockResolvedValue(PROFILES_HTTP)
  mocks.getExecutionPools.mockResolvedValue(POOLS_HTTP)
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

    expect(byTestId(container, 'execution-profiles')!.textContent).toContain('devops')

    const pools = byTestId(container, 'execution-pools')!
    expect(pools.textContent).toContain('project:p1:exec:devops')
    expect(pools.textContent).toContain('devops')
    expect(pools.textContent).toContain('ready')
    expect(pools.textContent).toContain('instance:exec:default')
    // Метки времени — в локали UI (en-US → mm/dd/yyyy).
    expect(pools.textContent).toContain('11/12/2026')
  })

  it('карточка профиля: описание, образ, сеть, ресурсы, runtime, MCP и метка default', async () => {
    const container = await render()

    const card = byTestId(container, 'execution-profile-0')!
    expect(card.textContent).toContain('default')
    expect(card.textContent).toContain('Базовый исполнитель')
    expect(card.textContent).toContain('registry.example/synth-executor:latest')
    // Сеть — локализованная подпись, не сырое значение.
    expect(card.textContent).toContain(enDict['settings.execution.network.restricted'])
    expect(card.textContent).toContain('cpu 2 · mem 4Gi')
    expect(card.textContent).toContain('gvisor')
    expect(card.textContent).toContain('playwright')
    expect(byTestId(container, 'execution-profile-0-default')!.textContent).toBe(
      enDict['settings.execution.profile.defaultBadge'],
    )
  })

  it('профиль без метаданных: имя из каталога и «—» во всех полях', async () => {
    const container = await render()

    const card = byTestId(container, 'execution-profile-1')!
    expect(card.textContent).toContain('devops')
    expect(card.textContent).not.toContain('Базовый исполнитель')
    expect(byTestId(container, 'execution-profile-1-default')).toBeNull()
    // Шесть полей (описание, образ, сеть, ресурсы, runtime, MCP) — все пустые.
    expect((card.textContent!.match(/—/g) ?? []).length).toBe(6)
  })

  it('старый сервер без details: профили показываются именами', async () => {
    mocks.getExecutionProfiles.mockResolvedValue({
      provider: 'http',
      pooling: 'project',
      defaultProfile: 'default',
      profiles: ['default', 'devops'],
    })

    const container = await render()

    expect(byTestId(container, 'execution-profile-0')!.textContent).toContain('default')
    expect(byTestId(container, 'execution-profile-1')!.textContent).toContain('devops')
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
