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
  getPacks: vi.fn(),
  getPack: vi.fn(),
  approvePack: vi.fn(),
  uninstallPack: vi.fn(),
  getPipelines: vi.fn(),
  getPipelineInstances: vi.fn(),
  getPipelineTemplates: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AddonsSettings } from './AddonsSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PACK_ACTIVE = {
  name: 'synth-media',
  version: '1.0.0',
  kind: 'addon',
  description: 'Публикация постов',
  status: 'active' as const,
  requiresApproval: false,
  provides: {
    agents: ['publisher'],
    skills: ['media-hub'],
    mcp: ['synth-media-receiver'],
    pipelines: ['publication'],
  },
  installedAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T10:00:00.000Z',
}

const PACK_PENDING = {
  ...PACK_ACTIVE,
  name: 'synth-media-next',
  version: '2.0.0',
  status: 'pending_approval' as const,
  requiresApproval: true,
}

const PIPELINE = {
  id: 'publication',
  name: 'Publication',
  version: '1.0.0',
  steps: [{ id: 'draft' }, { id: 'publish' }],
  installedBy: { pack: 'synth-media', version: '1.0.0' },
  createdAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T10:00:00.000Z',
}

const INSTANCE = {
  id: 'plrun_1',
  pipelineId: 'publication',
  status: 'running' as const,
  steps: [{ id: 'draft', status: 'running' as const }],
  currentStep: 'draft',
  attempts: 0,
  createdAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T10:00:00.000Z',
}

/** Системный шаблон движка ADR-101 (`GET /pipeline-templates`). */
const TEMPLATE = {
  id: 'builtin:memory-reindex',
  name: 'Memory: reindex project',
  format: 'adr-101' as const,
  version: 1,
  installedBy: { pack: 'builtin', version: '1' },
}

/** Legacy-определение пакета ADR-100 — в блоке шаблонов не показывается. */
const LEGACY_TEMPLATE = {
  id: 'publication',
  name: 'Legacy publication',
  format: 'adr-100' as const,
  steps: [{ id: 'draft' }],
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

async function flush(): Promise<void> {
  await act(async () => {})
}

async function clickTestId(container: HTMLElement, testId: string): Promise<void> {
  const el = byTestId(container, testId)
  expect(el, `элемент ${testId}`).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
  await flush()
}

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({ settingsShowAdvanced: true, settingsFocus: null })
  useAuthStore.setState({
    user: {
      id: 'admin',
      username: 'admin',
      email: null,
      roles: ['ADMIN'],
    },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <AddonsSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await flush()
  await flush()
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getPacks.mockResolvedValue([])
  mocks.getPipelines.mockResolvedValue([])
  mocks.getPipelineInstances.mockResolvedValue([])
  mocks.getPipelineTemplates.mockResolvedValue([])
  mocks.approvePack.mockResolvedValue({
    installed: true,
    requiresApproval: false,
    name: 'synth-media-next',
    version: '2.0.0',
    provides: PACK_PENDING.provides,
  })
  mocks.uninstallPack.mockResolvedValue(undefined)
  mocks.confirm.mockResolvedValue(true)
})

afterEach(async () => {
  while (roots.length > 0) {
    const entry = roots.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.container.remove()
  }
})

describe('AddonsSettings — пакеты расширений', () => {
  it('показывает список установленных пакетов с версией, классом и составом', async () => {
    mocks.getPacks.mockResolvedValue([PACK_ACTIVE])
    const container = await renderSettings()

    expect(mocks.getPacks).toHaveBeenCalled()
    expect(byTestId(container, 'addons-packs-empty')).toBeNull()

    const item = byTestId(container, 'addons-pack-synth-media')
    expect(item).toBeTruthy()
    const text = item?.textContent ?? ''
    expect(text).toContain('synth-media')
    expect(text).toContain('1.0.0')
    expect(text).toContain('addon')
    expect(text).toContain('publisher')
    expect(text).toContain('media-hub')
    expect(text).toContain('synth-media-receiver')
    expect(text).toContain('publication')

    // Активный пакет можно снять, ожидающий одобрения — нет.
    expect(byTestId(container, 'addons-pack-remove-synth-media')).toBeTruthy()
    expect(byTestId(container, 'addons-pack-approve-synth-media')).toBeNull()
  })

  it('пустой реестр — пустое состояние', async () => {
    const container = await renderSettings()

    expect(byTestId(container, 'addons-packs-list')).toBeNull()
    expect(byTestId(container, 'addons-packs-empty')).toBeTruthy()
  })

  it('пакет, ждущий подтверждения, выделен и получает кнопку одобрения', async () => {
    mocks.getPacks.mockResolvedValue([PACK_PENDING])
    const container = await renderSettings()

    expect(byTestId(container, 'addons-pack-pending-synth-media-next')?.textContent).toBe(
      'approval required',
    )
    expect(byTestId(container, 'addons-pack-status-synth-media-next')?.textContent).toBe(
      'awaiting approval',
    )
    expect(byTestId(container, 'addons-pack-approve-synth-media-next')).toBeTruthy()
    expect(byTestId(container, 'addons-pack-remove-synth-media-next')).toBeNull()
    expect(byTestId(container, 'addons-pending-hint')).toBeTruthy()
  })

  it('одобрение установки вызывает approvePack и обновляет список', async () => {
    mocks.getPacks.mockResolvedValue([PACK_PENDING])
    const container = await renderSettings()

    await clickTestId(container, 'addons-pack-approve-synth-media-next')

    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.approvePack).toHaveBeenCalledWith('synth-media-next')
    // Список перечитывается после успешного действия.
    expect(mocks.getPacks.mock.calls.length).toBeGreaterThan(1)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    )
  })

  it('снятие установки вызывает uninstallPack', async () => {
    mocks.getPacks.mockResolvedValue([PACK_ACTIVE])
    const container = await renderSettings()

    await clickTestId(container, 'addons-pack-remove-synth-media')

    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.uninstallPack).toHaveBeenCalledWith('synth-media')
  })

  it('отказ в подтверждении не вызывает мутацию', async () => {
    mocks.confirm.mockResolvedValue(false)
    mocks.getPacks.mockResolvedValue([PACK_PENDING])
    const container = await renderSettings()

    await clickTestId(container, 'addons-pack-approve-synth-media-next')

    expect(mocks.approvePack).not.toHaveBeenCalled()
  })

  it('403 читается как понятная ошибка прав', async () => {
    mocks.getPacks.mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403 }),
    )
    const container = await renderSettings()

    expect(byTestId(container, 'addons-packs-error')?.textContent).toBe(
      'Administrator rights are required to view this section.',
    )
  })
})

