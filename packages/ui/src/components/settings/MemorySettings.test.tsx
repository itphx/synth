import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
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
  getMemoryStatus: vi.fn(),
  listMemoryFacts: vi.fn(),
  getMemoryFact: vi.fn(),
  listMemoryIndexes: vi.fn(),
  createMemoryIndex: vi.fn(),
  rebuildMemoryIndex: vi.fn(),
  deleteMemoryIndex: vi.fn(),
  getProjects: vi.fn(),
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
import { useProjectsStore } from '@/stores/projectsStore'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MemorySettings } from './MemorySettings'
import type { MemoryFact, MemoryIndex, MemoryStatus } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const STATUS: MemoryStatus = {
  provider: { id: 'plugin:memory:rag', mode: 'inline', active: true },
  readiness: 'ready',
  namespace: 'plugin:synth-plugin-memory',
  facts: { total: 12, active: 9 },
  indexes: { total: 4, ready: 2, stale: 1, failed: 1, building: 0 },
}

const FACT: MemoryFact = {
  id: 'fact-1',
  version: 3,
  text: 'Деплой в test идёт через Fleet, а не через kubectl.',
  kind: 'decision',
  projectId: 'project-1',
  provenance: {
    sourceKind: 'session',
    sourceId: 's-42',
    capturedAt: '2026-10-19T10:00:00.000Z',
  },
  confidence: 0.85,
  status: 'active',
  createdAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T10:05:00.000Z',
}

const INDEX: MemoryIndex = {
  id: 'index-1',
  name: 'Project corpus',
  providerId: 'plugin:memory:rag',
  projectId: 'project-1',
  source: { kind: 'project', filter: '**/*.ts' },
  state: 'failed',
  generation: 2,
  fingerprint: { model: 'text-embedding-3-small', dimension: 1536, chunkerVersion: 'v1' },
  stats: { documents: 42, chunks: 128, updatedAt: '2026-10-19T10:00:00.000Z' },
  createdAt: '2026-10-18T10:00:00.000Z',
  updatedAt: '2026-10-19T10:00:00.000Z',
  error: 'embedding provider is not configured',
}

/** Индекс в работе — для проверки блокировки «Пересобрать» и автообновления. */
const BUILDING_INDEX: MemoryIndex = {
  ...INDEX,
  id: 'index-building',
  name: 'Building corpus',
  state: 'building',
  error: undefined,
}

const PROJECT = { id: 'project-1', name: 'Project One', origin: 'local' }

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

