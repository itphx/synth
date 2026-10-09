import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  listEventBindings: vi.fn(),
  upsertEventBinding: vi.fn(),
  deleteEventBinding: vi.fn(),
  getEventJournal: vi.fn(),
  getEventRoutes: vi.fn(),
  createEventRoute: vi.fn(),
  deleteEventRoute: vi.fn(),
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
import { EventsAdminSettings } from './EventsAdminSettings'
import type { EventBinding, EventRouteRule } from '@itphx/synth-shared'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function binding(id: string, overrides: Partial<EventBinding> = {}): EventBinding {
  return {
    id,
    source: 'telegram',
    mode: 'bound',
    ...overrides,
  }
}

function rule(id: string, overrides: Partial<EventRouteRule> = {}): EventRouteRule {
  return {
    id,
    priority: 0,
    enabled: true,
    match: {},
    target: { mode: 'bound', sessionId: 'sess-1' },
    ...overrides,
  }
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <EventsAdminSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listEventBindings.mockResolvedValue({ bindings: [] })
  mocks.upsertEventBinding.mockImplementation(async (input: unknown) => ({
    id: 'new',
    ...(input as object),
  }))
  mocks.deleteEventBinding.mockResolvedValue(undefined)
  mocks.getEventJournal.mockResolvedValue({ entries: [] })
  mocks.getEventRoutes.mockResolvedValue({ rules: [] })
  mocks.createEventRoute.mockImplementation(async (input: unknown) => ({
    id: 'new',
    priority: 0,
    enabled: true,
    match: {},
    target: { mode: 'bound', sessionId: '' },
    ...(input as object),
  }))
  mocks.deleteEventRoute.mockResolvedValue(undefined)
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
  document.body.innerHTML = ''
})

