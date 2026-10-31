import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  useChatStore,
  selectLiveSubagentUsage,
  selectStreamingMessage,
  compareMessagesByOrd,
  sortMessagesByOrd,
  type MessageData,
  type MessageOrderKey,
  type ActiveTurn,
  type LivePart,
} from './chatStore'
import { resetChatStore } from './testUtils'

beforeEach(() => {
  resetChatStore()
})

/** Минимальный MessageData-каркас (ADR-118: `index` — позиция, `id` — идентичность). */
function msg(partial: Partial<MessageData> & { index: number }): MessageData {
  return {
    role: 'user',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-30T00:00:00Z',
    ...partial,
  }
}

function part(partial: Partial<LivePart> & { id: string }): LivePart {
  return { type: 'text', text: '', ...partial }
}

/** Эквивалент `isTurnActive` из `transportStore` (ADR-118 §1): ход идёт, пока `streaming`. */
function isTurnActive(sessionId: string): boolean {
  const turn = useChatStore.getState().turnBySession[sessionId]
  return !!turn && turn.status === 'streaming'
}

// ---------------------------------------------------------------------------
// 1. upsertMessage — адресация по id, без дублей, сортировка по ord
// ---------------------------------------------------------------------------

describe('chatStore: сортировка сообщений по ord (ADR-118 §2)', () => {
  it('compareMessagesByOrd: по ord, при равенстве — тай-брейк по id', () => {
    const a = { ord: 1, id: 'a', index: 0 }
    const b = { ord: 2, id: 'b', index: 0 }
    expect(compareMessagesByOrd(a, b)).toBeLessThan(0)

    const first = { ord: 5, id: 'a', index: 3 }
    const second = { ord: 5, id: 'b', index: 0 }
    // При равном ord позиционный индекс не решает — решает id.
    expect(compareMessagesByOrd(first, second)).toBeLessThan(0)
    expect(compareMessagesByOrd(second, first)).toBeGreaterThan(0)
  })

  it('compareMessagesByOrd: ord только у одного — по created_at, а не по index', () => {
    // Контрпример из репорта: ответ агента (ord=139) пришёл позже уведомления
    // о фоновом процессе, но `ord` у уведомления ещё не было. Уведомление
    // при этом стоит в серверном массиве дальше ответа (`index` больше) —
    // смешивание `ord` и `index` уводило его под ответ агента.
    const answer = { ord: 139, id: 'answer', index: 5, created_at: '2026-10-30T10:00:05Z' }
    const notice = { ord: null, id: 'notice', index: 9, created_at: '2026-10-30T10:00:00Z' }
    expect(compareMessagesByOrd(notice, answer)).toBeLessThan(0)
    expect(compareMessagesByOrd(answer, notice)).toBeGreaterThan(0)
  })

  it('compareMessagesByOrd: без ord у обоих — по created_at', () => {
    const early = { ord: null, id: 'early', index: 9, created_at: '2026-10-30T10:00:00Z' }
    const late = { ord: null, id: 'late', index: 0, created_at: '2026-10-30T10:00:01Z' }
    expect(compareMessagesByOrd(early, late)).toBeLessThan(0)
    expect(compareMessagesByOrd(late, early)).toBeGreaterThan(0)
  })

  it('sortMessagesByOrd: уведомление о фоновом процессе не уезжает под ответ агента', () => {
    // В БД порядок верный: ord=138 (уведомление) → ord=139 (ответ агента).
    // На клиенте уведомление пришло без `ord` и стоит в серверном массиве
    // дальше ответа — по `index` оно вставало ниже.
    const sorted = sortMessagesByOrd([
      msg({ index: 5, id: 'answer', ord: 139, role: 'assistant', created_at: '2026-10-30T10:00:05Z' }),
      msg({
        index: 9,
        id: 'notice',
        ord: null,
        role: 'user',
        metadata: { type: 'background_run_result' },
        created_at: '2026-10-30T10:00:00Z',
      }),
    ])
    expect(sorted.map((m) => m.id)).toEqual(['notice', 'answer'])
  })

  it('sortMessagesByOrd: живое сообщение (без ord и created_at) — последнее', () => {
    const sorted = sortMessagesByOrd([
      msg({ index: 2, id: 'c', ord: 2 }),
      msg({ index: 0, id: 'a', ord: 0 }),
      msg({ index: 1, id: 'b', ord: 1 }),
    ])
    expect(sorted.map((m) => m.id)).toEqual(['a', 'b', 'c'])

    // Живое сообщение (ещё не материализовано в истории): ни `ord`, ни времени.
    const withDraft = sortMessagesByOrd([
      msg({ index: 1, id: 'draft', ord: null, created_at: '' }),
      msg({ index: 0, id: 'saved', ord: 10 }),
    ])
    expect(withDraft.map((m) => m.id)).toEqual(['saved', 'draft'])
  })

  it('стабильность: при равных ключах — тай-брейк по id, порядок не зависит от вставки', () => {
    const a = msg({ index: 0, id: 'b', ord: 5, created_at: '2026-10-30T10:00:00Z' })
    const b = msg({ index: 1, id: 'a', ord: 5, created_at: '2026-10-30T10:00:00Z' })
    expect(sortMessagesByOrd([a, b]).map((m) => m.id)).toEqual(['a', 'b'])
    expect(sortMessagesByOrd([b, a]).map((m) => m.id)).toEqual(['a', 'b'])

    // Одинаковые `ord` и `created_at` у сообщений без id — порядок по `index`.
    const noIds = sortMessagesByOrd([
      { index: 1, ord: 7, created_at: '2026-10-30T10:00:00Z' } as MessageData,
      { index: 0, ord: 7, created_at: '2026-10-30T10:00:00Z' } as MessageData,
    ])
    expect(noIds.map((m) => m.index)).toEqual([0, 1])
  })

  it('живое сообщение (streaming) — последнее: клиентское время с серверным не смешиваем', () => {
    // Живой ответ агента: `created_at` — **клиентское** время (ensureLiveMessage),
    // у серверного сообщения — серверное. Часы разъезжаются → по времени
    // сравнивать нельзя, живое сообщение всегда последнее.
    const live = msg({
      index: 9,
      id: 'live',
      role: 'assistant',
      status: 'streaming',
      ord: null,
      created_at: '2026-10-30T09:00:00Z',
    })
    const server = msg({
      index: 1,
      id: 'server',
      ord: 12,
      created_at: '2026-10-30T10:00:00Z',
    })

    expect(compareMessagesByOrd(server, live)).toBeLessThan(0)
    expect(compareMessagesByOrd(live, server)).toBeGreaterThan(0)
    expect(sortMessagesByOrd([live, server]).map((m) => m.id)).toEqual(['server', 'live'])
  })

  it('живое сообщение без ord — последнее даже при серверном времени', () => {
    const live = msg({
      index: 3,
      id: 'live',
      role: 'assistant',
      status: 'streaming',
      ord: null,
      created_at: '2026-10-30T12:00:00Z',
    })
    const server = msg({ index: 4, id: 'server', ord: 5, created_at: '2026-10-30T10:00:00Z' })

    expect(sortMessagesByOrd([live, server]).map((m) => m.id)).toEqual(['server', 'live'])
  })

  it('tie-break без index не даёт NaN (порядок остаётся определённым)', () => {
    const a = { ord: 3, id: 'a', created_at: '2026-10-30T10:00:00Z' } as unknown as MessageOrderKey
    const b = { ord: 3, id: 'a', created_at: '2026-10-30T10:00:00Z' } as unknown as MessageOrderKey

    const cmp = compareMessagesByOrd(a, b)
    expect(Number.isNaN(cmp)).toBe(false)
    expect(cmp).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 1b. Вклинивание в ход (ADR-118 §4, `message.enqueued` со `delivery:'steer'`)
// ---------------------------------------------------------------------------

describe('chatStore: сортировка вклиниваний (ADR-118 §4)', () => {
  it('вклинивание (ord не выдан) — после всех записанных', () => {
    const steer = { ord: null, id: 'steer', index: 9, steerPending: true, created_at: '2026-10-30T10:00:00Z' }
    const saved = { ord: 12, id: 'saved', index: 1, created_at: '2026-10-30T09:00:00Z' }

    expect(compareMessagesByOrd(steer, saved)).toBeGreaterThan(0)
    expect(compareMessagesByOrd(saved, steer)).toBeLessThan(0)
  })

  it('вклинивание — перед живым (живое остаётся последним)', () => {
    const steer = { ord: null, id: 'steer', index: 3, steerPending: true, created_at: '2026-10-30T10:00:00Z' }
    const live = { ord: null, id: 'live', index: 4, status: 'streaming' as const, created_at: '2026-10-30T12:00:00Z' }

    expect(compareMessagesByOrd(steer, live)).toBeLessThan(0)
    expect(compareMessagesByOrd(live, steer)).toBeGreaterThan(0)
  })

  it('вклинивания между собой — по времени постановки (created_at)', () => {
    const early = { ord: null, id: 'early', index: 5, steerPending: true, created_at: '2026-10-30T10:00:00Z' }
    const late = { ord: null, id: 'late', index: 0, steerPending: true, created_at: '2026-10-30T10:00:01Z' }

    expect(compareMessagesByOrd(early, late)).toBeLessThan(0)
    expect(compareMessagesByOrd(late, early)).toBeGreaterThan(0)
  })

  it('sortMessagesByOrd: лента — записанные, затем вклинивания, затем живой', () => {
    const sorted = sortMessagesByOrd([
      msg({ index: 2, id: 'live', role: 'assistant', status: 'streaming', ord: null, created_at: '2026-10-30T12:00:00Z' }),
      msg({ index: 3, id: 'steer', ord: null, steerPending: true, created_at: '2026-10-30T10:00:00Z' }),
      msg({ index: 0, id: 'saved', ord: 12, created_at: '2026-10-30T09:00:00Z' }),
    ])
    expect(sorted.map((m) => m.id)).toEqual(['saved', 'steer', 'live'])
  })

  it('вклинивание и оптимистичная реплика (обе без ord) — по времени постановки', () => {
    const steer = { ord: null, id: 'steer', index: 4, steerPending: true, created_at: '2026-10-30T10:00:00Z' }
    const optimistic = { ord: null, id: 'optimistic', index: 5, created_at: '2026-10-30T10:00:05Z' }

    // Вклинивание было раньше оптимистичной реплики — порядок сохраняется.
    expect(compareMessagesByOrd(steer, optimistic)).toBeLessThan(0)
  })

  it('маркер снимается, когда сообщение материализовано (ord выдан)', () => {
    const store = useChatStore.getState()
    store.upsertMessage('s1', msg({ index: 0, id: 'm1', ord: null, steerPending: true, content: 'вклинилось' }))
    expect(useChatStore.getState().messagesBySession['s1']![0]!.steerPending).toBe(true)

    // Серверный снимок с `ord` — сообщение записано в историю.
    store.upsertMessage('s1', msg({ index: 0, id: 'm1', ord: 4, content: 'вклинилось' }))
    expect(useChatStore.getState().messagesBySession['s1']![0]!.steerPending).toBe(false)
  })
})

describe('chatStore: upsertMessage (ADR-118 §7 — адресация по id)', () => {
  it('добавляет сообщение по id и обновляет существующее без дублей', () => {
    const store = useChatStore.getState()
    store.upsertMessage('s1', msg({ index: 0, id: 'm1', content: '' }))
    store.upsertMessage('s1', msg({ index: 0, id: 'm1', content: 'полный ответ', metadata: { k: 1 } }))

    const list = useChatStore.getState().messagesBySession['s1']!
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('m1')
    expect(list[0]!.content).toBe('полный ответ')
    expect(list[0]!.metadata).toEqual({ k: 1 })
  })

  it('повторная публикация не затирает уже известный полный контент и мержит metadata', () => {
    const store = useChatStore.getState()
    store.upsertMessage('s1', msg({ index: 0, id: 'm1', content: 'полный текст', metadata: { stream_id: 'st1' } }))
    // `message.added` может прийти с усечённым контентом и другим набором metadata.
    store.upsertMessage('s1', msg({ index: 0, id: 'm1', content: '', metadata: { commandPrompt: true } }))

    const list = useChatStore.getState().messagesBySession['s1']!
    expect(list).toHaveLength(1)
    expect(list[0]!.content).toBe('полный текст')
    expect(list[0]!.metadata).toEqual({ stream_id: 'st1', commandPrompt: true })
    expect(list[0]!.created_at).toBe('2026-10-30T00:00:00Z')
  })

  it('без id находит существующее по позиционному index', () => {
    const store = useChatStore.getState()
    store.upsertMessage('s1', msg({ index: 3, content: 'первый' }))
    store.upsertMessage('s1', msg({ index: 3, content: 'второй', role: 'assistant' }))

    const list = useChatStore.getState().messagesBySession['s1']!
    expect(list).toHaveLength(1)
    expect(list[0]!.role).toBe('assistant')
  })

  it('новые сообщения встают на место согласно ord, а не порядку вставки', () => {
    const store = useChatStore.getState()
    store.upsertMessage('s1', msg({ index: 0, id: 'c', ord: 2, role: 'assistant' }))
    store.upsertMessage('s1', msg({ index: 1, id: 'a', ord: 0 }))
    store.upsertMessage('s1', msg({ index: 2, id: 'b', ord: 1, role: 'assistant' }))

    expect(useChatStore.getState().messagesBySession['s1']!.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('уведомление о фоновом процессе остаётся выше живого ответа агента', () => {
    const store = useChatStore.getState()
    // Живой ответ агента: `ord` ещё нет (материализуется позже).
    store.upsertMessage(
      's1',
      msg({ index: 138, id: 'answer', role: 'assistant', created_at: '2026-10-30T10:00:05Z' }),
    )
    // Уведомление о завершении фонового прогона (ord=138) пришло раньше ответа,
    // но в массиве встало позже — порядок определяется временем материализации.
    store.upsertMessage(
      's1',
      msg({
        index: 138,
        id: 'notice',
        ord: 138,
        role: 'user',
        metadata: { type: 'background_run_result' },
        created_at: '2026-10-30T10:00:00Z',
      }),
    )

    expect(useChatStore.getState().messagesBySession['s1']!.map((m) => m.id)).toEqual([
      'notice',
      'answer',
    ])
  })
})

// ---------------------------------------------------------------------------
// 2. Части сообщений: upsertPart / appendPartDelta / patchPartData
// ---------------------------------------------------------------------------

describe('chatStore: части сообщений (ADR-118 §4)', () => {
  it('upsertPart — upsert по {messageId, partId}, без дублей', () => {
    const store = useChatStore.getState()
    store.upsertPart('s1', 'm1', 'p1', part({ id: 'p1', text: 'He' }))
    store.upsertPart('s1', 'm1', 'p1', part({ id: 'p1', text: 'Hello' }))

    const parts = useChatStore.getState().partsBySession['s1']!
    expect(Object.keys(parts['m1']!)).toEqual(['p1'])
    expect(parts['m1']!['p1']!.text).toBe('Hello')
  })

  it('appendPartDelta дописывает дельту к существующей части', () => {
    const store = useChatStore.getState()
    store.upsertPart('s1', 'm1', 'p1', part({ id: 'p1', text: 'Hel' }))
    store.appendPartDelta('s1', 'm1', 'p1', 'text', 'lo')
    store.appendPartDelta('s1', 'm1', 'p1', 'text', '!')

    expect(useChatStore.getState().partsBySession['s1']!['m1']!['p1']!.text).toBe('Hello!')
  })

  it('appendPartDelta создаёт часть, если её ещё нет (первая дельта)', () => {
    const store = useChatStore.getState()
    store.appendPartDelta('s1', 'm1', 'p1', 'text', 'первый чанк')

    const p1 = useChatStore.getState().partsBySession['s1']!['m1']!['p1']!
    expect(p1).toMatchObject({ id: 'p1', type: 'text', text: 'первый чанк' })
  })

  it('appendPartDelta с полем raw накапливает поток аргументов вызова', () => {
    const store = useChatStore.getState()
    store.appendPartDelta('s1', 'm1', 'call-1', 'raw', '{"path":')
    store.appendPartDelta('s1', 'm1', 'call-1', 'raw', '"a.ts"}')
    // Пустая дельта — no-op (не пересоздаёт часть).
    store.appendPartDelta('s1', 'm1', 'call-1', 'raw', '')

    const p = useChatStore.getState().partsBySession['s1']!['m1']!['call-1']!
    expect(p.type).toBe('tool_use')
    expect(p.raw).toBe('{"path":"a.ts"}')
    expect(p.text).toBe('')
  })

  it('patchPartData мержит данные части, не теряя накопленный текст', () => {
    const store = useChatStore.getState()
    store.upsertPart(
      's1',
      'm1',
      'call-1',
      part({ id: 'call-1', type: 'tool_use', data: { name: 'read_file', status: 'running' } }),
    )
    store.patchPartData('s1', 'm1', 'call-1', { status: 'done', result: { content: 'ok' } })

    const p = useChatStore.getState().partsBySession['s1']!['m1']!['call-1']!
    expect(p.data).toEqual({ name: 'read_file', status: 'done', result: { content: 'ok' } })
  })

  it('patchPartData по неизвестной части — no-op', () => {
    const store = useChatStore.getState()
    store.patchPartData('s1', 'm1', 'missing', { status: 'done' })
    expect(useChatStore.getState().partsBySession['s1']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. Ход: startTurn / finishTurn / patchTurn
// ---------------------------------------------------------------------------

describe('chatStore: активный ход (ADR-118 §1)', () => {
  const turn: ActiveTurn = { turnId: 't1', streamId: 'st1', status: 'streaming', agentRole: 'fixer' }

  it('startTurn делает ход активным', () => {
    useChatStore.getState().startTurn('s1', turn)

    expect(useChatStore.getState().turnBySession['s1']).toEqual(turn)
    expect(isTurnActive('s1')).toBe(true)
    expect(isTurnActive('s2')).toBe(false)
  })

  it('patchTurn правит шаг/модель активного хода', () => {
    const store = useChatStore.getState()
    store.startTurn('s1', turn)
    store.patchTurn('s1', { messageId: 'm2', stepIndex: 1, model: 'gpt-x', provider: 'openai' })

    expect(useChatStore.getState().turnBySession['s1']).toMatchObject({
      turnId: 't1',
      agentRole: 'fixer',
      messageId: 'm2',
      stepIndex: 1,
      model: 'gpt-x',
      provider: 'openai',
    })
    expect(isTurnActive('s1')).toBe(true)
  })

  it('patchTurn без активного хода — no-op', () => {
    useChatStore.getState().patchTurn('s1', { model: 'gpt-x' })
    expect(useChatStore.getState().turnBySession['s1']).toBeUndefined()
  })

  it('finishTurn ставит терминальный статус — ход перестаёт быть активным', () => {
    const store = useChatStore.getState()
    store.startTurn('s1', turn)
    store.finishTurn('s1', 't1')

    expect(useChatStore.getState().turnBySession['s1']!.status).toBe('completed')
    expect(isTurnActive('s1')).toBe(false)
  })

  it('finishTurn принимает явный статус (cancelled/error/stopped)', () => {
    const store = useChatStore.getState()
    for (const status of ['cancelled', 'error', 'stopped'] as const) {
      store.startTurn('s1', { turnId: `t-${status}`, status: 'streaming' })
      store.finishTurn('s1', `t-${status}`, status)
      expect(useChatStore.getState().turnBySession['s1']!.status).toBe(status)
    }
  })

  it('finishTurn по чужому turnId не закрывает новый ход', () => {
    const store = useChatStore.getState()
    store.startTurn('s1', { turnId: 't2', status: 'streaming' })
    // Опоздавший `turn.finished` предыдущего шага/попытки.
    store.finishTurn('s1', 't1', 'completed')

    expect(useChatStore.getState().turnBySession['s1']).toMatchObject({ turnId: 't2', status: 'streaming' })
    expect(isTurnActive('s1')).toBe(true)
  })

  it('ходы разных сессий не смешиваются', () => {
    const store = useChatStore.getState()
    store.startTurn('s1', { turnId: 't1', status: 'streaming' })
    store.startTurn('s2', { turnId: 't2', status: 'streaming' })
    store.finishTurn('s1', 't1')

    expect(isTurnActive('s1')).toBe(false)
    expect(isTurnActive('s2')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Статус сообщения: «финал» = смена статуса (ADR-118 §5)
// ---------------------------------------------------------------------------

describe('chatStore: setMessageStatus (ADR-118 §5)', () => {
  beforeEach(() => {
    useChatStore.getState().upsertMessage(
      's1',
      msg({ index: 0, id: 'm1', role: 'assistant', content: 'ответ', status: 'streaming', turn_id: 't1', ord: 0 }),
    )
  })

  it('streaming → completed: та же запись, меняется только статус', () => {
    useChatStore.getState().setMessageStatus('s1', 'm1', 'completed')

    const list = useChatStore.getState().messagesBySession['s1']!
    // «Финал» не добавляет второе сообщение — запись одна, меняется статус.
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'm1',
      role: 'assistant',
      content: 'ответ',
      ord: 0,
      turn_id: 't1',
      status: 'completed',
    })
  })

  it('терминальные статусы cancelled и error', () => {
    for (const status of ['cancelled', 'error'] as const) {
      useChatStore.getState().setMessageStatus('s1', 'm1', 'streaming')
      useChatStore.getState().setMessageStatus('s1', 'm1', status)
      expect(useChatStore.getState().messagesBySession['s1']![0]!.status).toBe(status)
    }
  })

  it('живое сообщение выбирается селектором пока streaming и пропадает после финала', () => {
    expect(selectStreamingMessage('s1')(useChatStore.getState())?.id).toBe('m1')

    useChatStore.getState().setMessageStatus('s1', 'm1', 'completed')
    expect(selectStreamingMessage('s1')(useChatStore.getState())).toBeUndefined()
  })

  it('неизвестный id / неизвестная сессия — no-op', () => {
    const before = useChatStore.getState().messagesBySession['s1']!
    useChatStore.getState().setMessageStatus('s1', 'missing', 'completed')
    useChatStore.getState().setMessageStatus('other', 'm1', 'completed')

    expect(useChatStore.getState().messagesBySession['s1']).toEqual(before)
    expect(useChatStore.getState().messagesBySession['other']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 5. Очередь: setQueueCounts (ADR-118 §4)
// ---------------------------------------------------------------------------

describe('chatStore: счётчики очереди (ADR-118 §4)', () => {
  it('setQueueCounts пишет pendingCount и steerCount', () => {
    useChatStore.getState().setQueueCounts('s1', 3, 1)

    expect(useChatStore.getState().queueBySession['s1']).toEqual({
      pendingCount: 3,
      steerCount: 1,
      isStalled: false,
    })
  })

  it('счётчики по сессиям не смешиваются и не сбрасывают признак зависания', () => {
    const store = useChatStore.getState()
    store.setQueueStalled('s1', 2)
    store.setQueueCounts('s1', 0, 0)
    store.setQueueCounts('s2', 5, 2)

    expect(useChatStore.getState().queueBySession['s1']).toEqual({
      pendingCount: 0,
      steerCount: 0,
      isStalled: true,
    })
    expect(useChatStore.getState().queueBySession['s2']).toEqual({
      pendingCount: 5,
      steerCount: 2,
      isStalled: false,
    })
  })
})

// ---------------------------------------------------------------------------
// 6. removeMessageById и «закрепить/обработать все сегменты хода разом»
// ---------------------------------------------------------------------------

describe('chatStore: удаление и пакетная правка сегментов хода', () => {
  it('removeMessageById убирает только указанное сообщение', () => {
    const store = useChatStore.getState()
    store.setMessages('s1', [
      msg({ index: 0, id: 'm0', ord: 0 }),
      msg({ index: 1, id: 'm1', ord: 1, role: 'assistant' }),
      msg({ index: 2, id: 'm2', ord: 2, role: 'assistant' }),
    ])

    store.removeMessageById('s1', 'm1')

    expect(useChatStore.getState().messagesBySession['s1']!.map((m) => m.id)).toEqual(['m0', 'm2'])
  })

  it('removeMessageById по неизвестному id / сессии — no-op', () => {
    useChatStore.getState().setMessages('s1', [msg({ index: 0, id: 'm0' })])
    useChatStore.getState().removeMessageById('s1', 'missing')
    useChatStore.getState().removeMessageById('other', 'm0')

    expect(useChatStore.getState().messagesBySession['s1']).toHaveLength(1)
    expect(useChatStore.getState().messagesBySession['other']).toBeUndefined()
  })

  it('закрепление всех сегментов хода (pin по каждому сообщению хода)', () => {
    const store = useChatStore.getState()
    store.setMessages('s1', [
      msg({ index: 0, id: 'seg0', ord: 0, turn_id: 't1' }),
      msg({ index: 1, id: 'seg1', ord: 1, turn_id: 't1', role: 'assistant' }),
      msg({ index: 2, id: 'other', ord: 2, turn_id: 't2', role: 'assistant' }),
    ])

    const turnSegments = useChatStore.getState().messagesBySession['s1']!.filter((m) => m.turn_id === 't1')
    for (const segment of turnSegments) {
      useChatStore.getState().updateMessageById('s1', segment.id!, { pinned: true })
    }

    const after = useChatStore.getState().messagesBySession['s1']!
    expect(after.filter((m) => m.turn_id === 't1').every((m) => m.pinned)).toBe(true)
    expect(after.find((m) => m.id === 'other')!.pinned).toBe(false)
  })

  it('updateMessageByIndex удалён: адресация мутаций — по id (ADR-118 §7)', () => {
    // Метода в сторе нет — и ни один вызывающий его не использует.
    expect('updateMessageByIndex' in useChatStore.getState()).toBe(false)
    for (const file of ['./chatStore.ts', './transportStore.ts']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(src).not.toContain('updateMessageByIndex')
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Мультисессионность
// ---------------------------------------------------------------------------

describe('chatStore: состояние по сессиям не смешивается', () => {
  it('сообщения, части, ход и очередь живут в своих сессиях', () => {
    const store = useChatStore.getState()

    store.upsertMessage('s1', msg({ index: 0, id: 's1-m0', ord: 0, content: 'первая' }))
    store.upsertMessage('s2', msg({ index: 0, id: 's2-m0', ord: 0, content: 'вторая' }))
    store.upsertPart('s1', 's1-m0', 'p1', part({ id: 'p1', text: 'часть s1' }))
    store.startTurn('s1', { turnId: 't1', status: 'streaming' })
    store.setQueueCounts('s2', 2, 0)
    store.setMessageStatus('s1', 's1-m0', 'completed')

    const state = useChatStore.getState()
    expect(state.messagesBySession['s1']!.map((m) => m.content)).toEqual(['первая'])
    expect(state.messagesBySession['s2']!.map((m) => m.content)).toEqual(['вторая'])
    expect(state.messagesBySession['s2']![0]!.status).toBeUndefined()
    expect(state.partsBySession['s2']).toBeUndefined()
    expect(state.turnBySession['s2']).toBeUndefined()
    expect(state.queueBySession['s1']).toBeUndefined()
  })

  it('clearSession чистит только свою сессию', () => {
    const store = useChatStore.getState()
    store.upsertMessage('s1', msg({ index: 0, id: 'm1' }))
    store.upsertMessage('s2', msg({ index: 0, id: 'm2' }))
    store.startTurn('s2', { turnId: 't2', status: 'streaming' })

    store.clearSession('s1')

    expect(useChatStore.getState().messagesBySession['s1']).toBeUndefined()
    expect(useChatStore.getState().messagesBySession['s2']).toHaveLength(1)
    expect(useChatStore.getState().turnBySession['s2']!.turnId).toBe('t2')
  })

  it('setMessages сортирует пришедшую историю по ord', () => {
    useChatStore.getState().setMessages('s1', [
      msg({ index: 1, id: 'b', ord: 1 }),
      msg({ index: 0, id: 'a', ord: 0 }),
    ])

    expect(useChatStore.getState().messagesBySession['s1']!.map((m) => m.id)).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// Live-вклад саб-агентов (ADR-070 §2.6) — сохранённое покрытие
// ---------------------------------------------------------------------------

describe('chatStore: liveSubagentUsageBySession (ADR-070 §2.6)', () => {
  it('накапливает вклад по вызовам и агрегирует сессию', () => {
    const store = useChatStore.getState()
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      costUsd: 0.001,
      costCurrency: 'USD',
      estimated: false,
      model: 'm1',
    })
    store.updateLiveSubagentUsage('parent', 'call-2', {
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      estimated: true,
    })

    const live = useChatStore.getState().liveSubagentUsageBySession['parent']!
    expect(Object.keys(live.byCall)).toEqual(['call-1', 'call-2'])
    expect(live.byCall['call-1']!.model).toBe('m1')
    expect(live.usage).toEqual({
      input_tokens: 15,
      output_tokens: 3,
      total_tokens: 18,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    })
    expect(live.costUsd).toBeCloseTo(0.001)
    expect(live.estimated).toBe(true)
  })

  it('C2b: агрегат хранит разбивку по валютам и не смешивает их', () => {
    const store = useChatStore.getState()
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      costUsd: 0.03,
      costCurrency: 'USD',
    })
    store.updateLiveSubagentUsage('parent', 'call-2', {
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      costUsd: 2.1,
      costCurrency: 'RUB',
    })

    const live = useChatStore.getState().liveSubagentUsageBySession['parent']!
    expect(live.costByCurrency).toEqual({ USD: 0.03, RUB: 2.1 })
    expect(live.costUsd).toBeCloseTo(2.13)
    expect(live.costCurrency).toBeUndefined()
  })

  it('событие несёт накопленный usage вызова — перезапись, а не суммирование', () => {
    const store = useChatStore.getState()
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    })
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 25, output_tokens: 8, total_tokens: 33 },
    })

    const live = useChatStore.getState().liveSubagentUsageBySession['parent']!
    expect(live.byCall['call-1']!.usage.input_tokens).toBe(25)
    expect(live.usage.input_tokens).toBe(25)
  })

  it('clearSession сбрасывает live-вклад сессии; селектор отдаёт только свою сессию', () => {
    const store = useChatStore.getState()
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    })
    expect(selectLiveSubagentUsage('parent')(useChatStore.getState())?.usage.input_tokens).toBe(10)
    expect(selectLiveSubagentUsage('other')(useChatStore.getState())).toBeUndefined()

    store.clearSession('parent')
    expect(useChatStore.getState().liveSubagentUsageBySession['parent']).toBeUndefined()
  })
})
