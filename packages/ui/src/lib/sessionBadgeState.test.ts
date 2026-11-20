// Матрица состояний бейджа сессии (`sessionBadgeState`): цвет названия и точка
// статуса в левом дереве. Тесты фиксируют **порядок приоритетов** — именно он
// решает, что увидит человек, когда одновременно есть и ошибка, и остановка, и
// подтверждение прав.

import { describe, it, expect } from 'vitest'
import {
  sessionBadgeState,
  turnKey,
  type SessionBadgeInput,
  type SessionBadgeState,
} from './sessionBadgeState'

type BadgeSession = SessionBadgeInput['session']
type BadgeLive = SessionBadgeInput['live']

/** Исход последнего хода с фиксированным временем (детерминированный ack-тест). */
const TURN_AT = '2026-01-01T12:00:00.000Z'

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
  ackedTurnKey?: string | null,
): SessionBadgeState {
  return sessionBadgeState({
    session,
    live,
    ...(ackedTurnKey !== undefined ? { ackedTurnKey } : {}),
  })
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
      dot: 'attention',
      ariaKey: 'leftPanel.attentionNeeded',
    })
  })

  it('живой stall очереди при непустой очереди — та же точка «работа стоит»', () => {
    expect(state(makeSession(), makeLive({ queueStalled: true, queuePending: 2 }))).toEqual({
      labelTone: 'caution',
      dot: 'attention',
      ariaKey: 'leftPanel.attentionNeeded',
    })
  })

  it('липкий queueStalled при пустой очереди НЕ даёт «работа стоит»', () => {
    // `queueBySession[sid].isStalled` ставится событиями и снимается только
    // отдельными событиями: без событий он «залипает». Источник правды —
    // серверный `status.queue_stopped`; клиентский флаг учитывается только
    // вместе с непустой очередью — иначе он красил и мигал вечно (репорт
    // владельца).
    expect(state(makeSession(), makeLive({ queueStalled: true, queuePending: 0 }))).toEqual({
      labelTone: 'neutral',
      dot: null,
      ariaKey: '',
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

  it('просмотренная ошибка (совпал ключ исхода) цвета не даёт', () => {
    const session = makeSession({
      status: { blocked: null, last_turn: { outcome: 'error', at: TURN_AT } },
    })
    expect(state(session, makeLive(), turnKey({ outcome: 'error', at: TURN_AT }))).toEqual({
      labelTone: 'neutral',
      dot: null,
      ariaKey: '',
    })
  })

  it('другой ключ (новый ход после просмотра) — ошибка снова красная', () => {
    const session = makeSession({
      status: { blocked: null, last_turn: { outcome: 'error', at: TURN_AT } },
    })
    // Просмотрен предыдущий ход («вчерашний») — новый сбой всё равно красится.
    expect(
      state(session, makeLive(), turnKey({ outcome: 'error', at: '2025-12-31T23:59:00.000Z' }))
        .labelTone,
    ).toBe('error')
  })

  it('ошибка при идущем ходе — точка busy-live, а не красный', () => {
    const session = makeSession({
      status: { blocked: null, last_turn: { outcome: 'error', reason: 'empty', at: TURN_AT } },
    })
    expect(state(session, makeLive({ streaming: true }))).toEqual({
      labelTone: 'neutral',
      dot: 'busy-live',
      ariaKey: 'leftPanel.streaming',
    })
  })

  it('ошибка при activity=busy — тоже не красный; точка статичная (busy)', () => {
    // Сервер сообщает о работе, но живого подтверждения нет: точка `busy` без
    // мигания — мигание по залипшему серверному `activity` не имеет конца.
    const session = makeSession({
      status: { blocked: null, last_turn: { outcome: 'error', at: TURN_AT } },
      activity: { type: 'busy', turnId: 'turn-1', streamId: 'stream-1' },
    })
    expect(state(session)).toEqual({
      labelTone: 'neutral',
      dot: 'busy',
      ariaKey: 'leftPanel.streaming',
    })
  })

  it('ошибка + busy + живой ход → busy-live (приоритет 4 сохраняется)', () => {
    const session = makeSession({
      status: { blocked: null, last_turn: { outcome: 'error', at: TURN_AT } },
      activity: { type: 'busy', turnId: 'turn-1', streamId: 'stream-1' },
    })
    expect(state(session, makeLive({ streaming: true }))).toEqual({
      labelTone: 'neutral',
      dot: 'busy-live',
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
    expect(state(completed(), makeLive(), turnKey({ outcome: 'completed', at: TURN_AT }))).toEqual({
      labelTone: 'neutral',
      dot: null,
      ariaKey: '',
    })
  })

  it('новый ход после просмотра — зелёный снова', () => {
    const session = completed()
    expect(
      state(session, makeLive(), turnKey({ outcome: 'completed', at: '2025-12-31T23:59:00.000Z' }))
        .labelTone,
    ).toBe('success')
  })

  it('очередь непуста — не зелёный, а точка pending', () => {
    expect(state(completed(), makeLive({ queuePending: 1 }))).toEqual({
      labelTone: 'neutral',
      dot: 'pending',
      ariaKey: 'leftPanel.answerReady',
    })
  })

  it('queue_stopped в DTO — не зелёный, а «работа стоит» (статично)', () => {
    const session = makeSession({
      status: { blocked: null, queue_stopped: true, last_turn: { outcome: 'completed', at: TURN_AT } },
    })
    expect(state(session)).toEqual({
      labelTone: 'caution',
      dot: 'attention',
      ariaKey: 'leftPanel.attentionNeeded',
    })
  })
})

/**
 * «Просмотрено» сравнивается по **идентичности исхода** (`turnKey`), а не по
 * времени: `Date.now()` клиента расходится с серверным `last_turn.at`, и
 * прежнее сравнение `<` давало ложные срабатывания (а сохранённая метка могла
 * «залипнуть» и навсегда скрыть новую ошибку).
 */
describe('sessionBadgeState: «просмотрено» = совпадение ключа исхода', () => {
  const errorSession = makeSession({
    status: { blocked: null, last_turn: { outcome: 'error', at: TURN_AT } },
  })
  const completedSession = makeSession({
    status: { blocked: null, last_turn: { outcome: 'completed', at: TURN_AT } },
  })

  it('turnKey = «<outcome>|<at>» из серверных данных', () => {
    expect(turnKey({ outcome: 'error', at: TURN_AT })).toBe(`error|${TURN_AT}`)
    expect(turnKey({ outcome: 'completed', at: TURN_AT })).toBe(`completed|${TURN_AT}`)
  })

  it('turnKey: нет исхода / нет outcome / нет at', () => {
    expect(turnKey(null)).toBeNull()
    expect(turnKey(undefined)).toBeNull()
    expect(turnKey({})).toBeNull()
    expect(turnKey({ outcome: '', at: TURN_AT })).toBeNull()
    // Старый бэкенд без `at`: ключ остаётся уникальным хотя бы по исходу.
    expect(turnKey({ outcome: 'completed' })).toBe('completed|')
  })

  it('ключ не зависит от часов клиента: порядок и точность `at` не важны, важно равенство', () => {
    // Тот же `at` в другом формате (тот же момент) — это ДРУГОЙ ключ, и цвет
    // вернётся: сравнение идёт по строке, а не по `Date.parse`. Сервер отдаёт
    // `at` в одном формате, поэтому на практике ключ стабилен.
    expect(turnKey({ outcome: 'error', at: '2026-01-01T12:00:00Z' })).not.toBe(
      turnKey({ outcome: 'error', at: TURN_AT }),
    )
  })

  it('совпал ключ — цвета нет (ошибка и завершение)', () => {
    expect(state(errorSession, makeLive(), `error|${TURN_AT}`)).toEqual({
      labelTone: 'neutral',
      dot: null,
      ariaKey: '',
    })
    expect(state(completedSession, makeLive(), `completed|${TURN_AT}`)).toEqual({
      labelTone: 'neutral',
      dot: null,
      ariaKey: '',
    })
  })

  it('метки нет (null/undefined) — цвет есть', () => {
    expect(state(errorSession, makeLive(), null).labelTone).toBe('error')
    expect(state(errorSession).labelTone).toBe('error')
    expect(state(completedSession, makeLive(), null).labelTone).toBe('success')
    expect(state(completedSession).labelTone).toBe('success')
  })

  it('метка от другого хода — цвет есть (и красный, и зелёный)', () => {
    const previous = `completed|2025-12-31T23:59:00.000Z`
    expect(state(errorSession, makeLive(), previous).labelTone).toBe('error')
    expect(state(completedSession, makeLive(), previous).labelTone).toBe('success')
  })

  it('`outcome` входит в ключ: тот же `at`, другой исход — не совпадение', () => {
    // Иначе просмотренный успех скрыл бы ошибку, записанную в ту же секунду.
    expect(state(errorSession, makeLive(), `completed|${TURN_AT}`).labelTone).toBe('error')
  })

  it('нечитаемый исход (нет outcome) не красится ни при какой метке', () => {
    const broken = makeSession({
      status: { blocked: null, last_turn: { at: TURN_AT } as never },
    })
    expect(state(broken).labelTone).toBe('neutral')
    expect(state(broken, makeLive(), 'error|' + TURN_AT).labelTone).toBe('neutral')
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

  it('идёт стрим — точка busy-live (живое подтверждение работы)', () => {
    expect(state(makeSession(), makeLive({ streaming: true }))).toEqual({
      labelTone: 'neutral',
      dot: 'busy-live',
      ariaKey: 'leftPanel.streaming',
    })
  })

  it('activity=busy без локального хода — статичная точка busy (не мигает)', () => {
    // Ключевой сценарий бага: сервер отдаёт `busy` (мёртвый/зависший ход), а
    // живого подтверждения нет (`live.streaming === false`).
    const session = makeSession({ activity: { type: 'busy', turnId: 'turn-1' } })
    expect(state(session)).toEqual({
      labelTone: 'neutral',
      dot: 'busy',
      ariaKey: 'leftPanel.streaming',
    })
  })

  it('activity=retry (backoff после сбоя) — работа идёт, но без живого подтверждения — busy', () => {
    const session = makeSession({ activity: { type: 'retry', streamId: 'stream-1' } })
    expect(state(session)).toEqual({
      labelTone: 'neutral',
      dot: 'busy',
      ariaKey: 'leftPanel.streaming',
    })
  })

  it('идёт работа важнее непустой очереди', () => {
    expect(state(makeSession(), makeLive({ streaming: true, queuePending: 2 }))).toEqual({
      labelTone: 'neutral',
      dot: 'busy-live',
      ariaKey: 'leftPanel.streaming',
    })
  })
})
