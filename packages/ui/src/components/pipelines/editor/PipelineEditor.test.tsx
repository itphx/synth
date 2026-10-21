/**
 * Компонентные тесты визуального редактора пайплайнов (ADR-101, Э7.2).
 *
 * Покрытие:
 * - палитра: добавление шага каждого вида (agent/script/tool/human) — узел
 *   появился на канвасе и попал в спецификацию;
 * - инспектор: правка поля шага — спецификация изменилась;
 * - ребро: новое ребро между узлами — в спецификации появился условный переход;
 * - страница пайплайна (PipelineTab): «Проверить» показывает проблемы
 *   невалидной спецификации (`validatePipelineSpec`) и пустой список для
 *   валидной; «Сохранить черновик» уходит в `updateProjectPipeline` с той же
 *   спецификацией (round-trip редактора точен).
 *
 * jsdom не умеет то, что нужно React Flow: `ResizeObserver` (замер канваса),
 * `SVGElement.getBBox` (подпись ребра), `DOMMatrixReadOnly` (трансформация
 * viewport) и `document.elementFromPoint` (поиск ручки под курсором) —
 * стабы ниже. Транспорт и API не поднимаются: домен и сторы замоканы.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const jsdom = vi.hoisted(() => {
  // persist (zustand) в сторах пишет в localStorage — в Node/vitest его нет.
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

  // React Flow: замер канваса и узлов. Наблюдатель сразу сообщает размеры
  // (как в браузере), иначе узлы остаются «неизмеренными» и ручки не
  // регистрируются — соединение нельзя начать.
  class ResizeObserverStub {
    private callback: (entries: unknown[], observer: unknown) => void
    constructor(callback: (entries: unknown[], observer: unknown) => void) {
      this.callback = callback
    }
    observe(target: Element): void {
      queueMicrotask(() => {
        this.callback(
          [
            {
              target,
              contentRect: { width: 240, height: 76, top: 0, left: 0, right: 240, bottom: 76 },
            },
          ],
          this,
        )
      })
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })

    // Подпись ребра: замер текста через getBBox.
    Object.defineProperty(window.SVGElement.prototype, 'getBBox', {
      value: () => ({ x: 0, y: 0, width: 10, height: 10 }),
      configurable: true,
    })

    // Трансформация viewport (вычисление координат).
    class DOMMatrixReadOnlyStub {
      m22 = 1
      constructor() {}
    }
    Object.defineProperty(window, 'DOMMatrixReadOnly', {
      value: DOMMatrixReadOnlyStub,
      configurable: true,
    })

    // Размеры узлов: React Flow меряет их через offsetWidth/offsetHeight.
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 240,
    })
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 76,
    })
  }

  // Поиск ручки под курсором: тест сам задаёт «ручку под мышью».
  const pointer = { element: null as Element | null }
  if (typeof document !== 'undefined') {
    Object.defineProperty(document, 'elementFromPoint', {
      value: () => pointer.element,
      configurable: true,
    })
  }
  return { pointer }
})

const mocks = vi.hoisted(() => ({
  getProjectPipeline: vi.fn(),
  getProjectPipelines: vi.fn(),
  updateProjectPipeline: vi.fn(),
  publishProjectPipeline: vi.fn(),
  startPipelineRun: vi.fn(),
  deleteProjectPipeline: vi.fn(),
  listPipelineRuns: vi.fn(),
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
import { useProjectsStore } from '@/stores/projectsStore'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { usePipelinesStore } from '@/stores/pipelinesStore'
import type { PipelineSpec } from '@itphx/synth-shared/types'
import { PipelineTab } from '../PipelineTab'
import { PipelineEditor } from './PipelineEditor'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Спецификация с двумя шагами — есть что соединять ребром. */
const SPEC: PipelineSpec = {
  id: 'pl1',
  name: 'Release',
  version: 2,
  status: 'draft',
  mode: 'plan',
  nodes: [
    { id: 'step-1', kind: 'agent', title: 'Draft', agent: 'assistant' },
    { id: 'step-2', kind: 'tool', title: 'Check', tool: 'git_status' },
  ],
  exits: [{ kind: 'none' }],
}

/** Спецификация без обязательного поля вида «agent» — семантически невалидна. */
const INVALID_SPEC: PipelineSpec = {
  ...SPEC,
  nodes: [{ id: 'step-1', kind: 'agent', title: 'Draft' }],
}

const TAB: CenterTab = {
  id: 'pipeline-p1-pl1',
  type: 'pipeline',
  title: 'Release',
  data: { projectId: 'p1', pipelineId: 'pl1' },
}

