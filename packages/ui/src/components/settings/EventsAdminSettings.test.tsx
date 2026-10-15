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
  listEventBindings: vi.fn(),
  upsertEventBinding: vi.fn(),
  deleteEventBinding: vi.fn(),
  getEventBindingKeys: vi.fn(),
  createEventBindingKey: vi.fn(),
  updateEventBindingKey: vi.fn(),
  revokeEventBindingKey: vi.fn(),
  deleteEventBindingKey: vi.fn(),
  getEventJournal: vi.fn(),
  getEventRoutes: vi.fn(),
  createEventRoute: vi.fn(),
  deleteEventRoute: vi.fn(),
  getProjects: vi.fn(),
  getSessions: vi.fn(),
  getAgents: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
  canManage: vi.fn(() => true),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))
vi.mock('@/hooks/useCanManageEvents', () => ({
  useCanManageEvents: () => mocks.canManage(),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EventsAdminSettings } from './EventsAdminSettings'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import type { EventBinding, EventRouteRule } from '@itphx/synth-shared'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PROJECT = { id: 'p1', name: 'Project One', origin: 'local' }
const SESSION = { id: 's1', name: 'Session One', engine: 'synth', settings: {}, project_id: 'p1' }
const AGENT = { id: 'assistant', display_name: 'Assistant', enabled: true }

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

const clickTestId = async (container: HTMLElement, testId: string) => {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  expect(el, `элемент ${testId}`).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/** Открывает Base UI select и кликает опцию по подписи (опции рендерятся в portal). */
async function selectOption(trigger: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    trigger.click()
  })
  const allOptions = [...document.body.querySelectorAll('[role="option"]')]
  const option = allOptions.find((o) => o.textContent?.trim().startsWith(label)) as HTMLElement | undefined
  expect(option, `option "${label}"`).toBeTruthy()
  await act(async () => {
    option!.click()
  })
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
        <TooltipProvider>
          <EventsAdminSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.canManage.mockReturnValue(true)
  mocks.listEventBindings.mockResolvedValue({ bindings: [] })
  mocks.upsertEventBinding.mockImplementation(async (input: unknown) => ({
    id: 'new',
    ...(input as object),
  }))
  mocks.deleteEventBinding.mockResolvedValue(undefined)
  mocks.getEventBindingKeys.mockResolvedValue({ keys: [] })
  mocks.createEventBindingKey.mockResolvedValue({
    id: 'k1',
    bindingId: 'b1',
    label: 'desc',
    description: 'desc',
    createdBy: 'admin',
    createdAt: '2026-10-08T10:00:00.000Z',
    prefix: 'eak_abc',
    key: 'eak_secret_value',
  })
  mocks.updateEventBindingKey.mockResolvedValue({
    id: 'k1',
    bindingId: 'b1',
    label: 'desc',
    createdBy: 'admin',
    createdAt: '2026-10-08T10:00:00.000Z',
    prefix: 'eak_abc',
  })
  mocks.revokeEventBindingKey.mockResolvedValue({
    id: 'k1',
    bindingId: 'b1',
    label: 'desc',
    createdBy: 'admin',
    createdAt: '2026-10-08T10:00:00.000Z',
    prefix: 'eak_abc',
    revokedAt: '2026-10-08T11:00:00.000Z',
  })
  mocks.deleteEventBindingKey.mockResolvedValue(undefined)
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
  mocks.getProjects.mockResolvedValue([PROJECT])
  mocks.getSessions.mockResolvedValue([SESSION])
  mocks.getAgents.mockResolvedValue({ agents: [AGENT], default_agent: 'assistant' })
  mocks.confirm.mockResolvedValue(true)

  useProjectsStore.setState({ projects: [PROJECT] as never })
  useAgentsStore.setState({ agents: [AGENT] as never })
  useSessionsStore.setState({ sessions: [SESSION] as never })
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

describe('EventsAdminSettings — биндинги и журнал (ADR-089)', () => {
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

    await clickTestId(container, 'events-binding-add')

    const source = container.querySelector('[data-testid="events-binding-source"]') as HTMLInputElement
    const chatKey = container.querySelector('[data-testid="events-binding-chat-key"]') as HTMLInputElement
    await act(async () => {
      setInputValue(source, '  webhook  ')
      setInputValue(chatKey, 'chat:webhook:1')
    })

    await clickTestId(container, 'events-binding-save')
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
    await clickTestId(container, 'events-binding-add')
    await clickTestId(container, 'events-binding-save')

    expect(mocks.upsertEventBinding).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Source is required')
  })

  it('выбор проекта и сессии через селекты уходит в upsert (id в подписи)', async () => {
    const container = await renderSettings()
    await clickTestId(container, 'events-binding-add')

    const source = container.querySelector('[data-testid="events-binding-source"]') as HTMLInputElement
    await act(async () => {
      setInputValue(source, 'telegram')
    })

    const projectTrigger = container.querySelector('[data-testid="events-binding-project"]') as HTMLElement
    await selectOption(projectTrigger, 'Project One')
    expect(container.querySelector('[data-testid="events-binding-project-id"]')!.textContent).toBe('p1')

    const sessionTrigger = container.querySelector('[data-testid="events-binding-session"]') as HTMLElement
    await selectOption(sessionTrigger, 'Session One')
    expect(container.querySelector('[data-testid="events-binding-session-id"]')!.textContent).toBe('s1')

    await clickTestId(container, 'events-binding-save')
    await act(async () => {})

    expect(mocks.upsertEventBinding).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'telegram', project: 'p1', sessionId: 's1' }),
    )
    // Сессии грузятся по выбранному проекту.
    expect(mocks.getSessions).toHaveBeenCalledWith('p1')
  })

  it('поля формы показывают иконку-подсказку (tooltip)', async () => {
    const container = await renderSettings()
    await clickTestId(container, 'events-binding-add')

    const tooltips = container.querySelectorAll('[data-testid="settings-field-tooltip"]')
    expect(tooltips.length).toBeGreaterThan(0)
    expect(tooltips[0].getAttribute('aria-label')).toBeTruthy()
  })

  it('кнопка «+» у селекта сессии открывает диалог создания сессии', async () => {
    const container = await renderSettings()
    await clickTestId(container, 'events-binding-add')

    await clickTestId(container, 'events-binding-session-create')
    expect(document.querySelector('[data-testid="session-create-dialog"]')).not.toBeNull()
  })

  it('редактирование открывает форму с текущими значениями', async () => {
    mocks.listEventBindings.mockResolvedValue({
      bindings: [binding('b1', { chatKey: 'chat:telegram:9', mode: 'ephemeral', agentTemplate: 'assistant' })],
    })
    const container = await renderSettings()

    await clickTestId(container, 'events-binding-edit-b1')

    expect(container.querySelector('[data-testid="events-binding-editor"]')).not.toBeNull()
    expect((container.querySelector('[data-testid="events-binding-chat-key"]') as HTMLInputElement).value).toBe(
      'chat:telegram:9',
    )
    expect(container.querySelector('[data-testid="events-binding-agent-id"]')!.textContent).toBe('assistant')
  })

  it('удаление подтверждается через confirm и вызывает deleteEventBinding', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1', { chatKey: 'chat:telegram:9' })] })
    const container = await renderSettings()

    await clickTestId(container, 'events-binding-delete-b1')
    await act(async () => {})

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteEventBinding).toHaveBeenCalledWith('b1')
  })

  it('отмена подтверждения не удаляет биндинг', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    mocks.confirm.mockResolvedValue(false)
    const container = await renderSettings()

    await clickTestId(container, 'events-binding-delete-b1')
    await act(async () => {})

    expect(mocks.deleteEventBinding).not.toHaveBeenCalled()
  })
})