/** Устанавливает значение контролируемого input так, чтобы React увидел `onChange`. */
async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Выбирает опцию селекта (опции рендерятся в portal — ищем по всему документу). */
async function selectOption(container: HTMLElement, triggerTestId: string, optionText: string) {
  const trigger = byTestId(container, triggerTestId)
  expect(trigger, `триггер ${triggerTestId}`).toBeTruthy()
  await act(async () => {
    ;(trigger as HTMLElement).click()
  })
  const options = [...document.body.querySelectorAll('[role="option"]')] as HTMLElement[]
  const option = options.find((item) => item.textContent?.trim() === optionText)
  expect(option, `опция «${optionText}»`).toBeTruthy()
  await act(async () => {
    option!.click()
  })
  await flush()
  await flush()
}

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({ settingsShowAdvanced: true, settingsFocus: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <MemorySettings />
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
  mocks.getMemoryStatus.mockResolvedValue(STATUS)
  mocks.listMemoryFacts.mockResolvedValue({
    items: [FACT],
    total: 120,
    limit: 50,
    offset: 0,
  })
  mocks.getMemoryFact.mockResolvedValue(FACT)
  mocks.listMemoryIndexes.mockResolvedValue({ items: [INDEX], total: 1 })
  mocks.createMemoryIndex.mockResolvedValue({ index: INDEX })
  mocks.rebuildMemoryIndex.mockResolvedValue({ index: BUILDING_INDEX })
  mocks.deleteMemoryIndex.mockResolvedValue(undefined)
  mocks.getProjects.mockResolvedValue([PROJECT])
  mocks.confirm.mockResolvedValue(true)
  useProjectsStore.setState({ projects: [PROJECT] as never })
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

describe('MemorySettings — состояние портала', () => {
  it('показывает готовность, провайдера и счётчики фактов и индексов', async () => {
    const container = await renderSettings()

    expect(mocks.getMemoryStatus).toHaveBeenCalled()

    expect(byTestId(container, 'memory-readiness-badge')?.textContent).toBe('ready')
    expect(byTestId(container, 'memory-provider-badge')?.textContent).toBe('active')

    const info = byTestId(container, 'memory-status-info')?.textContent ?? ''
    expect(info).toContain('plugin:memory:rag')
    expect(info).toContain('inline')
    expect(info).toContain('plugin:synth-plugin-memory')
    // Счётчики: факты (всего/активных) и индексы (готовых/устаревших/с ошибкой).
    expect(info).toContain('12')
    expect(info).toContain('9')
    expect(info).toContain('4')
    expect(info).toContain('2')
    expect(info).toContain('1')
  })

  it('кнопка «Обновить» перезапрашивает статус, факты и индексы', async () => {
    const container = await renderSettings()

    const statusCalls = mocks.getMemoryStatus.mock.calls.length
    const factsCalls = mocks.listMemoryFacts.mock.calls.length
    const indexCalls = mocks.listMemoryIndexes.mock.calls.length

    await clickTestId(container, 'memory-refresh')

    expect(mocks.getMemoryStatus.mock.calls.length).toBe(statusCalls + 1)
    expect(mocks.listMemoryFacts.mock.calls.length).toBe(factsCalls + 1)
    expect(mocks.listMemoryIndexes.mock.calls.length).toBe(indexCalls + 1)
  })
})

describe('MemorySettings — факты', () => {
  it('показывает факты с видом, статусом, уверенностью, провенансом и версией', async () => {
    const container = await renderSettings()

    expect(mocks.listMemoryFacts).toHaveBeenCalledWith({
      status: 'active',
      limit: 50,
      offset: 0,
    })

    const row = byTestId(container, 'memory-fact-fact-1')
    expect(row).toBeTruthy()
    const text = row?.textContent ?? ''
    expect(text).toContain('Деплой в test идёт через Fleet')
    expect(text).toContain('decision')
    expect(text).toContain('active')
    expect(text).toContain('0.85')
    expect(text).toContain('session s-42')
    expect(text).toContain('3')
  })

  it('пустой список фактов — пустое состояние, а не пустой экран', async () => {
    mocks.listMemoryFacts.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 })
    const container = await renderSettings()

    expect(byTestId(container, 'memory-facts-empty')?.textContent).toContain('No facts yet')
    expect(byTestId(container, 'memory-facts-table')).toBeNull()
  })

  it('фильтр по статусу уходит в домен с новым статусом', async () => {
    const container = await renderSettings()

    await selectOption(container, 'memory-facts-status-filter', 'superseded')

    expect(mocks.listMemoryFacts).toHaveBeenCalledWith({
      status: 'superseded',
      limit: 50,
      offset: 0,
    })
  })

  it('фильтр «все статусы» уходит в домен как status=all', async () => {
    const container = await renderSettings()

    await selectOption(container, 'memory-facts-status-filter', 'All')

    expect(mocks.listMemoryFacts).toHaveBeenCalledWith({
      status: 'all',
      limit: 50,
      offset: 0,
    })
  })

  it('детали факта загружаются по клику на текст', async () => {
    const container = await renderSettings()

    expect(byTestId(container, 'memory-fact-detail')).toBeNull()

    await clickTestId(container, 'memory-fact-text-fact-1')

    expect(mocks.getMemoryFact).toHaveBeenCalledWith('fact-1')
    expect(byTestId(container, 'memory-fact-detail')?.textContent).toContain('Fact details')
  })

  it('поиск по тексту уходит в домен и сбрасывает страницу', async () => {
    const container = await renderSettings()

    const input = byTestId(container, 'memory-facts-query') as HTMLInputElement
    await setInputValue(input, 'Fleet')
    await clickTestId(container, 'memory-facts-search')

    expect(mocks.listMemoryFacts).toHaveBeenCalledWith({
      query: 'Fleet',
      status: 'active',
      limit: 50,
      offset: 0,
    })
  })

  it('пагинация увеличивает смещение на размер страницы', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'memory-facts-next')

    expect(mocks.listMemoryFacts).toHaveBeenCalledWith({
      status: 'active',
      limit: 50,
      offset: 50,
    })

    await clickTestId(container, 'memory-facts-prev')

    expect(mocks.listMemoryFacts).toHaveBeenCalledWith({
      status: 'active',
      limit: 50,
      offset: 0,
    })
  })
})

