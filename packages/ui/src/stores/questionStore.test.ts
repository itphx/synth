import { describe, it, expect, beforeEach } from 'vitest'
import type { QuestionRecord } from '@itphx/synth-shared/types'
import { useQuestionStore, pendingFor } from './questionStore'

function makeRecord(id: string, overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id,
    sessionId: 's1',
    status: 'pending',
    questions: [
      {
        question: 'Какой вариант?',
        header: 'Выбор',
        options: [{ value: 'a', label: 'A' }],
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('questionStore', () => {
  beforeEach(() => {
    useQuestionStore.setState({ bySession: {} })
  })

  it('добавляет записи вопросов в сессию', () => {
    useQuestionStore.getState().add('s1', makeRecord('q1'))

    const records = useQuestionStore.getState().bySession['s1']
    expect(records).toHaveLength(1)
    expect(records![0]!.id).toBe('q1')
  })

  it('add дедуплицирует по id', () => {
    const store = useQuestionStore.getState()
    store.add('s1', makeRecord('q1'))
    store.add('s1', makeRecord('q1'))

    expect(useQuestionStore.getState().bySession['s1']).toHaveLength(1)
  })

  it('upsert заменяет запись с тем же id', () => {
    const store = useQuestionStore.getState()
    store.add('s1', makeRecord('q1'))
    store.upsert('s1', makeRecord('q1', { status: 'answered' }))

    const records = useQuestionStore.getState().bySession['s1']
    expect(records).toHaveLength(1)
    expect(records![0]!.status).toBe('answered')
  })

  it('pending — первыми, внутри группы свежие первыми', () => {
    const store = useQuestionStore.getState()
    store.add('s1', makeRecord('old', { createdAt: '2026-01-01T00:00:00.000Z' }))
    store.add('s1', makeRecord('new', { createdAt: '2026-02-01T00:00:00.000Z' }))
    store.add('s1', makeRecord('done', { status: 'answered' }))

    const records = useQuestionStore.getState().bySession['s1']!
    expect(records.map((r) => r.id)).toEqual(['new', 'old', 'done'])
  })

  it('remove убирает запись и чистит пустую сессию', () => {
    const store = useQuestionStore.getState()
    store.add('s1', makeRecord('q1'))
    store.remove('s1', 'q1')

    expect(useQuestionStore.getState().bySession['s1']).toBeUndefined()
  })

  it('remove несуществующей записи ничего не меняет', () => {
    useQuestionStore.getState().add('s1', makeRecord('q1'))
    useQuestionStore.getState().remove('s1', 'other')

    expect(useQuestionStore.getState().bySession['s1']).toHaveLength(1)
  })

  it('clearSession очищает записи сессии', () => {
    useQuestionStore.getState().add('s1', makeRecord('q1'))
    useQuestionStore.getState().add('s2', makeRecord('q2'))
    useQuestionStore.getState().clearSession('s1')

    expect(useQuestionStore.getState().bySession['s1']).toBeUndefined()
    expect(useQuestionStore.getState().bySession['s2']).toHaveLength(1)
  })

  it('setAll заменяет набор записей сессии (восстановление после перезагрузки)', () => {
    useQuestionStore.getState().add('s1', makeRecord('stale'))
    useQuestionStore.getState().setAll('s1', [makeRecord('q1'), makeRecord('q2')])

    const records = useQuestionStore.getState().bySession['s1']!
    expect(records.map((r) => r.id).sort()).toEqual(['q1', 'q2'])
  })

  it('pendingFor отдаёт только записи со статусом pending', () => {
    useQuestionStore.getState().setAll('s1', [
      makeRecord('q1'),
      makeRecord('q2', { status: 'answered' }),
      makeRecord('q3', { status: 'cancelled' }),
    ])

    expect(pendingFor('s1').map((q) => q.id)).toEqual(['q1'])
  })

  it('pendingFor для сессии без вопросов — пустой список', () => {
    expect(pendingFor('unknown')).toEqual([])
  })
})
