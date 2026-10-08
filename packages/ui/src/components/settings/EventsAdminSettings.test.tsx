import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  listEventBindings: vi.fn(),
  upsertEventBinding: vi.fn(),
  deleteEventBinding: vi.fn(),
  getEventJournal: vi.fn(),
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
import type { EventBinding } from '@itphx/synth-shared'

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
})
