import { describe, it, expect, beforeEach, vi } from 'vitest'

// persist (zustand) захватывает localStorage при импорте стора, а Node/vitest без
// --localstorage-file его не даёт — ставим заглушку до импорта useUIStore.
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

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', project_id: 'p1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
    // ADR-118 §8: перед подключением стор спрашивает возможности инстанса.
    getInstanceCapabilities: vi.fn().mockResolvedValue({
      messageModel: 2, eventSeq: true, replay: true, version: 'test',
    }),
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
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

/**
 * Транспорт (WS) — заглушка: ответ на подтверждение обычно уходит WS-кадром,
 * но для **восстановленного** ожидания — только HTTP.
 */
const transportMocks = vi.hoisted(() => {
  interface Callbacks {
    onEvent?: (event: unknown) => void
    onConnect?: () => void
    onDisconnect?: (reason: string) => void
    onTransportSwitch?: (transport: string) => void
    onBackendReady?: () => void
  }

  class MockClient {
    kind: 'ws' | 'sse' | 'disconnected' = 'disconnected'
    callbacks: Callbacks
    connect = vi.fn((mode: 'ws' | 'sse') => {
      this.kind = mode
    })
    disconnect = vi.fn(() => {
      this.callbacks.onDisconnect?.('manual')
    })
    getTransport = vi.fn(() => this.kind)
    sendMessage = vi.fn().mockResolvedValue(undefined)
    cancel = vi.fn()
    sendPermissionReply = vi.fn()
    sendPermissionHold = vi.fn()
    isBackendReady = vi.fn(() => true)

    constructor(callbacks: Callbacks) {
      this.callbacks = callbacks
      instances.push(this)
    }
  }

  const instances: MockClient[] = []
  return { instances, MockClient }
})

vi.mock('@/lib/api/transport', () => ({ TransportClient: transportMocks.MockClient }))
vi.mock('@/lib/api/sessions', () => ({
  sessionsApi: {
    permissionReply: vi.fn().mockResolvedValue({ status: 'ok', action: 'deny' }),
  },
}))

import { createDispatcher, useTransportStore } from './transportStore'
import { usePermissionStore } from './permissionStore'
import { useSessionsStore } from './sessionsStore'
import { sessionsApi } from '@/lib/api/sessions'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()
const permissionReply = vi.mocked(sessionsApi.permissionReply)

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

const DIFF = '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+uno'

describe('transportStore dispatcher: permission.asked (превью изменений)', () => {
  beforeEach(() => {
    usePermissionStore.setState({ requestsBySession: {} })
    vi.clearAllMocks()
  })

  it('превью из события попадает в запрос подтверждения', () => {
    dispatch(makeEvent('permission.asked', 's1', {
      approval_id: 'approval_1',
      session_id: 's1',
      call_id: 'call_1',
      tool: 'write_file',
      arguments: { file_path: 'a.txt', content: 'uno' },
      reason: 'правило file.* → ask',
      ask_timeout_ms: 30_000,
      preview: { files: [{ path: 'a.txt', diff: DIFF, additions: 1, deletions: 1 }] },
    }))

    const requests = usePermissionStore.getState().requestsBySession['s1']!
    expect(requests).toHaveLength(1)
    expect(requests[0]!.preview).toEqual({
      files: [{ path: 'a.txt', diff: DIFF, additions: 1, deletions: 1 }],
    })
  })

  it('без превью поле не появляется (поведение прежнее)', () => {
    dispatch(makeEvent('permission.asked', 's1', {
      approval_id: 'approval_1',
      session_id: 's1',
      tool: 'write_file',
      arguments: { file_path: 'a.txt' },
      reason: 'ask',
    }))

    const requests = usePermissionStore.getState().requestsBySession['s1']!
    expect(requests[0]!.preview).toBeUndefined()
  })

  it('битое превью игнорируется — запрос подтверждения остаётся рабочим', () => {
    dispatch(makeEvent('permission.asked', 's1', {
      approval_id: 'approval_1',
      session_id: 's1',
      tool: 'write_file',
      arguments: { file_path: 'a.txt' },
      reason: 'ask',
      preview: { files: 'не массив' },
    }))

    const requests = usePermissionStore.getState().requestsBySession['s1']!
    expect(requests).toHaveLength(1)
    expect(requests[0]!.preview).toBeUndefined()
  })
})