describe('EventsAdminSettings — API-ключи привязки (ADR-089)', () => {
  const keyMeta = (overrides: Record<string, unknown> = {}) => ({
    id: 'k1',
    bindingId: 'b1',
    label: 'Ingest key',
    description: 'Ingest from telegram',
    createdBy: 'admin',
    createdAt: '2026-10-08T10:00:00.000Z',
    prefix: 'eak_abc',
    ...overrides,
  })

  it('секция ключей видна сразу и грузит список', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    mocks.getEventBindingKeys.mockResolvedValue({ keys: [keyMeta()] })
    const container = await renderSettings()

    expect(mocks.getEventBindingKeys).toHaveBeenCalledWith('b1')
    const keyRow = container.querySelector('[data-testid="events-binding-key-k1"]')!
    expect(keyRow.textContent).toContain('Ingest key')
    expect(keyRow.textContent).toContain('eak_abc')
    expect(keyRow.textContent).toContain('Ingest from telegram')
    expect(keyRow.textContent).toContain('Active')
    // Тумблера-иконки больше нет — секция первоклассная.
    expect(container.querySelector('[data-testid="events-binding-keys-toggle-b1"]')).toBeNull()
  })

  it('создаёт несколько ключей, оба остаются в списке', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    mocks.getEventBindingKeys
      .mockResolvedValueOnce({ keys: [] })
      .mockResolvedValueOnce({ keys: [keyMeta({ id: 'k1', label: 'Key one', prefix: 'eak_one' })] })
      .mockResolvedValueOnce({
        keys: [
          keyMeta({ id: 'k1', label: 'Key one', prefix: 'eak_one' }),
          keyMeta({ id: 'k2', label: 'Key two', prefix: 'eak_two' }),
        ],
      })
    mocks.createEventBindingKey
      .mockResolvedValueOnce({
        id: 'k1',
        bindingId: 'b1',
        label: 'Key one',
        createdBy: 'admin',
        createdAt: '2026-10-08T10:00:00.000Z',
        prefix: 'eak_one',
        key: 'eak_secret_one',
      })
      .mockResolvedValueOnce({
        id: 'k2',
        bindingId: 'b1',
        label: 'Key two',
        createdBy: 'admin',
        createdAt: '2026-10-08T10:05:00.000Z',
        prefix: 'eak_two',
        key: 'eak_secret_two',
      })
    const container = await renderSettings()

    // Первый ключ.
    await clickTestId(container, 'events-binding-key-add-b1')
    await act(async () => {
      setInputValue(
        container.querySelector('[data-testid="events-binding-key-label-b1"]') as HTMLInputElement,
        'Key one',
      )
    })
    await clickTestId(container, 'events-binding-key-save-b1')
    await act(async () => {})

    // Второй ключ.
    await clickTestId(container, 'events-binding-key-add-b1')
    await act(async () => {
      setInputValue(
        container.querySelector('[data-testid="events-binding-key-label-b1"]') as HTMLInputElement,
        'Key two',
      )
    })
    await clickTestId(container, 'events-binding-key-save-b1')
    await act(async () => {})

    expect(mocks.createEventBindingKey).toHaveBeenCalledTimes(2)
    const list = container.querySelector('[data-testid="events-binding-keys-list-b1"]')!
    expect(list.textContent).toContain('Key one')
    expect(list.textContent).toContain('Key two')
  })

  it('метка обязательна, описание необязательно и идёт после метки', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    const container = await renderSettings()

    await clickTestId(container, 'events-binding-key-add-b1')

    const label = container.querySelector('[data-testid="events-binding-key-label-b1"]') as HTMLInputElement
    const description = container.querySelector(
      '[data-testid="events-binding-key-description-b1"]',
    ) as HTMLInputElement
    // Описание ниже метки.
    expect(label.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Метка помечена как обязательная (native `required`), описание — нет.
    expect(label.required).toBe(true)
    expect(description.required).toBe(false)
  })

  it('поля формы ключа показывают иконку-подсказку (tooltip)', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    const container = await renderSettings()

    await clickTestId(container, 'events-binding-key-add-b1')

    const form = container.querySelector('[data-testid="events-binding-key-form-b1"]')!
    const tooltips = form.querySelectorAll('[data-testid="settings-field-tooltip"]')
    expect(tooltips.length).toBeGreaterThan(0)
    expect(tooltips[0].getAttribute('aria-label')).toBeTruthy()
  })

  it('редактирует метку/описание/срок/лимит ключа через PATCH', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    mocks.getEventBindingKeys.mockResolvedValue({
      keys: [keyMeta({ id: 'k1', label: 'Ingest key', description: 'old description' })],
    })
    const container = await renderSettings()
    await act(async () => {})

    await clickTestId(container, 'events-binding-key-edit-k1')

    await act(async () => {
      setInputValue(
        container.querySelector('[data-testid="events-binding-key-edit-label-k1"]') as HTMLInputElement,
        'Renamed key',
      )
      setInputValue(
        container.querySelector('[data-testid="events-binding-key-edit-description-k1"]') as HTMLInputElement,
        'new description',
      )
      setInputValue(
        container.querySelector('[data-testid="events-binding-key-edit-rate-k1"]') as HTMLInputElement,
        '5',
      )
    })

    await clickTestId(container, 'events-binding-key-edit-save-k1')
    await act(async () => {})

    expect(mocks.updateEventBindingKey).toHaveBeenCalledTimes(1)
    expect(mocks.updateEventBindingKey).toHaveBeenCalledWith('b1', 'k1', {
      label: 'Renamed key',
      description: 'new description',
      expiresAt: null,
      rateLimitPerMinute: 5,
    })
  })

  it('создаёт ключ по метке, один раз показывает секрет и curl', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    const container = await renderSettings()

    await clickTestId(container, 'events-binding-key-add-b1')

    const label = container.querySelector(
      '[data-testid="events-binding-key-label-b1"]',
    ) as HTMLInputElement
    const description = container.querySelector(
      '[data-testid="events-binding-key-description-b1"]',
    ) as HTMLInputElement
    await act(async () => {
      setInputValue(label, 'Ingest key')
      setInputValue(description, 'Ingest key description')
    })

    await clickTestId(container, 'events-binding-key-save-b1')
    await act(async () => {})

    expect(mocks.createEventBindingKey).toHaveBeenCalledWith('b1', {
      label: 'Ingest key',
      description: 'Ingest key description',
      expiresAt: undefined,
      rateLimitPerMinute: undefined,
    })

    const secret = container.querySelector('[data-testid="events-binding-key-secret-b1"]')!
    expect(secret.textContent).toContain('eak_secret_value')

    const curl = container.querySelector('[data-testid="events-binding-key-curl-b1"]')!
    expect(curl.textContent).toContain('/api/v2/events')
    expect(curl.textContent).toContain('Authorization: Bearer eak_secret_value')
  })

  it('до создания ключа curl содержит плейсхолдер', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    const container = await renderSettings()

    const curl = container.querySelector('[data-testid="events-binding-key-curl-b1"]')!
    expect(curl.textContent).toContain('Authorization: Bearer <key>')
  })

  it('создание ключа без метки не вызывает API', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    const container = await renderSettings()

    await clickTestId(container, 'events-binding-key-add-b1')
    await clickTestId(container, 'events-binding-key-save-b1')

    expect(mocks.createEventBindingKey).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Label is required')
  })

  it('409 по метке показывается под полем метки, не общим текстом', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    mocks.createEventBindingKey.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { code: 'CONFLICT' }),
    )
    const container = await renderSettings()

    await clickTestId(container, 'events-binding-key-add-b1')
    const label = container.querySelector(
      '[data-testid="events-binding-key-label-b1"]',
    ) as HTMLInputElement
    await act(async () => {
      setInputValue(label, 'dup')
    })
    await clickTestId(container, 'events-binding-key-save-b1')
    await act(async () => {})

    expect(container.textContent).toContain('already used')
    expect(container.textContent).not.toContain('conflict')
  })

  it('удаление ключа подтверждается через confirm', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    mocks.getEventBindingKeys.mockResolvedValue({ keys: [keyMeta()] })
    const container = await renderSettings()
    await act(async () => {})

    await clickTestId(container, 'events-binding-key-delete-k1')
    await act(async () => {})

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteEventBindingKey).toHaveBeenCalledWith('b1', 'k1')
  })

  it('отзыв ключа подтверждается и вызывает revokeEventBindingKey', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    mocks.getEventBindingKeys.mockResolvedValue({ keys: [keyMeta()] })
    const container = await renderSettings()
    await act(async () => {})

    await clickTestId(container, 'events-binding-key-revoke-k1')
    await act(async () => {})

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.revokeEventBindingKey).toHaveBeenCalledWith('b1', 'k1')
  })

  it('отозванный ключ показывает бейдж и не предлагает отзыв', async () => {
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    mocks.getEventBindingKeys.mockResolvedValue({
      keys: [keyMeta({ revokedAt: '2026-10-08T11:00:00.000Z' })],
    })
    const container = await renderSettings()
    await act(async () => {})

    const keyRow = container.querySelector('[data-testid="events-binding-key-k1"]')!
    expect(keyRow.textContent).toContain('Revoked')
    expect(container.querySelector('[data-testid="events-binding-key-revoke-k1"]')).toBeNull()
  })
})

