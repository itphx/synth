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
  getSessionMemory: vi.fn(),
  updateProject: vi.fn(),
  createMemoryIndex: vi.fn(),
  setMemoryIndexEnabled: vi.fn(),
  rebuildMemoryIndex: vi.fn(),
  // Автоматизация памяти (ADR-101).
  getPipelineTemplates: vi.fn(),
  getProjectPipelines: vi.fn(),
  instantiatePipelineTemplate: vi.fn(),
  publishProjectPipeline: vi.fn(),
  startPipelineRun: vi.fn(),
  listPipelineRuns: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { MemoryTab } from './MemoryTab'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Ответ `GET /sessions/:id/memory` по умолчанию (всё в порядке). */
function memoryPayload(overrides: Record<string, unknown> = {}) {
  return {
    provider: { active: true },
    scope: { projectId: 'p1' },
    lastContext: {
      facts: { chars: 1200, estTokens: 300, status: 'loaded' },
      recall: { chars: 400, estTokens: 100, status: 'truncated' },
    },
    facts: { active: 12 },
    indexes: { total: 5, project: 3, instance: 2, ready: 4, building: 1, failed: 0, items: [] },
    readiness: 'ready',
    projectMemory: { enabled: true },
    ...overrides,
  }
}

/** Индекс памяти в срезе сессии. */
function memoryIndex(overrides: Record<string, unknown> = {}) {
  return {
    id: 'idx-1',
    name: 'project-docs',
    scope: 'project' as const,
    state: 'ready' as const,
    enabled: true,
    projectId: 'p1',
    ...overrides,
  }
}

/** Встроенный шаблон пайплайна инстанса (`GET /pipeline-templates`). */
function builtinTemplate(id: string) {
  return {
    id,
    name: id,
    format: 'adr-101' as const,
    version: 1,
    installedBy: { pack: 'builtin', version: '1' },
  }
}

const ALL_TEMPLATES = [
  builtinTemplate('builtin:memory-consolidation'),
  builtinTemplate('builtin:memory-consolidate-facts'),
  builtinTemplate('builtin:memory-reindex'),
]

/** Пайплайн проекта (`GET /projects/:id/pipelines`). */
function projectPipeline(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pl-1',
    name: 'Memory pipeline',
    scope: 'project' as const,
    projectId: 'p1',
    draftVersion: 1,
    hasDraft: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Пайплайн из встроенного шаблона (с провенансом `templateId`). */
function pipelineFromTemplate(templateId: string, overrides: Record<string, unknown> = {}) {
  return projectPipeline({
    installedBy: { pack: 'builtin', version: '1', templateId },
    ...overrides,
  })
}

/** Доводит отложенные промисы эффектов/обработчиков до завершения. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Значение контролируемого input — так, как это делает React. */
function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Выбор опции нативного `<select>` — так, как это делает React. */
async function setNativeSelect(el: HTMLSelectElement | null, value: string): Promise<void> {
  expect(el, 'нативный селект не найден').toBeTruthy()
  const select = el as HTMLSelectElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function renderMemory(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <MemoryTab />
      </I18nProvider>,
    )
  })
  // Дождаться резолва промисов из эффектов.
  await act(async () => {})
  await flush()
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSessionMemory.mockResolvedValue(memoryPayload())
  mocks.updateProject.mockResolvedValue({})
  mocks.createMemoryIndex.mockResolvedValue({ index: memoryIndex() })
  mocks.setMemoryIndexEnabled.mockResolvedValue({ index: memoryIndex() })
  mocks.rebuildMemoryIndex.mockResolvedValue({ index: memoryIndex({ state: 'building' }) })
  mocks.getPipelineTemplates.mockResolvedValue([])
  mocks.getProjectPipelines.mockResolvedValue([])
  mocks.instantiatePipelineTemplate.mockResolvedValue(projectPipeline())
  mocks.publishProjectPipeline.mockResolvedValue({ pipeline: projectPipeline(), published: null })
  mocks.startPipelineRun.mockResolvedValue({})
  mocks.listPipelineRuns.mockResolvedValue([])

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
    settingsPage: 'appearance',
    isSettingsDialogOpen: false,
    settingsShowAdvanced: false,
    scheduleDraft: null,
    rightPanelTab: 'context',
  })
  useAuthStore.setState({ user: { id: 'u1', username: 'admin', roles: ['ADMIN'] } as never })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

