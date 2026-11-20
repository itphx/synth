// Матрица состояний бейджа сессии (`sessionBadgeState`): цвет названия и точка
// статуса в левом дереве. Тесты фиксируют **порядок приоритетов** — именно он
// решает, что увидит человек, когда одновременно есть и ошибка, и остановка, и
// подтверждение прав.

import { describe, it, expect } from 'vitest'
import {
  sessionBadgeState,
  type SessionBadgeInput,
  type SessionBadgeState,
} from './sessionBadgeState'

type BadgeSession = SessionBadgeInput['session']
type BadgeLive = SessionBadgeInput['live']

/** Исход последнего хода с фиксированным временем (детерминированный ack-тест). */
const TURN_AT = '2026-01-01T12:00:00.000Z'
const TURN_MS = Date.parse(TURN_AT)

function makeSession(overrides: Partial<BadgeSession> = {}): BadgeSession {
  return {
    id: 'sess-1',
    parent_id: null,
    todos: [],
    status: { blocked: null },
    pending_approvals: 0,
    activity: { type: 'idle' },
    ...overrides,
  }
}

function makeLive(overrides: Partial<BadgeLive> = {}): BadgeLive {
  return {
    streaming: false,
    queuePending: 0,
    queueStalled: false,
    hasOpenQuestion: false,
    approvalRequests: 0,
    ...overrides,
  }
}

function state(
  session: BadgeSession,
  live: BadgeLive = makeLive(),
  ackedAt?: number | null,
): SessionBadgeState {
  return sessionBadgeState({ session, live, ...(ackedAt !== undefined ? { ackedAt } : {}) })
}

describe('sessionBadgeState: приоритеты требуют действия', () => {
  it('подтверждение прав важнее вопроса, остановки очереди и ошибки', () => {
    const session = makeSession({
      pending_approvals: 2,
      status: {
        blocked: null,
        queue_stopped: true,
        last_turn: { outcome: 'error', reason: 'provider_error', at: TURN_AT },
      },
    })
    const live = makeLive({ approvalRequests: 1, hasOpenQuestion: true, queueStalled: true })
    expect(state(session, live)).toEqual({
      labelTone: 'caution',
      dot: 'approval',
      ariaKey: 'leftPanel.approvalNeeded',
    })
  })

  it('счётчик подтверждений из DTO работает без живого стора (после перезагрузки страницы)', () => {
    const session = makeSession({ pending_approvals: 1 })
    expect(state(session)).toEqual({
      labelTone: 'caution',
      dot: 'approval',
      ariaKey: 'leftPanel.approvalNeeded',
    })
  })

  it('вопрос агента — тоже «требуется действие» и важнее остановки очереди и ошибки', () => {
    const session = makeSession({
      status: {
        blocked: null,
        queue_stopped: true,
        last_turn: { outcome: 'error', at: TURN_AT },
      },
    })
    const live = makeLive({ hasOpenQuestion: true })
    expect(state(session, live)).toEqual({
      labelTone: 'caution',
      dot: 'approval',
      ariaKey: 'leftPanel.approvalNeeded',
    })
  })

  it('queue_stopped из DTO важнее ошибки последнего хода', () => {
    const session = makeSession({
      status: {
        blocked: null,
        queue_stopped: true,
        last_turn: { outcome: 'error', at: TURN_AT },
      },
    })
    expect(state(session)).toEqual({
      labelTone: 'caution',
      dot: 'stalled',
      ariaKey: 'leftPanel.attentionNeeded',
    })
  })

  it('живой stall очереди даёт ту же точку «работа стоит»', () => {
    expect(state(makeSession(), makeLive({ queueStalled: true }))).toEqual({
      labelTone: 'caution',
      dot: 'stalled',
      ariaKey: 'leftPanel.attentionNeeded',
    })
  })
})