describe('EventsAdminSettings — журнал (ADR-089)', () => {
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

  it('кнопка перехода открывает журнал в «Логи и аудит»', async () => {
    const container = await renderSettings()
    await clickTestId(container, 'events-journal-open-logs')

    // useUIStore: открыт LogsModal на категории events.
    const ui = (await import('@/stores/useUIStore')).useUIStore.getState()
    expect(ui.isLogsDialogOpen).toBe(true)
    expect(ui.logsPage).toBe('events')
    ui.setLogsDialogOpen(false)
    ui.setLogsPage('core')
  })
})

describe('EventsAdminSettings — правила маршрутизации (ADR-089)', () => {
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
    mocks.getSessions.mockResolvedValue([{ id: 'sess-9', name: 'Session 9', engine: 'synth', settings: {} }])
    const container = await renderSettings()

    await clickTestId(container, 'events-route-add')

    const name = container.querySelector('[data-testid="events-route-name"]') as HTMLInputElement
    const priority = container.querySelector('[data-testid="events-route-priority"]') as HTMLInputElement
    const source = container.querySelector('[data-testid="events-route-source"]') as HTMLInputElement
    const chatKey = container.querySelector('[data-testid="events-route-chat-key"]') as HTMLInputElement
    const keywords = container.querySelector('[data-testid="events-route-keywords"]') as HTMLTextAreaElement
    await act(async () => {
      setInputValue(name, '  urgent  ')
      setInputValue(priority, '5')
      setInputValue(source, ' webhook ')
      setInputValue(chatKey, 'chat:webhook:1')
      setInputValue(keywords, 'urgent,\nasap\n')
    })

    const sessionTrigger = container.querySelector('[data-testid="events-route-session"]') as HTMLElement
    await selectOption(sessionTrigger, 'Session 9')

    await clickTestId(container, 'events-route-save')
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
    await clickTestId(container, 'events-route-add')
    await clickTestId(container, 'events-route-save')

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

    await clickTestId(container, 'events-route-edit-r1')

    expect(container.querySelector('[data-testid="events-route-editor"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="events-route-agent-id"]')!.textContent).toBe('assistant')
    expect(container.querySelector('[data-testid="events-route-project-id"]')!.textContent).toBe('proj-1')
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

    await clickTestId(container, 'events-route-edit-r1')
    const name = container.querySelector('[data-testid="events-route-name"]') as HTMLInputElement
    await act(async () => {
      setInputValue(name, 'renamed')
    })
    await clickTestId(container, 'events-route-save')
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

    await clickTestId(container, 'events-route-delete-r1')
    await act(async () => {})

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteEventRoute).toHaveBeenCalledWith('r1')
  })

  it('отмена подтверждения не удаляет правило', async () => {
    mocks.getEventRoutes.mockResolvedValue({ rules: [rule('r1')] })
    mocks.confirm.mockResolvedValue(false)
    const container = await renderSettings()

    await clickTestId(container, 'events-route-delete-r1')
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

describe('EventsAdminSettings — read-only для USER/AUDITOR (ADR-089)', () => {
  beforeEach(() => {
    mocks.canManage.mockReturnValue(false)
    mocks.listEventBindings.mockResolvedValue({ bindings: [binding('b1')] })
    mocks.getEventRoutes.mockResolvedValue({ rules: [rule('r1')] })
    mocks.getEventJournal.mockResolvedValue({
      entries: [
        {
          ts: '2026-10-08T10:00:00.000Z',
          event: { id: 'evt_1', source: 'telegram', type: 'message', payload: {}, identity: {}, dedupKey: 'd1', ts: '2026-10-08T10:00:00.000Z' },
          decision: { kind: 'bound', sessionId: 's1' },
        },
      ],
    })
  })

  it('не показывает кнопки создания/изменения/удаления и ключей', async () => {
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="events-binding-add"]')).toBeNull()
    expect(container.querySelector('[data-testid="events-binding-edit-b1"]')).toBeNull()
    expect(container.querySelector('[data-testid="events-binding-delete-b1"]')).toBeNull()
    expect(container.querySelector('[data-testid="events-binding-keys-toggle-b1"]')).toBeNull()
    expect(container.querySelector('[data-testid="events-route-add"]')).toBeNull()
    expect(container.querySelector('[data-testid="events-route-edit-r1"]')).toBeNull()
    expect(container.querySelector('[data-testid="events-route-delete-r1"]')).toBeNull()
    expect(container.querySelector('[data-testid="events-route-toggle-r1"]')).toBeNull()
    expect(mocks.getEventBindingKeys).not.toHaveBeenCalled()
  })

  it('просмотр списков и журнала остаётся доступен', async () => {
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="events-bindings-list"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="events-routes-list"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="events-journal-list"]')).not.toBeNull()
  })
})