describe('EventsAdminSettings — биндинги и журнал (AD-089)', () => {
  it('рендерит список биндингов из API', async () => {
    mocks.listEventBindings.mockResolvedValue({
      bindings: [binding('b1', { threadKey: 'thread:telegram:1:2', project: 'p1', agentTemplate: 'assistant' })],
    })
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="events-bindings-list"]')).not.toBeNull()
    const row = container.querySelector('[data-testid="events-binding-b1"]')!
    expect(row.textContent).toContain('telegram')
    expect(row.textContent).toContain('thread:telegram:1:2')
    expect(row.textContent).toContain('p1')
    expect(row.textContent).toContain('assistant')
  })

  it('пустое состояние, когда биндингов нет', async () => {
    const container = await renderSettings()
    expect(container.textContent).toContain('No event bindings configured')
  })

  it('создание шлёт source/mode и опускает пустые поля', async () => {
    const container = await renderSettings()

    await act(async () => {
      ;(container.querySelector('[data-testid="events-binding-add"]') as HTMLButtonElement).click()
    })

    const source = container.querySelector('[data-testid="events-binding-source"]') as HTMLInputElement
    const chatKey = container.querySelector('[data-testid="events-binding-chat-key"]') as HTMLInputElement
    await act(async () => {
      setInputValue(source, '  webhook  ')
      setInputValue(chatKey, 'chat:webhook:1')
    })

    await act(async () => {
      ;(container.querySelector('[data-testid="events-binding-save"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.upsertEventBinding).toHaveBeenCalledTimes(1)
    expect(mocks.upsertEventBinding).toHaveBeenCalledWith({
      source: 'webhook',
      chatKey: 'chat:webhook:1',
      threadKey: undefined,
      sessionId: undefined,
      mode: 'bound',
      agentTemplate: undefined,
      project: undefined,
    })
  })

  it('создание без source не вызывает API и показывает ошибку', async () => {
    const container = await renderSettings()
    await act(async () => {
      ;(container.querySelector('[data-testid="events-binding-add"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="events-binding-save"]') as HTMLButtonElement).click()
    })

    expect(mocks.upsertEventBinding).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Source is required')
  })

  it('редактирование открывает форму с текущими значениями', async () => {
    mocks.listEventBindings.mockResolvedValue({
      bindings: [binding('b1', { chatKey: 'chat:telegram:9', mode: 'ephemeral', agentTemplate: 'assistant' })],
    })
    const container = await renderSettings()

    await act(async () => {
      ;(container.querySelector('[data-testid="events-binding-edit-b1"]') as HTMLButtonElement).click()
    })

    expect(container.querySelector('[data-testid="events-binding-editor"]')).not.toBeNull()
    expect((container.querySelector('[data-testid="events-binding-chat-key"]') as HTMLInputElement).value).toBe(
      'chat:telegram:9',
    )
    expect((container.querySelector('[data-testid="events-binding-agent"]') as HTMLInputElement).value).toBe(
      'assistant',
    )
  })

  it('удаление подтверждается через confirm и вызывает deleteEventBinding', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1', { chatKey: 'chat:telegram:9' })] })
    const container = await renderSettings()

    await act(async () => {
      ;(container.querySelector('[data-testid="events-binding-delete-b1"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteEventBinding).toHaveBeenCalledWith('b1')
  })

  it('отмена подтверждения не удаляет биндинг', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    mocks.confirm.mockResolvedValue(false)
    const container = await renderSettings()

    await act(async () => {
      ;(container.querySelector('[data-testid="events-binding-delete-b1"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.deleteEventBinding).not.toHaveBeenCalled()
  })

  it('загружает журнал и показывает решение, причину и ошибку', async () => {
    mocks.getEventJournal.mockResolvedValue({
      entries: [
        {
          ts: '2026-10-08T10:00:00.000Z',
          event: { id: 'evt_1', source: 'telegram', type: 'message', payload: {}, identity: {}, dedupKey: 'd1', ts: '2026-10-08T10:00:00.000Z' },
          decision: { kind: 'queue', owner: 'u1', reason: 'session busy' },
        },
        {
          ts: '2026-10-08T10:01:00.000Z',
          event: { id: 'evt_2', source: 'ci', type: 'ci_event', payload: {}, identity: {}, dedupKey: 'd2', ts: '2026-10-08T10:01:00.000Z' },
          error: 'router failed',
        },
      ],
    })
    const container = await renderSettings()

    const journal = container.querySelector('[data-testid="events-journal-list"]')!
    expect(journal.textContent).toContain('queue')
    expect(journal.textContent).toContain('session busy')
    expect(journal.textContent).toContain('telegram')
    expect(journal.textContent).toContain('ci')
    expect(journal.textContent).toContain('router failed')
    expect(mocks.getEventJournal).toHaveBeenCalledWith(50)
  })

  it('пустое состояние журнала', async () => {
    const container = await renderSettings()
    expect(container.textContent).toContain('The event journal is empty')
  })

  it('рендерит список правил маршрутизации из API', async () => {
    mocks.getEventRoutes.mockResolvedValue({
      rules: [
        rule('r1', {
          name: 'urgent telegram',
          priority: 10,
          match: { source: 'telegram', keywords: ['urgent', 'asap'] },
          target: { mode: 'bound', sessionId: 'sess-42' },
        }),
      ],
    })
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="events-routes-list"]')).not.toBeNull()
    const row = container.querySelector('[data-testid="events-route-r1"]')!
    expect(row.textContent).toContain('urgent telegram')
    expect(row.textContent).toContain('10')
    expect(row.textContent).toContain('Source: telegram')
    expect(row.textContent).toContain('urgent, asap')
    expect(row.textContent).toContain('bound: sess-42')
  })

  it('пустое состояние, когда правил нет', async () => {
    const container = await renderSettings()
    expect(container.textContent).toContain('No routing rules configured')
  })

  it('создание правила шлёт match/target и опускает пустые поля', async () => {
    const container = await renderSettings()

    await act(async () => {
      ;(container.querySelector('[data-testid="events-route-add"]') as HTMLButtonElement).click()
    })

    const name = container.querySelector('[data-testid="events-route-name"]') as HTMLInputElement
    const priority = container.querySelector(
      '[data-testid="events-route-priority"]',
    ) as HTMLInputElement
    const source = container.querySelector('[data-testid="events-route-source"]') as HTMLInputElement
    const chatKey = container.querySelector(
      '[data-testid="events-route-chat-key"]',
    ) as HTMLInputElement
    const keywords = container.querySelector(
      '[data-testid="events-route-keywords"]',
    ) as HTMLTextAreaElement
    const session = container.querySelector(
      '[data-testid="events-route-session"]',
    ) as HTMLInputElement
    await act(async () => {
      setInputValue(name, '  urgent  ')
      setInputValue(priority, '5')
      setInputValue(source, ' webhook ')
      setInputValue(chatKey, 'chat:webhook:1')
      setInputValue(keywords, 'urgent,\nasap\n')
      setInputValue(session, ' sess-9 ')
    })

    await act(async () => {
      ;(container.querySelector('[data-testid="events-route-save"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.createEventRoute).toHaveBeenCalledTimes(1)
    expect(mocks.createEventRoute).toHaveBeenCalledWith({
      name: 'urgent',
      priority: 5,
      enabled: true,
      match: { source: 'webhook', chatKey: 'chat:webhook:1', keywords: ['urgent', 'asap'] },
      target: { mode: 'bound', sessionId: 'sess-9' },
    })
  })

  it('создание без sessionId для bound не вызывает API и показывает ошибку', async () => {
    const container = await renderSettings()
    await act(async () => {
      ;(container.querySelector('[data-testid="events-route-add"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="events-route-save"]') as HTMLButtonElement).click()
    })

    expect(mocks.createEventRoute).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Session ID is required for bound/queue mode')
  })

  it('редактирование правила показывает текущие значения (ephemeral)', async () => {
    mocks.getEventRoutes.mockResolvedValue({
      rules: [
        rule('r1', {
          name: 'ephemeral rule',
          match: { source: 'telegram' },
          target: { mode: 'ephemeral', agentTemplate: 'assistant', project: 'proj-1', ttl: '24h' },
        }),
      ],
    })
    const container = await renderSettings()

    await act(async () => {
      ;(container.querySelector('[data-testid="events-route-edit-r1"]') as HTMLButtonElement).click()
    })

    expect(container.querySelector('[data-testid="events-route-editor"]')).not.toBeNull()
    expect((container.querySelector('[data-testid="events-route-agent"]') as HTMLInputElement).value).toBe(
      'assistant',
    )
    expect((container.querySelector('[data-testid="events-route-project"]') as HTMLInputElement).value).toBe(
      'proj-1',
    )
    expect((container.querySelector('[data-testid="events-route-ttl"]') as HTMLInputElement).value).toBe(
      '24h',
    )
    expect(container.querySelector('[data-testid="events-route-session"]')).toBeNull()
  })

  it('обновление правила передаёт id', async () => {
    mocks.getEventRoutes.mockResolvedValue({
      rules: [rule('r1', { name: 'old', target: { mode: 'bound', sessionId: 'sess-1' } })],
    })
    const container = await renderSettings()

    await act(async () => {
      ;(container.querySelector('[data-testid="events-route-edit-r1"]') as HTMLButtonElement).click()
    })
    const name = container.querySelector('[data-testid="events-route-name"]') as HTMLInputElement
    await act(async () => {
      setInputValue(name, 'renamed')
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="events-route-save"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.createEventRoute).toHaveBeenCalledWith({
      id: 'r1',
      name: 'renamed',
      priority: 0,
      enabled: true,
      match: {},
      target: { mode: 'bound', sessionId: 'sess-1' },
    })
  })

  it('удаление правила подтверждается через confirm и вызывает deleteEventRoute', async () => {
    mocks.getEventRoutes.mockResolvedValue({ rules: [rule('r1', { name: 'dupe' })] })
    const container = await renderSettings()

    await act(async () => {
      ;(container.querySelector('[data-testid="events-route-delete-r1"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteEventRoute).toHaveBeenCalledWith('r1')
  })

  it('отмена подтверждения не удаляет правило', async () => {
    mocks.getEventRoutes.mockResolvedValue({ rules: [rule('r1')] })
    mocks.confirm.mockResolvedValue(false)
    const container = await renderSettings()

    await act(async () => {
      ;(container.querySelector('[data-testid="events-route-delete-r1"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.deleteEventRoute).not.toHaveBeenCalled()
  })

  it('инлайн-тумблер шлёт upsert с id и инвертированным enabled', async () => {
    mocks.getEventRoutes.mockResolvedValue({ rules: [rule('r1', { enabled: true })] })
    const container = await renderSettings()

    const toggle = container.querySelector('[data-testid="events-route-toggle-r1"] button')!
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      ;(toggle as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.createEventRoute).toHaveBeenCalledTimes(1)
    expect(mocks.createEventRoute).toHaveBeenCalledWith({
      id: 'r1',
      priority: 0,
      enabled: false,
      match: {},
      target: { mode: 'bound', sessionId: 'sess-1' },
    })
    // После успеха список перечитывается.
    expect(mocks.getEventRoutes).toHaveBeenCalledTimes(2)
  })

  it('при ошибке переключения показывает тост и не меняет состояние правила', async () => {
    mocks.getEventRoutes.mockResolvedValue({ rules: [rule('r1', { enabled: true })] })
    mocks.createEventRoute.mockRejectedValueOnce(new Error('boom'))
    const container = await renderSettings()

    const toggle = container.querySelector('[data-testid="events-route-toggle-r1"] button')!
    await act(async () => {
      ;(toggle as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.createEventRoute).toHaveBeenCalledTimes(1)
    // Список не перечитывался — состояние осталось прежним (enabled=true).
    expect(mocks.getEventRoutes).toHaveBeenCalledTimes(1)
    const toggleAfter = container.querySelector('[data-testid="events-route-toggle-r1"] button')!
    expect(toggleAfter.getAttribute('aria-checked')).toBe('true')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('boom'),
      }),
    )
  })
})