describe('MemorySettings — индексы', () => {
  it('показывает индекс: состояние, поколение, модель эмбеддинга и объём', async () => {
    const container = await renderSettings()

    expect(mocks.listMemoryIndexes).toHaveBeenCalled()

    const row = byTestId(container, 'memory-index-index-1')
    expect(row).toBeTruthy()
    const text = row?.textContent ?? ''
    expect(text).toContain('Project corpus')
    expect(text).toContain('failed')
    expect(text).toContain('2')
    expect(text).toContain('text-embedding-3-small')
    expect(text).toContain('1536')
    expect(text).toContain('42')
    expect(text).toContain('128')
  })

  it('индекс со статусом failed показывает текст ошибки', async () => {
    const container = await renderSettings()

    expect(byTestId(container, 'memory-index-error-index-1')?.textContent).toContain(
      'embedding provider is not configured',
    )
  })

  it('пустой список индексов — пустое состояние', async () => {
    mocks.listMemoryIndexes.mockResolvedValue({ items: [], total: 0 })
    const container = await renderSettings()

    expect(byTestId(container, 'memory-indexes-empty')?.textContent).toContain('No indexes yet')
    expect(byTestId(container, 'memory-indexes-table')).toBeNull()
  })
})

describe('MemorySettings — операции с индексами', () => {
  it('форма создания открывается с дефолтным именем и источником files', async () => {
    const container = await renderSettings()

    expect(byTestId(container, 'memory-index-create-form')).toBeNull()
    await clickTestId(container, 'memory-index-create-toggle')

    expect(byTestId(container, 'memory-index-create-form')).toBeTruthy()
    expect((byTestId(container, 'memory-index-create-name') as HTMLInputElement).value).toBe('project')
    // Проект обязателен (сервер: 400 MEMORY_PROJECT_REQUIRED) — селект проекта есть.
    expect(byTestId(container, 'memory-index-create-project')).toBeTruthy()
  })

  it('индекс files без проекта не отправляется — валидация показывает ошибку', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'memory-index-create-toggle')
    await clickTestId(container, 'memory-index-create-submit')

    expect(mocks.createMemoryIndex).not.toHaveBeenCalled()
    expect(byTestId(container, 'memory-index-create-form')?.textContent).toContain(
      'Select the project for the index.',
    )
  })

  it('успешное создание: домен вызван с name/source/projectId, список перечитан', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'memory-index-create-toggle')
    await selectOption(container, 'memory-index-create-project', 'Project One')

    const indexCalls = mocks.listMemoryIndexes.mock.calls.length
    const statusCalls = mocks.getMemoryStatus.mock.calls.length

    await clickTestId(container, 'memory-index-create-submit')

    expect(mocks.createMemoryIndex).toHaveBeenCalledWith({
      name: 'project',
      source: { kind: 'files' },
      projectId: 'project-1',
    })
    expect(mocks.listMemoryIndexes.mock.calls.length).toBe(indexCalls + 1)
    expect(mocks.getMemoryStatus.mock.calls.length).toBe(statusCalls + 1)
    // Форма закрылась после успеха.
    expect(byTestId(container, 'memory-index-create-form')).toBeNull()
  })

  it('индекс facts создаётся с проектом и без фильтра', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'memory-index-create-toggle')
    await selectOption(container, 'memory-index-create-source', 'facts')
    await selectOption(container, 'memory-index-create-project', 'Project One')

    await clickTestId(container, 'memory-index-create-submit')

    expect(mocks.createMemoryIndex).toHaveBeenCalledWith({
      name: 'project',
      source: { kind: 'facts' },
      projectId: 'project-1',
    })
  })

  it('«Пересобрать» вызывает rebuildMemoryIndex(id) и перечитывает статус и список', async () => {
    const container = await renderSettings()

    const indexCalls = mocks.listMemoryIndexes.mock.calls.length
    await clickTestId(container, 'memory-index-rebuild-index-1')

    expect(mocks.rebuildMemoryIndex).toHaveBeenCalledWith('index-1')
    expect(mocks.listMemoryIndexes.mock.calls.length).toBe(indexCalls + 1)
    expect(mocks.getMemoryStatus).toHaveBeenCalled()
  })

  it('у индекса в состоянии building кнопка «Пересобрать» заблокирована', async () => {
    mocks.listMemoryIndexes.mockResolvedValue({ items: [BUILDING_INDEX], total: 1 })
    const container = await renderSettings()

    const rebuild = byTestId(container, 'memory-index-rebuild-index-building') as HTMLButtonElement
    expect(rebuild).toBeTruthy()
    expect(rebuild.disabled).toBe(true)
    // Удаление остаётся доступным.
    const remove = byTestId(container, 'memory-index-remove-index-building') as HTMLButtonElement
    expect(remove.disabled).toBe(false)
  })

  it('«Удалить» спрашивает подтверждение и после согласия удаляет индекс', async () => {
    const container = await renderSettings()

    const indexCalls = mocks.listMemoryIndexes.mock.calls.length
    await clickTestId(container, 'memory-index-remove-index-1')

    expect(mocks.confirm).toHaveBeenCalled()
    expect(String(mocks.confirm.mock.calls[0]?.[0]?.message)).toContain('Project corpus')
    expect(mocks.deleteMemoryIndex).toHaveBeenCalledWith('index-1')
    expect(mocks.listMemoryIndexes.mock.calls.length).toBe(indexCalls + 1)
  })

  it('отказ в подтверждении оставляет индекс на месте', async () => {
    mocks.confirm.mockResolvedValue(false)
    const container = await renderSettings()

    await clickTestId(container, 'memory-index-remove-index-1')

    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.deleteMemoryIndex).not.toHaveBeenCalled()
  })

  it('409: провайдер недоступен — кнопки мутаций заблокированы, показана подсказка', async () => {
    mocks.rebuildMemoryIndex.mockRejectedValue(
      Object.assign(new Error('provider is not active'), { status: 409 }),
    )
    const container = await renderSettings()

    await clickTestId(container, 'memory-index-rebuild-index-1')

    expect(byTestId(container, 'memory-index-provider-hint')?.textContent).toContain(
      'The memory plugin is not activated.',
    )
    expect((byTestId(container, 'memory-index-rebuild-index-1') as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((byTestId(container, 'memory-index-remove-index-1') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('неактивный провайдер в статусе — кнопки мутаций заблокированы', async () => {
    mocks.getMemoryStatus.mockResolvedValue({
      ...STATUS,
      provider: { ...STATUS.provider, active: false },
    })
    const container = await renderSettings()

    expect(byTestId(container, 'memory-index-provider-hint')?.textContent).toContain(
      'The memory plugin is not activated.',
    )
    expect((byTestId(container, 'memory-index-create-toggle') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId(container, 'memory-index-rebuild-index-1') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('422: баннер показывает текст ошибки сборки', async () => {
    mocks.rebuildMemoryIndex.mockRejectedValue(
      Object.assign(new Error('embedding provider is not configured'), { status: 422 }),
    )
    const container = await renderSettings()

    await clickTestId(container, 'memory-index-rebuild-index-1')

    expect(byTestId(container, 'memory-index-mutation-error')?.textContent).toContain(
      'embedding provider is not configured',
    )
  })

  it('пока индексы собираются, статус и список опрашиваются каждые 3 с', async () => {
    mocks.listMemoryIndexes.mockResolvedValue({ items: [BUILDING_INDEX], total: 1 })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const container = await renderSettings()

      const statusCalls = mocks.getMemoryStatus.mock.calls.length
      const indexCalls = mocks.listMemoryIndexes.mock.calls.length

      await act(async () => {
        vi.advanceTimersByTime(3000)
      })
      await flush()

      expect(mocks.getMemoryStatus.mock.calls.length).toBe(statusCalls + 1)
      expect(mocks.listMemoryIndexes.mock.calls.length).toBe(indexCalls + 1)
      expect(container).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MemorySettings — ошибки', () => {
  it('ошибка загрузки показывается в баннере, «Повторить» перезапрашивает данные', async () => {
    mocks.getMemoryStatus.mockRejectedValue(new Error('memory down'))
    const container = await renderSettings()

    expect(byTestId(container, 'memory-status-error')?.textContent).toContain('memory down')

    const statusCalls = mocks.getMemoryStatus.mock.calls.length
    mocks.getMemoryStatus.mockResolvedValue(STATUS)
    await clickTestId(container, 'memory-status-retry')

    expect(mocks.getMemoryStatus.mock.calls.length).toBe(statusCalls + 1)
    expect(byTestId(container, 'memory-status-error')).toBeNull()
  })

  it('503 читается как «портал памяти недоступен»', async () => {
    mocks.listMemoryFacts.mockRejectedValue(
      Object.assign(new Error('service unavailable'), { status: 503 }),
    )
    const container = await renderSettings()

    expect(byTestId(container, 'memory-facts-error')?.textContent).toContain(
      'The memory portal is unavailable: the memory service is not configured.',
    )
  })

  it('ошибка списка индексов показывается с кнопкой «Повторить»', async () => {
    mocks.listMemoryIndexes.mockRejectedValue(new Error('indexes down'))
    const container = await renderSettings()

    expect(byTestId(container, 'memory-indexes-error')?.textContent).toContain('indexes down')
    expect(byTestId(container, 'memory-indexes-retry')).toBeTruthy()
  })
})