describe('transportStore dispatcher: permission.asked (trigger — структурная причина)', () => {
  beforeEach(() => {
    usePermissionStore.setState({ requestsBySession: {} })
    vi.clearAllMocks()
  })

  it('trigger из payload\'а попадает в запрос подтверждения', () => {
    dispatch(makeEvent('permission.asked', 's1', {
      approval_id: 'approval_1',
      session_id: 's1',
      tool: 'execute_shell',
      arguments: { command: 'cat ~/.ssh/config' },
      reason: 'LLM-текст причины',
      trigger: {
        messageId: 'ask-protected-path',
        params: { path: '/home/rdv/.ssh/config' },
        matchedRule: 'shell-policy.approve',
        askKind: 'protected',
      },
    }))

    const requests = usePermissionStore.getState().requestsBySession['s1']!
    expect(requests[0]!.trigger).toEqual({
      messageId: 'ask-protected-path',
      params: { path: '/home/rdv/.ssh/config' },
      matchedRule: 'shell-policy.approve',
      askKind: 'protected',
    })
  })

  it('trigger.params не путается с аргументами тула (payload.params)', () => {
    dispatch(makeEvent('permission.asked', 's1', {
      approval_id: 'approval_1',
      session_id: 's1',
      tool: 'execute_shell',
      // Аргументы тула — в `params` верхнего уровня.
      params: { command: 'cat ~/.ssh/config' },
      trigger: {
        messageId: 'ask-protected-path',
        params: { path: '/home/rdv/.ssh/config' },
      },
    }))

    const requests = usePermissionStore.getState().requestsBySession['s1']!
    expect(requests[0]!.params).toEqual({ command: 'cat ~/.ssh/config' })
    expect(requests[0]!.trigger?.params).toEqual({ path: '/home/rdv/.ssh/config' })
  })

  it('битый trigger игнорируется — запрос подтверждения остаётся рабочим', () => {
    dispatch(makeEvent('permission.asked', 's1', {
      approval_id: 'approval_1',
      session_id: 's1',
      tool: 'write_file',
      arguments: { file_path: 'a.txt' },
      reason: 'ask',
      trigger: { messageId: 'ask-protected-path', askKind: 'неизвестный' },
    }))

    const requests = usePermissionStore.getState().requestsBySession['s1']!
    expect(requests[0]!.trigger?.messageId).toBe('ask-protected-path')
    expect(requests[0]!.trigger?.askKind).toBeUndefined()
  })
})

/**
 * Ответ на подтверждение снимает одно висящее ожидание — DTO-счётчик
 * `pending_approvals` в сторе сессий тоже должен уменьшиться: список сессий
 * заново не запрашивается, иначе метка «ждёт подтверждения прав» остаётся
 * навсегда (живой стор пуст, счётчик — прежний).
 */