describe('sessionBadgeState: ошибка последнего хода', () => {
  it('непросмотренная ошибка при простое — красное название без точки', () => {
    const session = makeSession({
      status: { blocked: null, last_turn: { outcome: 'error', reason: 'provider_error', at: TURN_AT } },
    })
    expect(state(session)).toEqual({
      labelTone: 'error',
      dot: null,
      ariaKey: 'leftPanel.executionFailed',
    })
  })

  it('просмотренная ошибка (ackedAt позже last_turn.at) цвета не даёт', () => {
    const session = makeSession({
      status: { blocked: null, last_turn: { outcome: 'error', at: TURN_AT } },
    })
    const ackedAt = TURN_MS + 1_000
    expect(state(session, makeLive(), ackedAt)).toEqual({
      labelTone: 'neutral',
      dot: null,
      ariaKey: '',
    })
  })

  it('ackedAt ровно в момент исхода считается «просмотрено» (граница по спецификации: строгое <)', () => {
    // Условие «не просмотрено» — `!ackedAt || ackedAt < at`: равенство уже
    // «просмотрено», цвет не показывается.
    const session = makeSession({
      status: { blocked: null, last_turn: { outcome: 'error', at: TURN_AT } },
    })
    expect(state(session, makeLive(), TURN_MS)).toEqual({ labelTone: 'neutral', dot: null, ariaKey: '' })
  })

  it('ackedAt раньше last_turn.at (просмотр был до исхода) — ошибка красится', () => {
    const session = makeSession({
      status: { blocked: null, last_turn: { outcome: 'error', at: TURN_AT } },
    })
    expect(state(session, makeLive(), TURN_MS - 60_000).labelTone).toBe('error')
  })

  it('ackedAt = 0 (метки нет) трактуется как «не просмотрено»', () => {
    const session = makeSession({
      status: { blocked: null, last_turn: { outcome: 'error', at: TURN_AT } },
    })
    expect(state(session, makeLive(), 0).labelTone).toBe('error')
  })

  it('ошибка при идущем ходе — точка streaming, а не красный', () => {
    const session = makeSession({
      status: { blocked: null, last_turn: { outcome: 'error', reason: 'empty', at: TURN_AT } },
    })
    expect(state(session, makeLive({ streaming: true }))).toEqual({
      labelTone: 'neutral',
      dot: 'streaming',
      ariaKey: 'leftPanel.streaming',
    })
  })

  it('ошибка при activity=busy — тоже не красный (ход идёт по серверному статусу)', () => {
    const session = makeSession({
      status: { blocked: null, last_turn: { outcome: 'error', at: TURN_AT } },
      activity: { type: 'busy', turnId: 'turn-1', streamId: 'stream-1' },
    })
    expect(state(session)).toEqual({
      labelTone: 'neutral',
      dot: 'streaming',
      ariaKey: 'leftPanel.streaming',
    })
  })
})

describe('sessionBadgeState: штатные исходы не красятся', () => {
  for (const outcome of ['limit', 'stopped', 'cancelled'] as const) {
    it(`${outcome} — нейтраль без точки и без подписи`, () => {
      const session = makeSession({
        status: { blocked: null, last_turn: { outcome, reason: 'steps_limit', at: TURN_AT } },
      })
      expect(state(session)).toEqual({ labelTone: 'neutral', dot: null, ariaKey: '' })
    })
  }

  it('пустая сессия (нет last_turn) — нейтраль', () => {
    expect(state(makeSession())).toEqual({ labelTone: 'neutral', dot: null, ariaKey: '' })
  })

  it('last_turn: null (legacy-сессия) — нейтраль', () => {
    const session = makeSession({ status: { blocked: null, last_turn: null } })
    expect(state(session)).toEqual({ labelTone: 'neutral', dot: null, ariaKey: '' })
  })

  it('отсутствующий status (частичный payload `session.created`) не роняет модель', () => {
    // Пайплайн публикует `session.created` с минимальным набором полей
    // (`id`/`owner_id`/`user_id`/`project_id`/`name`), и `transportStore` кладёт
    // его в список как есть. Рендер дерева на такой сессии падал с
    // `Cannot read properties of undefined (reading 'last_turn')`.
    const partial = { id: 's1', name: 'new' } as unknown as BadgeSession
    expect(sessionBadgeState({ session: partial, live: makeLive() })).toEqual({
      labelTone: 'neutral',
      dot: null,
      ariaKey: '',
    })
  })
})