describe('MemoryTab — статус и блоки последнего хода (ADR-107)', () => {
  it('рендерит статус (готовность, провайдер, проект) и блоки фактов/recall', async () => {
    const container = await renderMemory()
    const text = container.textContent ?? ''

    expect(mocks.getSessionMemory).toHaveBeenCalledWith('s1')

    // Статус: бейдж готовности, провайдер, проект.
    expect(container.querySelector('[data-testid="memory-readiness-badge"]')?.textContent).toBe('Ready')
    expect(container.querySelector('[data-testid="memory-provider-badge"]')?.textContent).toBe('Active')
    expect(text).toContain('p1')

    // Блоки последнего хода: статус, символы и оценка токенов.
    const facts = container.querySelector('[data-testid="memory-block-facts"]')!
    expect(facts.textContent).toContain('loaded')
    expect(facts.textContent).toContain((1200).toLocaleString('en'))
    expect(facts.textContent).toContain('≈' + (300).toLocaleString('en'))
    expect(facts.textContent).toContain('Block passed in full')

    const recall = container.querySelector('[data-testid="memory-block-recall"]')!
    expect(recall.textContent).toContain('truncated')
    expect(recall.textContent).toContain('truncated by the context budget')
  })

  it('lastContext === null → «память ещё не участвовала в ходах», блоков нет', async () => {
    mocks.getSessionMemory.mockResolvedValue(memoryPayload({ lastContext: null }))

    const container = await renderMemory()

    expect(container.querySelector('[data-testid="memory-no-turns"]')?.textContent).toBe(
      'Memory has not taken part in turns yet',
    )
    expect(container.querySelector('[data-testid="memory-block-facts"]')).toBeNull()
  })

  it('recall отсутствует → «не передавался» + пояснение «не было вопроса в ходе»', async () => {
    mocks.getSessionMemory.mockResolvedValue(
      memoryPayload({
        lastContext: {
          facts: { chars: 10, estTokens: 2, status: 'empty' },
        },
      }),
    )

    const container = await renderMemory()
    const recall = container.querySelector('[data-testid="memory-block-recall"]')!

    expect(recall.textContent).toContain('not passed')
    expect(recall.textContent).toContain('Recall is not passed when the turn has no question')

    // Пустой блок фактов — со своим пояснением.
    const facts = container.querySelector('[data-testid="memory-block-facts"]')!
    expect(facts.textContent).toContain('empty')
    expect(facts.textContent).toContain('No facts / nothing found')
  })

  it('скоуп: активные факты и счётчики индексов (total/project/instance/ready/building/failed)', async () => {
    const container = await renderMemory()
    const text = container.textContent ?? ''

    expect(text).toContain('Active facts')
    expect(text).toContain('12')
    expect(text).toContain('Indexes total')
    expect(text).toContain('Project indexes')
    expect(text).toContain('Instance indexes')
    expect(text).toContain('Ready')
    expect(text).toContain('Building')
    expect(text).toContain('Failed')
  })
})

