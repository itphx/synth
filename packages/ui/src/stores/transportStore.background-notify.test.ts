import { describe, it, expect, beforeEach, vi } from 'vitest'

// Моки внешних зависимостей диспетчера: сетевых вызовов и toast быть не должно.
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', project_id: 'p1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
    listProcesses: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useProcessesStore } from './processesStore'
import { useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { notifyMessage } from '@/hooks/useNotification'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()
const notify = vi.mocked(notifyMessage)

function makeEvent(type: string, sessionId: string | undefined, data: Record<string, unknown>): WSEvent {
  return {
    type,
    ...(sessionId ? { session_id: sessionId } : {}),
    data,
  } as WSEvent
}

/** Текст последнего уведомления. */
function lastText(): string {
  const calls = notify.mock.calls
  return String(calls[calls.length - 1]?.[0]?.text ?? '')
}

describe('transportStore: уведомления о фоновых прогонах (ADR-111/ADR-113)', () => {
  beforeEach(() => {
    notify.mockClear()
    useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
    useProcessesStore.setState({
      byId: {},
      order: [],
      logs: {},
      pendingIds: [],
      error: null,
    })
  })

  it('process.started → уведомление «запущен» (info)', () => {
    dispatch(makeEvent('process.started', 's1', {
      background_run_id: 'bgr_p1',
      process_id: 'proc_1',
      session_id: 's1',
      command: 'npm run build',
    }))

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: 'Background process started: npm run build',
      type: 'info',
      category: 'system',
      sessionId: 's1',
    })
  })

  it('child.started → уведомление «саб-агент запущен» (info)', () => {
    dispatch(makeEvent('child.started', 's1', {
      background_run_id: 'bgr_c1',
      child_session_id: 'child-1',
      parent_session_id: 's1',
      description: 'собрать отчёт',
      agent_role: 'explore',
    }))

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: 'Background subagent started: собрать отчёт',
      type: 'info',
      category: 'system',
      sessionId: 's1',
    })
    // Прогон-саб-агент в реестре — в статусе «идёт» (не терминальный).
    expect(useProcessesStore.getState().byId['bgr_c1']!.status).toBe('running')
  })

  it('process.exited (completed) → уведомление «завершён» (success)', () => {
    dispatch(makeEvent('process.started', 's1', {
      background_run_id: 'bgr_p2',
      session_id: 's1',
      command: 'npm test',
    }))
    notify.mockClear()

    dispatch(makeEvent('process.exited', 's1', {
      background_run_id: 'bgr_p2',
      session_id: 's1',
      state: 'completed',
      exit_code: 0,
    }))

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: 'Background process completed: npm test',
      type: 'success',
      category: 'system',
    })
  })

  it('process.exited (failed) → уведомление «ошибка» (error)', () => {
    dispatch(makeEvent('process.exited', 's1', {
      background_run_id: 'bgr_p3',
      session_id: 's1',
      state: 'failed',
      command: 'npm test',
    }))

    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: 'Background process failed: npm test',
      type: 'error',
    })
  })

  it('process.stopped → уведомление «остановлен» (warning)', () => {
    dispatch(makeEvent('process.stopped', 's1', {
      background_run_id: 'bgr_p4',
      session_id: 's1',
      command: 'sleep 100',
    }))

    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: 'Background process stopped: sleep 100',
      type: 'warning',
    })
  })

  it('child.completed / child.failed / child.cancelled → свои тексты и типы', () => {
    dispatch(makeEvent('child.completed', 's1', {
      background_run_id: 'bgr_c2',
      child_session_id: 'child-2',
      parent_session_id: 's1',
      description: 'аудит',
    }))
    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: 'Background subagent completed: аудит',
      type: 'success',
    })

    notify.mockClear()
    dispatch(makeEvent('child.failed', 's1', {
      background_run_id: 'bgr_c3',
      child_session_id: 'child-3',
      parent_session_id: 's1',
      description: 'аудит',
    }))
    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: 'Background subagent failed: аудит',
      type: 'error',
    })

    notify.mockClear()
    dispatch(makeEvent('child.cancelled', 's1', {
      background_run_id: 'bgr_c4',
      child_session_id: 'child-4',
      parent_session_id: 's1',
      description: 'аудит',
    }))
    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: 'Background subagent stopped: аудит',
      type: 'warning',
    })
  })

  it('дедупа нет: повтор того же события по тому же прогону даёт ещё одно уведомление', () => {
    const event = makeEvent('process.started', 's1', {
      background_run_id: 'bgr_p5',
      session_id: 's1',
      command: 'npm run build',
    })
    dispatch(event)
    dispatch(event)
    dispatch(event)

    expect(notify).toHaveBeenCalledTimes(3)
  })

  it('два разных прогона дают два уведомления', () => {
    dispatch(makeEvent('process.started', 's1', {
      background_run_id: 'bgr_p6',
      session_id: 's1',
      command: 'npm run build',
    }))
    dispatch(makeEvent('process.started', 's1', {
      background_run_id: 'bgr_p7',
      session_id: 's1',
      command: 'npm run lint',
    }))

    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('чужие события реестра уведомлений не порождают', () => {
    dispatch(makeEvent('stream.chunk', 's1', { content: 'привет' }))
    expect(notify).not.toHaveBeenCalled()
  })

  it('имя прогона берётся из реестра, если в payload его нет', () => {
    dispatch(makeEvent('process.started', 's1', {
      background_run_id: 'bgr_p8',
      session_id: 's1',
      command: 'npm run build',
    }))
    notify.mockClear()

    dispatch(makeEvent('process.exited', 's1', {
      background_run_id: 'bgr_p8',
      session_id: 's1',
      state: 'completed',
    }))

    expect(lastText()).toBe('Background process completed: npm run build')
  })
})