const PROJECT = {
  id: 'p1',
  name: 'Proj1',
  owner_id: 'u1',
  members: {},
  description: '',
  current_task: '',
  invariants: '',
  icon: null,
  color: null,
  workspace: '/ws/p1',
  repos: [],
  status_messages: [],
  plan: null,
  created_at: '',
  updated_at: '',
}

/** Детали пайплайна для страницы (черновик — `spec`). */
const detailFor = (spec: PipelineSpec) => ({
  pipeline: {
    id: 'pl1',
    name: 'Release',
    description: 'Release pipeline',
    scope: 'project' as const,
    projectId: 'p1',
    draftVersion: 2,
    publishedVersion: undefined,
    hasDraft: true,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T11:00:00.000Z',
    draft: spec,
  },
  published: null,
  versions: [],
})

/** Поле инспектора по подписи (label → input в том же блоке). */
function fieldInput(container: HTMLElement, label: string): HTMLInputElement {
  const labels = Array.from(container.querySelectorAll('label'))
  const found = labels.find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`Поле «${label}» не найдено в инспекторе`)
  const input = found.parentElement?.querySelector('input')
  if (!input) throw new Error(`У поля «${label}» нет input`)
  return input as HTMLInputElement
}

/** Ввод значения в контролируемое поле (React 19 отслеживает value). */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {})
}

async function renderEditor(spec: PipelineSpec): Promise<{
  container: HTMLElement
  lastSpec: () => PipelineSpec | null
}> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })

  let current: PipelineSpec | null = null
  await act(async () => {
    root.render(
      <I18nProvider>
        <PipelineEditor spec={spec} onChange={(next) => { current = next }} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return { container, lastSpec: () => current }
}

async function renderPage(spec: PipelineSpec): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  // Черновик на сервере — тот, с которым работает страница.
  mocks.getProjectPipeline.mockResolvedValue(detailFor(spec))
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })

  await act(async () => {
    root.render(
      <I18nProvider>
        <PipelineTab tab={TAB} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

const action = (container: HTMLElement, name: string): HTMLElement | null =>
  container.querySelector(`[data-action="${name}"]`)

beforeEach(() => {
  mocks.getProjectPipeline.mockResolvedValue(detailFor(SPEC))
  mocks.getProjectPipelines.mockResolvedValue([detailFor(SPEC).pipeline])
  mocks.updateProjectPipeline.mockResolvedValue(detailFor(SPEC).pipeline)
  mocks.publishProjectPipeline.mockResolvedValue(detailFor(SPEC))
  mocks.startPipelineRun.mockResolvedValue({ id: 'run9', pipelineId: 'pl1', version: 1, status: 'pending' })
  mocks.deleteProjectPipeline.mockResolvedValue(undefined)
  mocks.listPipelineRuns.mockResolvedValue([])
  mocks.confirm.mockResolvedValue(true)

  useAuthStore.setState({
    user: { id: 'u1', username: 'u1', email: null, roles: ['USER'] },
  })
  useUIStore.setState({ centerTabs: [TAB], activeCenterTabId: TAB.id })
  useProjectsStore.setState({ projects: [PROJECT] as never, loading: false, error: null })
  usePipelinesStore.setState({
    pipelinesByProject: {},
    loadedProjects: new Set<string>(),
    loadingProjects: new Set<string>(),
    runsByPipeline: {},
    runDetail: {},
    runSignal: {},
    error: null,
  })
  jsdom.pointer.element = null
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

describe('PipelineEditor — палитра: добавление шага', () => {
  it.each(['agent', 'script', 'tool', 'human'] as const)(
    'шаг вида «%s» появляется на канвасе и попадает в спецификацию',
    async (kind) => {
      const { container, lastSpec } = await renderEditor(SPEC)

      const button = action(container, `add-node-${kind}`) as HTMLButtonElement
      expect(button).toBeTruthy()
      await act(async () => {
        button.click()
      })
      await act(async () => {})

      // Узел появился на канвасе.
      const node = container.querySelector('[data-id="node-1"]')
      expect(node).toBeTruthy()
      expect(node?.getAttribute('data-testid')).toBe('rf__node-node-1')

      // И попал в спецификацию — в конец цепочки.
      const spec = lastSpec()
      expect(spec?.nodes.map((item) => item.id)).toEqual(['step-1', 'step-2', 'node-1'])
      expect(spec?.nodes[2]?.kind).toBe(kind)
    },
  )

  it('новый шаг сразу выбран — инспектор показывает его поля', async () => {
    const { container } = await renderEditor(SPEC)

    const button = action(container, 'add-node-tool') as HTMLButtonElement
    await act(async () => {
      button.click()
    })
    await act(async () => {})

    const inspector = container.querySelector('[data-testid="pipeline-inspector"]')
    expect(inspector?.textContent ?? '').toContain('node-1')
  })
})

describe('PipelineEditor — инспектор: правка полей', () => {
  it('правка названия шага меняет спецификацию', async () => {
    const { container, lastSpec } = await renderEditor(SPEC)

    // Выбираем первый шаг (клик по карточке узла на канвасе).
    const card = container.querySelector('[data-node-id="step-1"]') as HTMLElement
    await act(async () => {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    const title = fieldInput(container, 'Title')
    expect(title.value).toBe('Draft')

    await typeInto(title, 'Черновик релиза')

    const spec = lastSpec()
    expect(spec?.nodes[0]?.title).toBe('Черновик релиза')
    // Остальные поля узла не потеряны.
    expect(spec?.nodes[0]?.agent).toBe('assistant')
    expect(spec?.nodes[0]?.kind).toBe('agent')
  })
})

describe('PipelineEditor — переходы: новое ребро', () => {
  it('новое ребро между узлами попадает в спецификацию как условный переход', async () => {
    const { container, lastSpec } = await renderEditor(SPEC)

    const source = container.querySelector(
      '[data-nodeid="step-1"][data-handlepos="bottom"]',
    ) as HTMLElement
    const target = container.querySelector(
      '[data-nodeid="step-2"][data-handlepos="top"]',
    ) as HTMLElement
    expect(source).toBeTruthy()
    expect(target).toBeTruthy()

    // Ручка под курсором — целевая.
    jsdom.pointer.element = target

    await act(async () => {
      source.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }),
      )
    })
    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 120, clientY: 120 }),
      )
    })
    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 120 }),
      )
    })
    await act(async () => {})

    const spec = lastSpec()
    expect(spec?.nodes[0]?.on).toEqual([
      { when: { path: 'prev.output.status', op: 'eq', value: 'ok' }, then: 'step-2' },
    ])
    // Узел-цель перехода переходов не получает (у него своих нет).
    expect(spec?.nodes[1]?.on).toBeUndefined()
  })
})