describe('MemoryTab — подсказки и ошибки', () => {
  it('indexes.failed > 0 → подсказка «пересоберите индексы»', async () => {
    mocks.getSessionMemory.mockResolvedValue(
      memoryPayload({
        indexes: { total: 5, project: 3, instance: 2, ready: 3, building: 1, failed: 1 },
      }),
    )

    const container = await renderMemory()

    expect(
      container.querySelector('[data-testid="memory-hint-failed-indexes"]')?.textContent,
    ).toBe('Some indexes failed — rebuild them')
  })

  it('provider.active === false → подсказка «плагин памяти не активен»', async () => {
    mocks.getSessionMemory.mockResolvedValue(
      memoryPayload({
        provider: { active: false },
        readiness: 'unavailable',
      }),
    )

    const container = await renderMemory()

    expect(container.querySelector('[data-testid="memory-provider-badge"]')?.textContent).toBe(
      'Inactive',
    )
    expect(container.querySelector('[data-testid="memory-readiness-badge"]')?.textContent).toBe(
      'Unavailable',
    )
    expect(
      container.querySelector('[data-testid="memory-hint-provider-inactive"]')?.textContent,
    ).toBe('Memory plugin is not active')
  })

  it('ошибка API → баннер и кнопка «Повторить» перезапрашивают данные', async () => {
    mocks.getSessionMemory.mockRejectedValueOnce(new Error('boom'))

    const container = await renderMemory()

    const banner = container.querySelector('[data-testid="memory-error"]')
    expect(banner).not.toBeNull()
    expect(banner?.getAttribute('role')).toBe('alert')
    expect(banner?.textContent).toContain('boom')

    mocks.getSessionMemory.mockResolvedValue(memoryPayload())
    const retry = container.querySelector('[data-testid="memory-retry"]') as HTMLButtonElement
    expect(retry).not.toBeNull()
    await act(async () => {
      retry.click()
    })
    await act(async () => {})

    expect(mocks.getSessionMemory.mock.calls.length).toBe(2)
    expect(container.querySelector('[data-testid="memory-error"]')).toBeNull()
    expect(container.querySelector('[data-testid="memory-readiness-badge"]')).not.toBeNull()
  })
})

describe('MemoryTab — управление памятью проекта', () => {
  it('тумблер «Память для проекта» шлёт updateProject({memory.enabled:false}) и перечитывает данные', async () => {
    const container = await renderMemory()

    const toggle = container.querySelector(
      '[data-testid="memory-project-memory-toggle"] [role="switch"]',
    ) as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      toggle.click()
    })
    await act(async () => {})

    expect(mocks.updateProject).toHaveBeenCalledWith('p1', { memory: { enabled: false } })
    expect(mocks.getSessionMemory).toHaveBeenCalledTimes(2)
  })

  it('ошибка 403 → inline-сообщение, состояние тумблера не меняется', async () => {
    mocks.updateProject.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))

    const container = await renderMemory()

    const toggle = container.querySelector(
      '[data-testid="memory-project-memory-toggle"] [role="switch"]',
    ) as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    await act(async () => {})

    const errorBox = container.querySelector('[data-testid="memory-project-memory-error"]')
    expect(errorBox).not.toBeNull()
    expect(errorBox?.getAttribute('role')).toBe('alert')
    expect(errorBox?.textContent).toBe('Not enough rights to change memory')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(mocks.getSessionMemory).toHaveBeenCalledTimes(1)
  })

  it('projectMemory === null → подсказка «сессия без проекта», тумблера нет', async () => {
    mocks.getSessionMemory.mockResolvedValue(memoryPayload({ scope: {}, projectMemory: null }))

    const container = await renderMemory()

    expect(
      container.querySelector('[data-testid="memory-project-memory-hint"]')?.textContent,
    ).toBe('Session has no project — project memory is not configurable')
    expect(container.querySelector('[data-testid="memory-project-memory-toggle"]')).toBeNull()
  })
})

