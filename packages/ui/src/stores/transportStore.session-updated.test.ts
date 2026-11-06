// Гибрид: грант, выданный на удалённом backend, возвращается в UI событием
// `session.updated` (через мост). Диспетчер обязан применить патч `settings` к
// записи `remote:<id>` — иначе правая панель («Сессионные одобрения») не видит
// правило `permission.rules.execute_shell` и грант выглядит невыданным.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 'remote:s1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { createDispatcher } from './transportStore'
import { useSessionsStore } from './sessionsStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function event(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionsStore.setState({
    sessions: [
      {
        id: 'remote:s1',
        name: 'Удалённая',
        origin: 'remote',
        settings: { permission: { rules: {} } },
      } as never,
    ],
  })
})

describe('transportStore dispatcher: session.updated (гибрид)', () => {
  it('remote:s1 — патч settings.permission.rules попадает в стор (грант виден в UI)', () => {
    dispatch(event('session.updated', 'remote:s1', {
      session_id: 'remote:s1',
      settings: {
        permission: {
          rules: {
            execute_shell: { 'git status *': 'allow' },
          },
        },
      },
    }))

    const session = useSessionsStore.getState().sessions.find((s) => s.id === 'remote:s1')
    expect(session).toBeTruthy()
    const rules = (session!.settings as any).permission.rules
    expect(rules.execute_shell).toEqual({ 'git status *': 'allow' })
  })
})
