/**
 * Пакетное удаление сообщений из шапки (`Header.handleBulkDelete`).
 *
 * Регресс: защита от гонки «снимок старше записи» (`ord > maxOrd` снимка)
 * сохраняла удалённое **самое новое** сообщение — после `batchMessages('delete')`
 * снимок уже без него, и `applyHistoryPage` возвращал его в ленту. Удаление
 * адресуется явно по id, до перечитывания истории.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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
  notify: vi.fn(),
  confirm: vi.fn(),
  getSessionMessages: vi.fn(),
  batchMessages: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSessionMessages: mocks.getSessionMessages,
    batchMessages: mocks.batchMessages,
    clearSession: vi.fn(),
    summarizeSession: vi.fn(),
    downloadFile: vi.fn(() => ''),
    mergeMessages: vi.fn(),
    addSessionReference: vi.fn(),
  },
}))

vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))
vi.mock('@/hooks/useDevice', () => ({
  useDevice: () => ({ deviceType: 'desktop', isTouch: false }),
}))
vi.mock('../auth/QuickSettingsPopup', () => ({ QuickSettingsPopup: () => null }))
vi.mock('./AnalyticsButton', () => ({ AnalyticsButton: () => null }))
vi.mock('./NotificationPopup', () => ({ NotificationPopup: () => null }))
vi.mock('./GlobalTransportIndicator', () => ({ GlobalTransportIndicator: () => null }))
vi.mock('./HybridStatusIndicator', () => ({ HybridStatusIndicator: () => null }))
vi.mock('./PwaInstallButton', () => ({ PwaInstallButton: () => null }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { Header } from './Header'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { useChatStore, type MessageData } from '@/stores/chatStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'
const roots: Array<{ root: Root; container: HTMLElement }> = []

function message(id: string, ord: number, content: string): MessageData {
  return {
    id,
    index: ord - 1,
    seq: ord,
    ord,
    role: ord % 2 === 0 ? 'assistant' : 'user',
    content,
    status: 'completed',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-11-01T17:00:00.000Z',
  }
}

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function renderHeader(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <Header onSettingsClick={() => {}} />
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

async function clickBulkDelete(container: HTMLElement): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>('button[title="Удалить"]')
  expect(button).not.toBeNull()
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

function seed(messages: MessageData[], selected: string[]): void {
  useChatStore.setState({
    messagesBySession: { [SESSION]: messages },
    selectionBySession: { [SESSION]: { mode: true, ids: new Set(selected) } },
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.confirm.mockResolvedValue(true)
  mocks.batchMessages.mockResolvedValue({ results: [] })
  mocks.getSessionMessages.mockResolvedValue({ messages: [], session_id: SESSION, has_more: false })

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: SESSION } }],
    rightPanelTab: 'context',
    mobileRightOpen: false,
  })
  useSessionsStore.setState({
    sessions: [{ id: SESSION, name: 'S', project_id: 'p1', settings: { model: 'mm' } }],
  } as never)
  useProjectsStore.setState({ projects: [] } as never)
  useProvidersStore.setState({
    models: [{ id: 'mm', name: 'mm', context_window: 200_000 }],
    selectedModelName: null,
  } as never)
  useAuthStore.setState({ user: { id: 'u1', username: 'owner', roles: [] } } as never)
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
})

describe('Header — пакетное удаление', () => {
  it('удаление самого нового сообщения убирает его, хотя снимок без него имеет меньший maxOrd', async () => {
    const first = message('m-1', 1, 'первое')
    const second = message('m-2', 2, 'второе')
    const newest = message('m-3', 3, 'самое новое')
    seed([first, second, newest], ['m-3'])
    // Снимок после DELETE: самого нового сообщения уже нет, maxOrd = 2.
    mocks.getSessionMessages.mockResolvedValueOnce({ messages: [first, second], session_id: SESSION })

    const container = await renderHeader()
    await clickBulkDelete(container)

    expect(mocks.batchMessages).toHaveBeenCalledWith(SESSION, 'delete', ['m-3'])
    expect(useChatStore.getState().messagesBySession[SESSION]?.map((m) => m.id)).toEqual([
      'm-1',
      'm-2',
    ])
  })

  it('удаление среднего сообщения по-прежнему работает', async () => {
    const first = message('m-1', 1, 'первое')
    const middle = message('m-2', 2, 'среднее')
    const last = message('m-3', 3, 'последнее')
    seed([first, middle, last], ['m-2'])
    mocks.getSessionMessages.mockResolvedValueOnce({ messages: [first, last], session_id: SESSION })

    const container = await renderHeader()
    await clickBulkDelete(container)

    expect(mocks.batchMessages).toHaveBeenCalledWith(SESSION, 'delete', ['m-2'])
    expect(useChatStore.getState().messagesBySession[SESSION]?.map((m) => m.id)).toEqual([
      'm-1',
      'm-3',
    ])
  })
})