describe('transportStore dispatcher: permission.replied (счётчик ожиданий)', () => {
  beforeEach(() => {
    usePermissionStore.setState({ requestsBySession: {} })
    useSessionsStore.setState({ sessions: [] })
    vi.clearAllMocks()
  })

  it('ответ уменьшает счётчик pending_approvals у сессии', () => {
    useSessionsStore.setState({
      sessions: [{ id: 's1', pending_approvals: 2 } as never],
    })

    dispatch(makeEvent('permission.replied', 's1', { approval_id: 'approval_1' }))

    expect(useSessionsStore.getState().sessions[0]!.pending_approvals).toBe(1)
  })

  it('счётчик не уходит в минус', () => {
    useSessionsStore.setState({
      sessions: [{ id: 's1', pending_approvals: 0 } as never],
    })

    dispatch(makeEvent('permission.replied', 's1', { approval_id: 'approval_1' }))

    expect(useSessionsStore.getState().sessions[0]!.pending_approvals).toBe(0)
  })

  it('ответ снимает и живую карточку, и DTO-счётчик', () => {
    usePermissionStore.getState().addRequest('s1', {
      approvalId: 'approval_1',
      toolName: 'execute_shell',
      params: {},
      reason: 'ask',
      askedAt: new Date().toISOString(),
      timeoutMs: 0,
    })
    useSessionsStore.setState({
      sessions: [{ id: 's1', pending_approvals: 1 } as never],
    })

    dispatch(makeEvent('permission.replied', 's1', { approval_id: 'approval_1' }))

    expect(usePermissionStore.getState().requestsBySession['s1']).toBeUndefined()
    expect(useSessionsStore.getState().sessions[0]!.pending_approvals).toBe(0)
  })

  it('ответ по чужой сессии счётчик не трогает', () => {
    useSessionsStore.setState({
      sessions: [{ id: 's1', pending_approvals: 1 } as never],
    })

    dispatch(makeEvent('permission.replied', 's2', { approval_id: 'approval_1' }))

    expect(useSessionsStore.getState().sessions[0]!.pending_approvals).toBe(1)
  })
})

/**
 * ADR-029: ответ на **восстановленное** ожидание (после рестарта инстанса)
 * уходит по HTTP, а не WS-кадром.
 *
 * Живой реестр подтверждений живёт в памяти процесса: после рестарта он
 * пуст, у WS-кадра `permission_reply` нет привязки к восстановленному id.
 * Поэтому только такой ответ идёт через `POST /sessions/:id/permissions/:id`.
 */
describe('transportStore.sendPermissionReply: восстановленное ожидание — HTTP', () => {
  beforeEach(() => {
    usePermissionStore.setState({ requestsBySession: {} })
    useSessionsStore.setState({ sessions: [] })
    transportMocks.instances.length = 0
    useTransportStore.getState().disconnect()
    vi.clearAllMocks()
    permissionReply.mockResolvedValue({ status: 'ok', action: 'deny' })
  })

  /** Подключить WS и дождаться готовности транспорта. */
  async function connectWs(): Promise<InstanceType<typeof transportMocks.MockClient>> {
    useTransportStore.getState().connect('ws')
    const client = transportMocks.instances[transportMocks.instances.length - 1]!
    await vi.waitFor(() => expect(client.getTransport()).toBe('ws'))
    client.callbacks.onBackendReady?.()
    return client
  }

  /** Запрос подтверждения в сторе (живой или восстановленный). */
  function addRequest(approvalId: string, restored: boolean): void {
    usePermissionStore.getState().addRequest('s1', {
      approvalId,
      toolName: 'execute_shell',
      params: { command: 'ls' },
      reason: 'правило shell.* → ask',
      askedAt: new Date().toISOString(),
      timeoutMs: 0,
      ...(restored ? { restored: true } : {}),
    })
  }

  it('восстановленное ожидание: ответ уходит HTTP, WS-кадр не отправляется', async () => {
    const client = await connectWs()
    addRequest('approval_restored', true)

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_restored', true, true)

    expect(sent).toBe(true)
    expect(permissionReply).toHaveBeenCalledWith('s1', 'approval_restored', { action: 'allow', once: true })
    expect(client.sendPermissionReply).not.toHaveBeenCalled()
  })

  it('обычное ожидание: ответ по-прежнему уходит WS-кадром', async () => {
    const client = await connectWs()
    addRequest('approval_live', false)

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_live', true, false)

    expect(sent).toBe(true)
    expect(client.sendPermissionReply).toHaveBeenCalledWith('s1', 'approval_live', true, false)
    expect(permissionReply).not.toHaveBeenCalled()
  })

  it('восстановленное ожидание без записи в сторе — обычный путь (WS)', async () => {
    // Записи в сторе нет (например, карточка уже снята) — признака
    // «восстановленное» нет, поведение прежнее.
    const client = await connectWs()

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_unknown', true, true)

    expect(sent).toBe(true)
    expect(client.sendPermissionReply).toHaveBeenCalledWith('s1', 'approval_unknown', true, true)
    expect(permissionReply).not.toHaveBeenCalled()
  })
})