describe('MemoryTab — создание индексов', () => {
  it('ADMIN: форма project+files шлёт корректный createMemoryIndex и перечитывает данные', async () => {
    const container = await renderMemory()

    const createButton = container.querySelector(
      '[data-testid="memory-create-index"]',
    ) as HTMLButtonElement
    expect(createButton).not.toBeNull()
    await act(async () => {
      createButton.click()
    })

    expect(container.querySelector('[data-testid="memory-create-index-form"]')).not.toBeNull()
    const name = container.querySelector('[data-testid="memory-create-name"]') as HTMLInputElement
    // Осмысленное имя по умолчанию для индекса проекта.
    expect(name.value).toBe('project-memory')

    await act(async () => {
      setInputValue(name, 'docs-index')
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="memory-create-submit"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.createMemoryIndex).toHaveBeenCalledWith({
      name: 'docs-index',
      source: { kind: 'files' },
      projectId: 'p1',
    })
    expect(mocks.getSessionMemory).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-testid="memory-create-index-form"]')).toBeNull()
  })

  it('ADMIN: форма instance+facts шлёт scope без projectId и показывает предупреждение для files', async () => {
    const container = await renderMemory()

    await act(async () => {
      ;(container.querySelector('[data-testid="memory-create-index"]') as HTMLButtonElement).click()
    })

    // instance + files — предупреждение о раскрытии workspace проекта.
    await setNativeSelect(
      container.querySelector('[data-testid="memory-create-scope"]') as HTMLSelectElement,
      'instance',
    )
    expect(
      container.querySelector('[data-testid="memory-create-instance-warning"]')?.textContent,
    ).toContain('visible to all users of the instance')

    await setNativeSelect(
      container.querySelector('[data-testid="memory-create-source"]') as HTMLSelectElement,
      'facts',
    )
    expect(container.querySelector('[data-testid="memory-create-instance-warning"]')).toBeNull()

    const name = container.querySelector('[data-testid="memory-create-name"]') as HTMLInputElement
    await act(async () => {
      setInputValue(name, 'facts-index')
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="memory-create-submit"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.createMemoryIndex).toHaveBeenCalledWith({
      name: 'facts-index',
      source: { kind: 'facts' },
      scope: 'instance',
    })
  })

  it('не-ADMIN: кнопок создания/пересборки и переключателей индексов нет', async () => {
    useAuthStore.setState({ user: { id: 'u2', username: 'user', roles: ['USER'] } as never })
    mocks.getSessionMemory.mockResolvedValue(
      memoryPayload({
        indexes: {
          total: 1,
          project: 1,
          instance: 0,
          ready: 1,
          building: 0,
          failed: 0,
          items: [memoryIndex()],
        },
      }),
    )

    const container = await renderMemory()

    expect(container.querySelector('[data-testid="memory-create-index"]')).toBeNull()
    expect(container.querySelector('[data-testid="memory-index-rebuild-idx-1"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="memory-index-idx-1"] [role="switch"]'),
    ).toBeNull()
    // Тумблер памяти проекта доступен и не-ADMIN.
    expect(container.querySelector('[data-testid="memory-project-memory-toggle"]')).not.toBeNull()
  })
})

describe('MemoryTab — список индексов', () => {
  it('переключатель проектного индекса шлёт setMemoryIndexEnabled(id,false) и перечитывает данные', async () => {
    mocks.getSessionMemory.mockResolvedValue(
      memoryPayload({
        indexes: {
          total: 1,
          project: 1,
          instance: 0,
          ready: 1,
          building: 0,
          failed: 0,
          items: [memoryIndex()],
        },
      }),
    )

    const container = await renderMemory()

    const toggle = container.querySelector(
      '[data-testid="memory-index-idx-1"] [role="switch"]',
    ) as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      toggle.click()
    })
    await act(async () => {})

    expect(mocks.setMemoryIndexEnabled).toHaveBeenCalledWith('idx-1', false)
    expect(mocks.getSessionMemory).toHaveBeenCalledTimes(2)
  })

  it('409 MEMORY_INDEX_NOT_TOGGLEABLE → понятное inline-сообщение', async () => {
    mocks.getSessionMemory.mockResolvedValue(
      memoryPayload({
        indexes: {
          total: 1,
          project: 1,
          instance: 0,
          ready: 1,
          building: 0,
          failed: 0,
          items: [memoryIndex()],
        },
      }),
    )
    mocks.setMemoryIndexEnabled.mockRejectedValue(
      Object.assign(new Error('not toggleable'), {
        status: 409,
        code: 'MEMORY_INDEX_NOT_TOGGLEABLE',
      }),
    )

    const container = await renderMemory()

    await act(async () => {
      ;(
        container.querySelector(
          '[data-testid="memory-index-idx-1"] [role="switch"]',
        ) as HTMLButtonElement
      ).click()
    })
    await act(async () => {})

    const errorBox = container.querySelector('[data-testid="memory-index-error"]')
    expect(errorBox).not.toBeNull()
    expect(errorBox?.getAttribute('role')).toBe('alert')
    expect(errorBox?.textContent).toBe('This index cannot be disabled')
  })

  it('instance-индекс: бейдж «не отключается», переключателя нет', async () => {
    mocks.getSessionMemory.mockResolvedValue(
      memoryPayload({
        indexes: {
          total: 1,
          project: 0,
          instance: 1,
          ready: 1,
          building: 0,
          failed: 0,
          items: [memoryIndex({ id: 'idx-inst', name: 'shared', scope: 'instance' })],
        },
      }),
    )

    const container = await renderMemory()

    const locked = container.querySelector('[data-testid="memory-index-locked-idx-inst"]')
    expect(locked?.textContent).toContain('Shared · cannot be disabled')
    expect(
      container.querySelector('[data-testid="memory-index-idx-inst"] [role="switch"]'),
    ).toBeNull()
  })

  it('выключенный индекс помечен и приглушён', async () => {
    mocks.getSessionMemory.mockResolvedValue(
      memoryPayload({
        indexes: {
          total: 1,
          project: 1,
          instance: 0,
          ready: 1,
          building: 0,
          failed: 0,
          items: [memoryIndex({ enabled: false })],
        },
      }),
    )

    const container = await renderMemory()

    const row = container.querySelector('[data-testid="memory-index-idx-1"]') as HTMLElement
    expect(row.getAttribute('data-enabled')).toBe('false')
    expect(row.className).toContain('opacity-60')
    expect(row.textContent).toContain('not used in recall')
    expect(
      container
        .querySelector('[data-testid="memory-index-idx-1"] [role="switch"]')
        ?.getAttribute('aria-checked'),
    ).toBe('false')
  })

  it('ADMIN: «Пересобрать» у индекса вызывает rebuildMemoryIndex и перечитывает данные', async () => {
    mocks.getSessionMemory.mockResolvedValue(
      memoryPayload({
        indexes: {
          total: 1,
          project: 1,
          instance: 0,
          ready: 1,
          building: 0,
          failed: 0,
          items: [memoryIndex()],
        },
      }),
    )

    const container = await renderMemory()

    const rebuild = container.querySelector(
      '[data-testid="memory-index-rebuild-idx-1"]',
    ) as HTMLButtonElement
    expect(rebuild).not.toBeNull()
    await act(async () => {
      rebuild.click()
    })
    await act(async () => {})

    expect(mocks.rebuildMemoryIndex).toHaveBeenCalledWith('idx-1')
    expect(mocks.getSessionMemory).toHaveBeenCalledTimes(2)
  })
})

