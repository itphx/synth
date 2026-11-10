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

import { createDispatcher } from './transportStore'
import { usePermissionStore } from './permissionStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

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
