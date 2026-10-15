import { describe, it, expect, beforeEach, vi } from 'vitest'

const { INFO } = vi.hoisted(() => ({
  INFO: {
    session_id: 's1',
    enabled: true,
    cap: { chars: 20000, source: 'dynamic' as const, contextWindow: 128000 },
    files: [
      {
        path: './AGENTS.md',
        kind: 'chain',
        chars: 120,
        truncated: false,
        status: 'loaded',
        scan: { scanned: true, blocked: false, suspicious: false, matches: [] },
      },
    ],
    diagnostics: [],
  },
}))

// Моки внешних зависимостей диспетчера: сетевых вызовов и toast быть не должно.
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 'parent', messages: [] }),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
    getSessionInstructions: vi.fn().mockResolvedValue(INFO),
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useInstructionsStore } from './instructionsStore'
import { synthApi } from '@/lib/api/synthApi'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

describe('transportStore dispatcher: context.instructions_loaded (ADR-069 §9.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useInstructionsStore.setState({
      infoBySession: {},
      loadingBySession: {},
      errorBySession: {},
    })
  })

  it('событие перезагружает снимок инструкций сессии в instructionsStore', async () => {
    dispatch(makeEvent('context.instructions_loaded', 's1', { source: 'initial' }))

    await vi.waitFor(() => {
      expect(useInstructionsStore.getState().infoBySession['s1']).toEqual(INFO)
    })
    expect(synthApi.getSessionInstructions).toHaveBeenCalledWith('s1')
  })
})