describe('MemoryTab — без нижней кнопки настроек', () => {
  it('футера и кнопки «Настройки памяти» нет (ADMIN)', async () => {
    const container = await renderMemory()

    expect(container.querySelector('[data-testid="panel-tab-footer"]')).toBeNull()
    expect(container.querySelector('[data-testid="memory-open-settings"]')).toBeNull()
  })
})

describe('MemoryTab — автоматизация памяти (ADR-101)', () => {
  it('ADMIN + проект: три действия; у извлечения нет расписания', async () => {
    mocks.getPipelineTemplates.mockResolvedValue(ALL_TEMPLATES)
    const container = await renderMemory()

    expect(container.querySelector('[data-testid="memory-automation-list"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="memory-automation-row-extract"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="memory-automation-row-dedupe"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="memory-automation-row-reindex"]')).not.toBeNull()

    expect(
      container.querySelector('[data-testid="memory-automation-schedule-extract"]'),
    ).toBeNull()
    expect(
      container.querySelector('[data-testid="memory-automation-schedule-dedupe"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="memory-automation-schedule-reindex"]'),
    ).not.toBeNull()
  })

  it('не-ADMIN: секции автоматизации нет', async () => {
    useAuthStore.setState({ user: { id: 'u2', username: 'user', roles: ['USER'] } as never })
    mocks.getPipelineTemplates.mockResolvedValue(ALL_TEMPLATES)

    const container = await renderMemory()

    expect(container.querySelector('[data-testid="memory-automation-list"]')).toBeNull()
    expect(container.querySelector('[data-testid="memory-automation-row-extract"]')).toBeNull()
    expect(mocks.getPipelineTemplates).not.toHaveBeenCalled()
  })

  it('«Подготовить пайплайн»: instantiate с ensure + publish, затем reload', async () => {
    mocks.getPipelineTemplates.mockResolvedValue(ALL_TEMPLATES)
    mocks.instantiatePipelineTemplate.mockResolvedValue(
      projectPipeline({ id: 'pl-new', name: 'Merged facts' }),
    )

    const container = await renderMemory()
    const prepare = container.querySelector(
      '[data-testid="memory-automation-prepare-dedupe"]',
    ) as HTMLButtonElement
    expect(prepare).not.toBeNull()

    await act(async () => {
      prepare.click()
    })
    await flush()

    expect(mocks.instantiatePipelineTemplate).toHaveBeenCalledWith(
      'builtin:memory-consolidate-facts',
      { projectId: 'p1', ensure: true },
    )
    expect(mocks.publishProjectPipeline).toHaveBeenCalledWith('p1', 'pl-new')
    // Секция перечитывает шаблоны/пайплайны после подготовки.
    expect(mocks.getPipelineTemplates.mock.calls.length).toBeGreaterThan(1)
  })

  it('«Запустить сейчас» для извлечения: payload {sessionId}', async () => {
    mocks.getPipelineTemplates.mockResolvedValue(ALL_TEMPLATES)
    mocks.getProjectPipelines.mockResolvedValue([
      pipelineFromTemplate('builtin:memory-consolidation', {
        id: 'pl-cons',
        publishedVersion: 1,
      }),
    ])

    const container = await renderMemory()
    const run = container.querySelector(
      '[data-testid="memory-automation-run-extract"]',
    ) as HTMLButtonElement
    expect(run.disabled).toBe(false)

    await act(async () => {
      run.click()
    })
    await flush()

    expect(mocks.startPipelineRun).toHaveBeenCalledWith('p1', 'pl-cons', {
      trigger: { kind: 'manual', payload: { sessionId: 's1' } },
    })
    expect(mocks.listPipelineRuns).toHaveBeenCalledWith('p1', 'pl-cons', { limit: 1 })
  })

  it('«Запустить сейчас» для слияния дублей: без payload', async () => {
    mocks.getPipelineTemplates.mockResolvedValue(ALL_TEMPLATES)
    mocks.getProjectPipelines.mockResolvedValue([
      pipelineFromTemplate('builtin:memory-consolidate-facts', {
        id: 'pl-dedupe',
        publishedVersion: 2,
      }),
    ])

    const container = await renderMemory()
    const run = container.querySelector(
      '[data-testid="memory-automation-run-dedupe"]',
    ) as HTMLButtonElement

    await act(async () => {
      run.click()
    })
    await flush()

    expect(mocks.startPipelineRun).toHaveBeenCalledWith('p1', 'pl-dedupe', {
      trigger: { kind: 'manual' },
    })
  })

  it('«Расписание»: deep-link — setScheduleDraft и вкладка scheduler', async () => {
    mocks.getPipelineTemplates.mockResolvedValue(ALL_TEMPLATES)
    mocks.getProjectPipelines.mockResolvedValue([
      pipelineFromTemplate('builtin:memory-consolidate-facts', {
        id: 'pl-dedupe',
        publishedVersion: 2,
      }),
    ])

    const container = await renderMemory()
    const schedule = container.querySelector(
      '[data-testid="memory-automation-schedule-dedupe"]',
    ) as HTMLButtonElement
    expect(schedule.disabled).toBe(false)

    await act(async () => {
      schedule.click()
    })
    await flush()

    expect(useUIStore.getState().scheduleDraft).toEqual({
      name: 'Memory: merge duplicate facts',
      projectId: 'p1',
      pipelineId: 'pl-dedupe',
      cron: '0 3 * * *',
    })
    expect(useUIStore.getState().rightPanelTab).toBe('scheduler')
    expect(mocks.startPipelineRun).not.toHaveBeenCalled()
  })

  it('шаблон отсутствует → «шаблон не найден», подготовка disabled', async () => {
    mocks.getPipelineTemplates.mockResolvedValue([])

    const container = await renderMemory()

    const row = container.querySelector('[data-testid="memory-automation-row-extract"]')!
    expect(row.textContent).toContain('template not found')
    expect(
      (container.querySelector('[data-testid="memory-automation-prepare-extract"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      (container.querySelector('[data-testid="memory-automation-run-extract"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('последний прогон отображается бейджем статуса и временем', async () => {
    mocks.getPipelineTemplates.mockResolvedValue(ALL_TEMPLATES)
    mocks.getProjectPipelines.mockResolvedValue([
      pipelineFromTemplate('builtin:memory-consolidation', {
        id: 'pl-cons',
        publishedVersion: 1,
      }),
    ])
    mocks.listPipelineRuns.mockResolvedValue([
      {
        id: 'run-1',
        pipelineId: 'pl-cons',
        version: 1,
        status: 'done',
        createdAt: '2026-10-01T10:00:00.000Z',
      },
    ])

    const container = await renderMemory()
    const lastRun = container.querySelector('[data-testid="memory-automation-lastrun-extract"]')!

    expect(lastRun.textContent).toContain('completed')
    expect(lastRun.textContent).toContain('2026')
  })

  it('ошибка подготовки — inline alert внутри строки', async () => {
    mocks.getPipelineTemplates.mockResolvedValue(ALL_TEMPLATES)
    mocks.instantiatePipelineTemplate.mockRejectedValue(new Error('boom'))

    const container = await renderMemory()
    const prepare = container.querySelector(
      '[data-testid="memory-automation-prepare-dedupe"]',
    ) as HTMLButtonElement

    await act(async () => {
      prepare.click()
    })
    await flush()

    const errorBox = container.querySelector(
      '[data-testid="memory-automation-action-error-dedupe"]',
    )
    expect(errorBox).not.toBeNull()
    expect(errorBox?.getAttribute('role')).toBe('alert')
    expect(errorBox?.textContent).toContain('Failed to prepare pipeline')
    expect(errorBox?.textContent).toContain('boom')
  })

  it('ошибка загрузки — inline alert с «Повторить»', async () => {
    mocks.getPipelineTemplates.mockRejectedValueOnce(new Error('templates down'))

    const container = await renderMemory()

    const banner = container.querySelector('[data-testid="memory-automation-error"]')
    expect(banner).not.toBeNull()
    expect(banner?.getAttribute('role')).toBe('alert')
    expect(banner?.textContent).toContain('templates down')

    mocks.getPipelineTemplates.mockResolvedValue([])
    await act(async () => {
      ;(container.querySelector('[data-testid="memory-automation-retry"]') as HTMLButtonElement).click()
    })
    await flush()

    expect(container.querySelector('[data-testid="memory-automation-error"]')).toBeNull()
    expect(container.querySelector('[data-testid="memory-automation-list"]')).not.toBeNull()
  })
})