describe('sessionBadgeState: завершённая работа', () => {
  const completed = (extra: Partial<BadgeSession> = {}): BadgeSession =>
    makeSession({
      status: { blocked: null, last_turn: { outcome: 'completed', at: TURN_AT } },
      ...extra,
    })

  it('idle + completed + нет todo + верхний уровень + не просмотрено — зелёный', () => {
    expect(state(completed())).toEqual({
      labelTone: 'success',
      dot: null,
      ariaKey: 'leftPanel.workCompleted',
    })
  })

  it('todos нет вовсе (null) — условие выполнено', () => {
    expect(state(completed({ todos: null })).labelTone).toBe('success')
  })

  it('все todo закрыты — зелёный', () => {
    const session = completed({
      todos: [
        { id: 't1', content: 'сделать', status: 'completed', priority: 'high' },
        { id: 't2', content: 'отменить', status: 'cancelled', priority: 'low' },
      ],
    })
    expect(state(session).labelTone).toBe('success')
  })

  it('открытый todo (pending/in_progress) — нейтраль, не зелёный', () => {
    for (const status of ['pending', 'in_progress'] as const) {
      const session = completed({
        todos: [{ id: 't1', content: 'работа', status, priority: 'medium' }],
      })
      expect(state(session), `status=${status}`).toEqual({
        labelTone: 'neutral',
        dot: null,
        ariaKey: '',
      })
    }
  })

  it('дочерняя сессия не зеленеет', () => {
    expect(state(completed({ parent_id: 'parent-1' }))).toEqual({
      labelTone: 'neutral',
      dot: null,
      ariaKey: '',
    })
  })

  it('просмотренный успех цвета не даёт', () => {
    expect(state(completed(), makeLive(), TURN_MS + 5_000)).toEqual({
      labelTone: 'neutral',
      dot: null,
      ariaKey: '',
    })
  })

  it('очередь непуста — не зелёный, а точка pending', () => {
    expect(state(completed(), makeLive({ queuePending: 1 }))).toEqual({
      labelTone: 'neutral',
      dot: 'pending',
      ariaKey: 'leftPanel.answerReady',
    })
  })

  it('queue_stopped в DTO — не зелёный, а «работа стоит»', () => {
    const session = makeSession({
      status: { blocked: null, queue_stopped: true, last_turn: { outcome: 'completed', at: TURN_AT } },
    })
    expect(state(session)).toEqual({
      labelTone: 'caution',
      dot: 'stalled',
      ariaKey: 'leftPanel.attentionNeeded',
    })
  })
})

describe('sessionBadgeState: очередь и текущая работа', () => {
  it('непустая очередь при простое — точка pending', () => {
    expect(state(makeSession(), makeLive({ queuePending: 3 }))).toEqual({
      labelTone: 'neutral',
      dot: 'pending',
      ariaKey: 'leftPanel.answerReady',
    })
  })

  it('идёт стрим — точка streaming', () => {
    expect(state(makeSession(), makeLive({ streaming: true }))).toEqual({
      labelTone: 'neutral',
      dot: 'streaming',
      ariaKey: 'leftPanel.streaming',
    })
  })

  it('activity=retry (backoff после сбоя) — тоже идёт работа', () => {
    const session = makeSession({ activity: { type: 'retry', streamId: 'stream-1' } })
    expect(state(session)).toEqual({
      labelTone: 'neutral',
      dot: 'streaming',
      ariaKey: 'leftPanel.streaming',
    })
  })

  it('идёт работа важнее непустой очереди', () => {
    expect(state(makeSession(), makeLive({ streaming: true, queuePending: 2 }))).toEqual({
      labelTone: 'neutral',
      dot: 'streaming',
      ariaKey: 'leftPanel.streaming',
    })
  })
})
