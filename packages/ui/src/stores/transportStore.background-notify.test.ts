import { describe, it, expect, beforeEach, vi } from 'vitest'

// Моки внешних зависимостей диспетчера: сетевых вызовов и toast быть не должно.
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
    listProcesses: vi.fn().mockResolvedValue([]),
    listProcessesWithBlocking: vi.fn().mockResolvedValue({ runs: [], blocking: [] }),
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
import { synthApi } from '@/lib/api/synthApi'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()
const notify = vi.mocked(notifyMessage)
const listWithBlocking = vi.mocked(synthApi.listProcessesWithBlocking)

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
    listWithBlocking.mockClear()
    useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
    useProcessesStore.setState({
      byId: {},
      order: [],
      blocking: [],
      blockingLoaded: false,
      blockingScope: null,
      blockingScopeKey: null,
      blockingKnownIds: [],
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
      // Завершение фонового прогона — «просто тост»: ни unread, ни цвета в дереве.
      requiresAction: false,
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

  it('process.started с detached:true → запись создаётся, тоста «запущен» нет', () => {
    dispatch(makeEvent('process.started', 's1', {
      background_run_id: 'bgr_d1',
      process_id: 'proc_d1',
      session_id: 's1',
      command: 'npm run dev',
      detached: true,
    }))

    // ADR-111 §detach: перевод в фон подтверждается своим тостом, дубль
    // «Фоновый процесс запущен» не показывается.
    expect(notify).not.toHaveBeenCalled()
    const run = useProcessesStore.getState().byId['bgr_d1']!
    expect(run.kind).toBe('process')
    expect(run.status).toBe('running')
    expect(run.command).toBe('npm run dev')
  })

  it('process.started без detached — тост «запущен» остаётся', () => {
    dispatch(makeEvent('process.started', 's1', {
      background_run_id: 'bgr_d2',
      session_id: 's1',
      command: 'npm run build',
    }))

    expect(notify).toHaveBeenCalledTimes(1)
    expect(lastText()).toBe('Background process started: npm run build')
  })

  // ADR-111 §detach: авто-перевод блокирующих прогонов в фон при steer.
  it('background.auto_detached → тост с количеством и рефреш блокирующих', async () => {
    useProcessesStore.setState({
      blockingLoaded: true,
      blockingScope: { sessionId: 's1' },
      blockingScopeKey: 'session:s1',
      blockingKnownIds: [],
      blocking: [],
    })
    listWithBlocking.mockResolvedValueOnce({
      runs: [],
      blocking: [{ id: 'blk_bg', kind: 'process', sessionId: 's1' }],
    })

    dispatch(makeEvent('background.auto_detached', 's1', {
      session_id: 's1',
      detached: [
        { id: 'blk_1', kind: 'process' },
        { id: 'blk_2', kind: 'subagent', title: 'аудит' },
      ],
    }))

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: 'Blocking runs moved to background automatically: 2',
      type: 'info',
      category: 'system',
      sessionId: 's1',
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(listWithBlocking).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(useProcessesStore.getState().blocking.map((run) => run.id)).toEqual(['blk_bg'])
  })

  it('background.auto_detached без загруженного стора не дёргает сеть', () => {
    dispatch(makeEvent('background.auto_detached', 's1', {
      session_id: 's1',
      detached: [{ id: 'blk_1', kind: 'process' }],
    }))

    expect(notify).toHaveBeenCalledTimes(1)
    expect(listWithBlocking).not.toHaveBeenCalled()
  })
})
