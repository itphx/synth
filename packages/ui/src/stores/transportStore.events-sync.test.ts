/**
 * Синхронизация между клиентами: события, которые ядро публикует, а клиент
 * обязан применить к локальному состоянию (`message.updated`,
 * `session.messages.cleared`, `session.messages.merged`, `project.deleted`).
 *
 * Регрессия: уже обработанные события (`message.deleted`, `session.deleted`,
 * `fs.changed`) продолжают работать.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
    // Список проектов пагинирован (ADR-089): стор грузит страницу.
    getProjectsPage: vi.fn().mockResolvedValue({
      projects: [],
      total: 0,
      offset: 0,
      limit: 100,
      next_offset: null,
    }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { createDispatcher } from './transportStore'
import { useChatStore, type MessageData } from './chatStore'
import { useSessionsStore } from './sessionsStore'
import { useProjectsStore } from './projectsStore'
import { useUIStore } from './useUIStore'
import { useFilesStore } from './filesStore'
import { resetChatStore } from './testUtils'
import { synthApi } from '@/lib/api/synthApi'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

const SID = 's1'

function message(id: string, index: number, overrides: Partial<MessageData> = {}): MessageData {
  return {
    index,
    id,
    role: 'user',
    content: id,
    ord: index + 1,
    turn_id: 't1',
    status: 'completed',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function event(type: string, data: Record<string, unknown> = {}, sessionId: string = SID): WSEvent {
  return { type, session_id: sessionId, data }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  useSessionsStore.setState({ sessions: [], loading: false, error: null })
  useProjectsStore.setState({ projects: [], loading: false, error: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('transportStore dispatcher: message.updated', () => {
  beforeEach(() => {
    useChatStore.getState().setMessages(SID, [message('m-1', 0), message('m-2', 1)])
  })

  it('патчит pinned по id', () => {
    dispatch(event('message.updated', { message_id: 'm-1', pinned: true }))

    const messages = useChatStore.getState().messagesBySession[SID] ?? []
    expect(messages.find((m) => m.id === 'm-1')?.pinned).toBe(true)
    // Другие поля/сообщения не тронуты.
    expect(messages.find((m) => m.id === 'm-2')?.pinned).toBe(false)
    expect(messages).toHaveLength(2)
  })

  it('патчит disabled по id и не ломает live-части streaming-сообщения', () => {
    useChatStore.getState().setMessages(SID, [
      message('m-live', 0, { status: 'streaming' }),
      message('m-2', 1),
    ])
    useChatStore.getState().upsertPart(SID, 'm-live', 'msg:text:0', {
      id: 'msg:text:0',
      type: 'text',
      text: 'печатается',
    })

    dispatch(event('message.updated', { message_id: 'm-live', disabled: true }))

    const live = (useChatStore.getState().messagesBySession[SID] ?? []).find((m) => m.id === 'm-live')
    expect(live?.disabled).toBe(true)
    expect(live?.status).toBe('streaming')
    expect(useChatStore.getState().partsBySession[SID]?.['m-live']?.['msg:text:0']?.text).toBe('печатается')
  })

  it('неизвестный id — лента не меняется (сообщение не создаётся)', () => {
    const before = useChatStore.getState().messagesBySession[SID]

    dispatch(event('message.updated', { message_id: 'm-unknown', pinned: true }))

    expect(useChatStore.getState().messagesBySession[SID]).toBe(before)
  })

  it('отсутствующий/пустой message_id ничего не ломает', () => {
    const before = useChatStore.getState().messagesBySession[SID]

    dispatch(event('message.updated', {}))
    dispatch(event('message.updated', { message_id: '', pinned: true }))

    expect(useChatStore.getState().messagesBySession[SID]).toBe(before)
  })
})

describe('transportStore dispatcher: session.messages.cleared', () => {
  it('заменяет ленту авторитетным снимком, чистит части удалённых и очередь', async () => {
    useChatStore.getState().setMessages(SID, [
      message('m-1', 0),
      message('m-pinned', 1, { pinned: true }),
    ])
    useChatStore.getState().upsertPart(SID, 'm-1', 'msg:text:0', {
      id: 'msg:text:0',
      type: 'text',
      text: 'удалённое',
    })
    useChatStore.getState().upsertPart(SID, 'm-pinned', 'msg:text:0', {
      id: 'msg:text:0',
      type: 'text',
      text: 'закреплённое',
    })
    // Активный ход: `mergeServerMessages` сохранил бы сообщения хода, а очистка
    // должна заменить ленту целиком.
    useChatStore.setState((s) => ({
      turnBySession: {
        ...s.turnBySession,
        [SID]: { turnId: 't1', status: 'streaming' } as never,
      },
      pendingBySession: {
        ...s.pendingBySession,
        [SID]: [{ id: 'pending-1', content: 'в очереди' } as never],
      },
    }))
    useChatStore.getState().setQueueCounts(SID, 1, 0)

    vi.mocked(synthApi.getSessionMessages).mockResolvedValueOnce({
      messages: [message('m-pinned', 0, { pinned: true })],
    } as never)

    dispatch(event('session.messages.cleared', { session_id: SID }))

    await vi.waitFor(() => {
      expect(useChatStore.getState().messagesBySession[SID]?.map((m) => m.id)).toEqual(['m-pinned'])
    })
    expect(synthApi.getSessionMessages).toHaveBeenCalledWith(SID, { limit: 200 })
    expect(useChatStore.getState().partsBySession[SID]?.['m-1']).toBeUndefined()
    expect(useChatStore.getState().partsBySession[SID]?.['m-pinned']?.['msg:text:0']?.text).toBe('закреплённое')
    expect(useChatStore.getState().pendingBySession[SID]).toBeUndefined()
    expect(useChatStore.getState().queueBySession[SID]).toMatchObject({ pendingCount: 0, steerCount: 0 })
  })

  it('ошибка загрузки снимка не ломает состояние', async () => {
    useChatStore.getState().setMessages(SID, [message('m-1', 0)])
    vi.mocked(synthApi.getSessionMessages).mockRejectedValueOnce(new Error('network'))

    dispatch(event('session.messages.cleared', { session_id: SID }))

    await vi.waitFor(() => expect(synthApi.getSessionMessages).toHaveBeenCalled())
    expect(useChatStore.getState().messagesBySession[SID]?.map((m) => m.id)).toEqual(['m-1'])
  })
})

describe('transportStore dispatcher: session.messages.merged', () => {
  it('сливает сообщения из payload, не теряя существующие', () => {
    useChatStore.getState().setMessages(SID, [message('m-1', 0)])

    dispatch(event('session.messages.merged', {
      messages: [message('m-2', 1, { turn_id: 't-merged' })],
      source_session_id: 's-source',
    }))

    const messages = useChatStore.getState().messagesBySession[SID] ?? []
    expect(messages.map((m) => m.id).sort()).toEqual(['m-1', 'm-2'])
  })

  it('без messages в payload перечитывает полную историю', async () => {
    useChatStore.getState().setMessages(SID, [message('m-1', 0)])
    vi.mocked(synthApi.getSessionMessages).mockResolvedValueOnce({
      messages: [message('m-1', 0), message('m-2', 1)],
    } as never)

    dispatch(event('session.messages.merged', { source_session_id: 's-source' }))

    await vi.waitFor(() => {
      expect(useChatStore.getState().messagesBySession[SID]?.map((m) => m.id).sort()).toEqual(['m-1', 'm-2'])
    })
    expect(synthApi.getSessionMessages).toHaveBeenCalledWith(SID, { limit: 200 })
  })
})

describe('transportStore dispatcher: project.deleted', () => {
  it('убирает проект, его сессии, чат-вкладки и состояние лент', () => {
    useProjectsStore.setState({
      projects: [{ id: 'p1' }, { id: 'p2' }] as never,
      loading: false,
      error: null,
    })
    useSessionsStore.setState({
      sessions: [
        { id: 's1', project_id: 'p1' },
        { id: 's2', project_id: 'p2' },
        { id: 's3', project_id: 'p1' },
        { id: 's4', project_id: null },
      ] as never,
      loading: false,
      error: null,
    })
    useChatStore.getState().setMessages('s1', [message('m-1', 0)])
    useChatStore.getState().setMessages('s2', [message('m-2', 0)])

    const closeTab = vi.spyOn(useUIStore.getState(), 'closeTab').mockImplementation(() => {})
    const clearSession = vi.spyOn(useChatStore.getState(), 'clearSession')

    dispatch(event('project.deleted', { project_id: 'p1' }))

    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual(['p2'])
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['s2', 's4'])
    expect(closeTab).toHaveBeenCalledWith('chat-s1')
    expect(closeTab).toHaveBeenCalledWith('chat-s3')
    expect(closeTab).not.toHaveBeenCalledWith('chat-s2')
    expect(clearSession).toHaveBeenCalledWith('s1')
    expect(clearSession).toHaveBeenCalledWith('s3')
    expect(clearSession).not.toHaveBeenCalledWith('s2')
    expect(useChatStore.getState().messagesBySession['s1']).toBeUndefined()
    expect(useChatStore.getState().messagesBySession['s2']).toHaveLength(1)
  })

  it('пустой project_id — no-op', () => {
    useProjectsStore.setState({ projects: [{ id: 'p1' }] as never, loading: false, error: null })

    dispatch(event('project.deleted', {}))

    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual(['p1'])
  })
})

describe('transportStore dispatcher: регрессия существующих событий', () => {
  it('message.deleted по-прежнему убирает сообщение', () => {
    useChatStore.getState().setMessages(SID, [message('m-1', 0), message('m-2', 1)])

    dispatch(event('message.deleted', { message_id: 'm-1' }))

    expect(useChatStore.getState().messagesBySession[SID]?.map((m) => m.id)).toEqual(['m-2'])
  })

  it('session.deleted по-прежнему убирает сессию и закрывает чат-вкладку', () => {
    useSessionsStore.setState({
      sessions: [{ id: 's1', project_id: 'p1' }, { id: 's2', project_id: 'p1' }] as never,
      loading: false,
      error: null,
    })
    const closeTab = vi.spyOn(useUIStore.getState(), 'closeTab').mockImplementation(() => {})

    dispatch(event('session.deleted', { session_id: 's1' }))

    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['s2'])
    expect(closeTab).toHaveBeenCalledWith('chat-s1')
  })

  it('fs.changed по-прежнему инвалидирует дерево проекта', () => {
    vi.useFakeTimers()
    try {
      useSessionsStore.setState({
        sessions: [{ id: 's1', project_id: 'p1' }] as never,
        loading: false,
        error: null,
      })
      const scheduleRefresh = vi.spyOn(useFilesStore.getState(), 'scheduleRefresh').mockImplementation(() => {})

      dispatch(event('fs.changed', { project_id: 'p1', scope: 'file', paths: ['a.txt'] }))

      expect(scheduleRefresh).toHaveBeenCalledWith('p1', expect.objectContaining({ scope: 'file', paths: ['a.txt'] }))
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