describe('AddonsSettings — пайплайны', () => {
  it('показывает определения пайплайнов и провенанс (имя пакета)', async () => {
    mocks.getPipelines.mockResolvedValue([PIPELINE])
    const container = await renderSettings()

    const item = byTestId(container, 'addons-pipeline-publication')
    expect(item).toBeTruthy()
    const text = item?.textContent ?? ''
    expect(text).toContain('Publication')
    expect(text).toContain('publication')
    // Провенанс — только имя пакета.
    expect(text).toContain('synth-media')
  })

  it('на вкладке прогонов показывает статусы и текущий шаг', async () => {
    mocks.getPipelineInstances.mockResolvedValue([INSTANCE])
    const container = await renderSettings()

    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLElement[]
    const runsTab = tabs.find((tab) => tab.textContent === 'Runs')
    expect(runsTab).toBeTruthy()
    await act(async () => {
      runsTab!.click()
    })
    await flush()
    await flush()

    const item = byTestId(container, 'addons-instance-plrun_1')
    expect(item).toBeTruthy()
    expect(byTestId(container, 'addons-instance-status-plrun_1')?.textContent).toBe('running')
    expect(item?.textContent).toContain('draft')
  })

  it('фильтр статуса уходит в запрос экземпляров', async () => {
    mocks.getPipelineInstances.mockResolvedValue([INSTANCE])
    const container = await renderSettings()

    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLElement[]
    const runsTab = tabs.find((tab) => tab.textContent === 'Runs')
    await act(async () => {
      runsTab!.click()
    })
    await flush()

    const statusTrigger = byTestId(container, 'addons-instance-status-filter')
    expect(statusTrigger).toBeTruthy()

    // Опции рендерятся в portal — ищем по всему документу.
    await act(async () => {
      ;(statusTrigger as HTMLElement).click()
    })
    const options = [...document.body.querySelectorAll('[role="option"]')] as HTMLElement[]
    const failed = options.find((option) => option.textContent?.trim() === 'failed')
    expect(failed, 'опция "failed"').toBeTruthy()
    await act(async () => {
      failed!.click()
    })
    await flush()
    await flush()

    expect(mocks.getPipelineInstances).toHaveBeenCalledWith({ status: 'failed' })
  })
})

describe('AddonsSettings — системные шаблоны (ADR-101)', () => {
  async function openTemplatesTab(container: HTMLElement): Promise<void> {
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLElement[]
    const templatesTab = tabs.find((tab) => tab.textContent === 'Templates')
    expect(templatesTab, 'вкладка "Templates"').toBeTruthy()
    await act(async () => {
      templatesTab!.click()
    })
    await flush()
    await flush()
  }

  it('read-only список: id, имя, версия и пакет; legacy не показывается', async () => {
    mocks.getPipelineTemplates.mockResolvedValue([TEMPLATE, LEGACY_TEMPLATE])
    const container = await renderSettings()

    await openTemplatesTab(container)

    const item = byTestId(container, 'addons-template-builtin:memory-reindex')
    expect(item).toBeTruthy()
    const text = item?.textContent ?? ''
    expect(text).toContain('Memory: reindex project')
    expect(text).toContain('builtin:memory-reindex')
    expect(text).toContain('1')
    expect(text).toContain('builtin')
    expect(text).toContain('system')

    // Legacy-определение ADR-100 в этом блоке не смешивается с шаблонами движка.
    expect(byTestId(container, 'addons-template-publication')).toBeNull()
  })

  it('пустой список шаблонов — пустое состояние', async () => {
    mocks.getPipelineTemplates.mockResolvedValue([])
    const container = await renderSettings()

    await openTemplatesTab(container)

    expect(byTestId(container, 'addons-pipelines-templates-empty')).toBeTruthy()
  })

  it('ошибка загрузки шаблонов показывается в alert', async () => {
    mocks.getPipelineTemplates.mockRejectedValue(new Error('templates boom'))
    const container = await renderSettings()

    await openTemplatesTab(container)

    const error = byTestId(container, 'addons-pipelines-templates-error')
    expect(error).toBeTruthy()
    expect(error?.getAttribute('role')).toBe('alert')
    expect(error?.textContent).toContain('templates boom')
  })
})