describe('PipelineEditor — атрибуция React Flow', () => {
  it('бренд React Flow виден: атрибуция не скрывается', async () => {
    const { container } = await renderEditor(SPEC)

    const attribution = container.querySelector('.react-flow__attribution')
    expect(attribution).toBeTruthy()
    expect(attribution?.textContent ?? '').toContain('React Flow')
  })
})

describe('Страница пайплайна — «Проверить» и «Сохранить черновик»', () => {
  it('невалидная спецификация: показаны проблемы (validatePipelineSpec)', async () => {
    const container = await renderPage(INVALID_SPEC)

    const validate = action(container, 'validate') as HTMLButtonElement
    await act(async () => {
      validate.click()
    })
    await act(async () => {})

    const panel = container.querySelector('[data-testid="pipeline-validation"]')
    expect(panel).toBeTruthy()
    expect(panel?.textContent ?? '').toContain('Problems')
    expect(panel?.querySelectorAll('li').length).toBeGreaterThan(0)
    // Проблема указывает на узел, у которого не заполнено поле вида.
    expect(panel?.textContent ?? '').toContain('step-1')
  })

  it('валидная спецификация: список проблем пуст', async () => {
    const container = await renderPage(SPEC)

    const validate = action(container, 'validate') as HTMLButtonElement
    await act(async () => {
      validate.click()
    })
    await act(async () => {})

    const panel = container.querySelector('[data-testid="pipeline-validation"]')
    expect(panel).toBeTruthy()
    expect(panel?.textContent ?? '').toContain('The specification is valid')
    expect(panel?.querySelectorAll('li')).toHaveLength(0)
  })

  it('«Сохранить черновик»: правка в редакторе уходит в updateProjectPipeline без потерь', async () => {
    const container = await renderPage(SPEC)

    // Правка шага в редакторе (страница открыта в режиме «Визуальный»).
    const card = container.querySelector('[data-node-id="step-1"]') as HTMLElement
    await act(async () => {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})
    await typeInto(fieldInput(container, 'Title'), 'Черновик релиза')

    const save = action(container, 'save-draft') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.updateProjectPipeline).toHaveBeenCalledWith('p1', 'pl1', {
      name: 'Release',
      description: 'Release pipeline',
      spec: expect.objectContaining({
        id: 'pl1',
        mode: 'plan',
        exits: [{ kind: 'none' }],
        nodes: [
          expect.objectContaining({ id: 'step-1', title: 'Черновик релиза', agent: 'assistant' }),
          expect.objectContaining({ id: 'step-2', kind: 'tool', tool: 'git_status' }),
        ],
      }),
    })
  })

  it('невалидная спецификация на сервер не уходит', async () => {
    const container = await renderPage(INVALID_SPEC)

    const save = action(container, 'save-draft') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.updateProjectPipeline).not.toHaveBeenCalled()
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    )
  })
})
