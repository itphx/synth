// subagentRunsStore: ленивая догрузка шагов фонового саб-агента (ADR-111).
//
// Проверяем: сбор шагов из истории дочерней сессии, дедуп конкурентных
// вызовов `ensure`, состояние `error` и повтор, сброс кэша `invalidate`.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSessionMessages: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { getSessionMessages: mocks.getSessionMessages },
}))

import { useSubagentRunsStore } from './subagentRunsStore'
import type { MessageData } from '@/stores/chatStore'

function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'assistant',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-31T00:00:00Z',
    ...partial,
  }
}

/** Финальное сообщение ребёнка: вызовы + промежуточные тексты + размышления. */
function childFinalMessage(): MessageData {
  return makeMessage({
    id: 'm-final',
    role: 'assistant',
    content: 'ИТОГ',
    reasoning: 'РАЗМЫШЛЕНИЕ-1\n\n---\n\nРАЗМЫШЛЕНИЕ-2',
    // DTO отдаёт вызовы полем `tool_calls` (ядро берёт их из
    // `metadata.tool_results` финального сообщения ребёнка).
    tool_calls: [
      {
        name: 'execute_shell',
        args: { command: 'ls' },
        id: 'call-1',
        result: { content: 'ok', isError: false },
        started_at: '2026-10-31T00:00:01Z',
        completed_at: '2026-10-31T00:00:02Z',
        iteration: 0,
      },
      {
        name: 'read_file',
        args: { path: 'a.ts' },
        id: 'call-2',
        result: { content: 'код', isError: false },
        iteration: 1,
      },
    ],
    metadata: {
      status: 'completed',
      intermediate_text_blocks: [{ text: 'ПРОМЕЖУТОЧНЫЙ', iteration: 0 }],
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useSubagentRunsStore.getState().clear()
})

describe('subagentRunsStore', () => {
  it('ensure грузит историю дочерней сессии и собирает шаги', async () => {
    mocks.getSessionMessages.mockResolvedValue({
      messages: [childFinalMessage()],
      session_id: 'child-1',
    })

    await useSubagentRunsStore.getState().ensure('child-1')

    const entry = useSubagentRunsStore.getState().byChild['child-1']!
    expect(entry.status).toBe('ready')
    expect(entry.data?.toolCalls).toHaveLength(2)
    expect(entry.data?.toolCalls[0]).toMatchObject({
      name: 'execute_shell',
      args: { command: 'ls' },
      id: 'call-1',
      iteration: 0,
    })
    expect(entry.data?.toolCalls[1]).toMatchObject({ name: 'read_file', iteration: 1 })
    // Шаги — `max(iteration)+1` по вызовам.
    expect(entry.data?.steps).toBe(2)
    expect(entry.data?.finalContent).toBe('ИТОГ')
    expect(entry.data?.intermediateTextBlocks).toEqual([{ text: 'ПРОМЕЖУТОЧНЫЙ', iteration: 0 }])
    expect(entry.data?.reasoningBlocks.map((r) => r.text)).toEqual([
      'РАЗМЫШЛЕНИЕ-1',
      'РАЗМЫШЛЕНИЕ-2',
    ])
    expect(mocks.getSessionMessages).toHaveBeenCalledWith('child-1')
  })

  it('ensure не шлёт второй запрос при конкурентном вызове', async () => {
    let resolveMessages: ((value: unknown) => void) | undefined
    mocks.getSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveMessages = resolve
      }),
    )

    const first = useSubagentRunsStore.getState().ensure('child-1')
    const second = useSubagentRunsStore.getState().ensure('child-1')

    expect(useSubagentRunsStore.getState().byChild['child-1']?.status).toBe('loading')
    expect(mocks.getSessionMessages).toHaveBeenCalledTimes(1)

    resolveMessages?.({ messages: [childFinalMessage()], session_id: 'child-1' })
    await Promise.all([first, second])

    expect(useSubagentRunsStore.getState().byChild['child-1']?.status).toBe('ready')
    expect(mocks.getSessionMessages).toHaveBeenCalledTimes(1)
  })

  it('ensure при ошибке сохраняет состояние error с текстом, повтор грузит заново', async () => {
    mocks.getSessionMessages.mockRejectedValueOnce(new Error('403 Forbidden'))
    await useSubagentRunsStore.getState().ensure('child-1')

    const failed = useSubagentRunsStore.getState().byChild['child-1']!
    expect(failed.status).toBe('error')
    expect(failed.error).toContain('403')

    mocks.getSessionMessages.mockResolvedValueOnce({
      messages: [childFinalMessage()],
      session_id: 'child-1',
    })
    await useSubagentRunsStore.getState().ensure('child-1')

    expect(useSubagentRunsStore.getState().byChild['child-1']?.status).toBe('ready')
    expect(mocks.getSessionMessages).toHaveBeenCalledTimes(2)
  })

  it('invalidate сбрасывает кэш — следующий ensure перезагружает', async () => {
    mocks.getSessionMessages.mockResolvedValue({
      messages: [childFinalMessage()],
      session_id: 'child-1',
    })
    await useSubagentRunsStore.getState().ensure('child-1')
    expect(useSubagentRunsStore.getState().byChild['child-1']?.status).toBe('ready')

    useSubagentRunsStore.getState().invalidate('child-1')
    expect(useSubagentRunsStore.getState().byChild['child-1']).toBeUndefined()

    await useSubagentRunsStore.getState().ensure('child-1')
    expect(mocks.getSessionMessages).toHaveBeenCalledTimes(2)
    expect(useSubagentRunsStore.getState().byChild['child-1']?.status).toBe('ready')
  })

  it('invalidate отбрасывает результат уже идущей загрузки', async () => {
    let resolveMessages: ((value: unknown) => void) | undefined
    mocks.getSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveMessages = resolve
      }),
    )

    const pending = useSubagentRunsStore.getState().ensure('child-1')
    useSubagentRunsStore.getState().invalidate('child-1')
    resolveMessages?.({ messages: [childFinalMessage()], session_id: 'child-1' })
    await pending

    // Устаревшая загрузка не воскрешает удалённую запись.
    expect(useSubagentRunsStore.getState().byChild['child-1']).toBeUndefined()
  })

  it('пустая история ребёнка не считается ошибкой', async () => {
    mocks.getSessionMessages.mockResolvedValue({ messages: [], session_id: 'child-1' })

    await useSubagentRunsStore.getState().ensure('child-1')

    const entry = useSubagentRunsStore.getState().byChild['child-1']!
    expect(entry.status).toBe('ready')
    expect(entry.data?.toolCalls).toEqual([])
    expect(entry.data?.steps).toBeUndefined()
  })
})

/**
 * Новый вид записи (ADR-118 §1): каждый шаг ребёнка несёт вызовы **своей**
 * итерации (`metadata.tool_results`), свой `reasoning` и свой текст; отчёт
 * (`metadata.status`) — только финальный текст, без агрегата.
 */
function childStep(partial: Partial<MessageData> & { id: string; step: number }): MessageData {
  const { step, ...rest } = partial
  return makeMessage({
    turn_id: 'child-1',
    step_index: step,
    status: 'completed',
    metadata: { tool_chain: true, step_duration_ms: 5 },
    ...rest,
  })
}

describe('subagentRunsStore — новый вид записи (шаги с tool_results)', () => {
  function newChildHistory(): MessageData[] {
    return [
      childStep({
        id: 's0',
        step: 0,
        content: 'СЕЙЧАС ПОСМОТРЮ',
        reasoning: 'ДУМАЮ-0',
        metadata: {
          step_duration_ms: 5,
          tool_results: [
            {
              name: 'execute_shell',
              args: { command: 'ls' },
              id: 'call-1',
              result: { content: 'ok', isError: false },
              iteration: 0,
            },
          ],
        },
      }),
      childStep({
        id: 's1',
        step: 1,
        content: 'ПРОВЕРЮ ФАЙЛ',
        reasoning: 'ДУМАЮ-1',
        metadata: {
          step_duration_ms: 7,
          tool_results: [
            {
              name: 'read_file',
              args: { path: 'a.ts' },
              id: 'call-2',
              result: { content: 'код', isError: false },
              iteration: 1,
            },
          ],
        },
      }),
      makeMessage({
        id: 'report',
        step_index: 2,
        turn_id: 'child-1',
        status: 'completed',
        content: 'ИТОГ',
        reasoning: 'ДУМАЮ-2',
        metadata: { status: 'completed', steps: 3 },
      }),
    ]
  }

  it('вызовы, размышления и промежуточные тексты собираются по шагам', async () => {
    mocks.getSessionMessages.mockResolvedValue({
      messages: newChildHistory(),
      session_id: 'child-1',
    })

    await useSubagentRunsStore.getState().ensure('child-1')
    const data = useSubagentRunsStore.getState().byChild['child-1']!.data!

    // Вызовы — из сообщений шагов, в порядке истории, с их итерациями.
    expect(data.toolCalls.map((c) => [c.name, c.id, c.iteration])).toEqual([
      ['execute_shell', 'call-1', 0],
      ['read_file', 'call-2', 1],
    ])
    expect(data.steps).toBe(2) // max(iteration)+1 по собранным вызовам
    // Размышления — по итерациям шагов (включая последнюю итерацию отчёта).
    expect(data.reasoningBlocks).toEqual([
      { text: 'ДУМАЮ-0', iteration: 0 },
      { text: 'ДУМАЮ-1', iteration: 1 },
      { text: 'ДУМАЮ-2', iteration: 2 },
    ])
    // Промежуточные тексты — все шаги, кроме отчёта.
    expect(data.intermediateTextBlocks).toEqual([
      { text: 'СЕЙЧАС ПОСМОТРЮ', iteration: 0 },
      { text: 'ПРОВЕРЮ ФАЙЛ', iteration: 1 },
    ])
    expect(data.finalContent).toBe('ИТОГ')
  })

  it('прогон без отчёта (идёт): вызовы берутся из шагов', async () => {
    const history = newChildHistory()
    const running = history.slice(0, 2) // последнее assistant-сообщение — шаг
    mocks.getSessionMessages.mockResolvedValue({ messages: running, session_id: 'child-1' })

    await useSubagentRunsStore.getState().ensure('child-1')
    const data = useSubagentRunsStore.getState().byChild['child-1']!.data!

    expect(data.toolCalls.map((c) => c.id)).toEqual(['call-1', 'call-2'])
    expect(data.reasoningBlocks.map((r) => r.text)).toEqual(['ДУМАЮ-0', 'ДУМАЮ-1'])
    // Отчёта нет — последний шаг тоже промежуточный.
    expect(data.intermediateTextBlocks.map((t) => t.text)).toEqual(['СЕЙЧАС ПОСМОТРЮ', 'ПРОВЕРЮ ФАЙЛ'])
    expect(data.finalContent).toBe('ПРОВЕРЮ ФАЙЛ')
  })

  it('вызовы дедуплицируются по id (агрегат в отчёте не задваивает шаги)', async () => {
    const history = newChildHistory()
    const report = history[2]!
    // Legacy-совместимый микс: отчёт принёс те же вызовы агрегатом.
    report.tool_calls = [
      { name: 'execute_shell', args: { command: 'ls' }, id: 'call-1', iteration: 0 },
      { name: 'read_file', args: { path: 'a.ts' }, id: 'call-2', iteration: 1 },
    ]
    mocks.getSessionMessages.mockResolvedValue({ messages: history, session_id: 'child-1' })

    await useSubagentRunsStore.getState().ensure('child-1')
    const data = useSubagentRunsStore.getState().byChild['child-1']!.data!

    expect(data.toolCalls.map((c) => c.id)).toEqual(['call-1', 'call-2'])
  })
})

describe('subagentRunsStore — legacy-запись (агрегат в финальном сообщении)', () => {
  it('собирает размышления порядком блоков и тексты из metadata', async () => {
    mocks.getSessionMessages.mockResolvedValue({
      messages: [childFinalMessage()],
      session_id: 'child-1',
    })

    await useSubagentRunsStore.getState().ensure('child-1')
    const data = useSubagentRunsStore.getState().byChild['child-1']!.data!

    expect(data.toolCalls.map((c) => c.id)).toEqual(['call-1', 'call-2'])
    expect(data.reasoningBlocks).toEqual([
      { text: 'РАЗМЫШЛЕНИЕ-1', iteration: 0 },
      { text: 'РАЗМЫШЛЕНИЕ-2', iteration: 1 },
    ])
    expect(data.intermediateTextBlocks).toEqual([{ text: 'ПРОМЕЖУТОЧНЫЙ', iteration: 0 }])
    expect(data.finalContent).toBe('ИТОГ')
  })

  it('шаги с текстами + legacy-агрегат: промежуточные тексты без дублей', async () => {
    const report = childFinalMessage()
    const history = [
      childStep({ id: 's0', step: 0, content: 'ПРОМЕЖУТОЧНЫЙ', reasoning: 'Р-0' }),
      report,
    ]
    mocks.getSessionMessages.mockResolvedValue({ messages: history, session_id: 'child-1' })

    await useSubagentRunsStore.getState().ensure('child-1')
    const data = useSubagentRunsStore.getState().byChild['child-1']!.data!

    expect(data.intermediateTextBlocks).toEqual([{ text: 'ПРОМЕЖУТОЧНЫЙ', iteration: 0 }])
    // Размышления: шаг 0 + склейка отчёта (legacy) — без дублей.
    expect(data.reasoningBlocks.map((r) => r.text)).toEqual([
      'Р-0',
      'РАЗМЫШЛЕНИЕ-1',
      'РАЗМЫШЛЕНИЕ-2',
    ])
  })

  it('нет вызовов — число шагов берётся из `metadata.steps` отчёта', async () => {
    mocks.getSessionMessages.mockResolvedValue({
      messages: [
        makeMessage({
          id: 'report',
          status: 'completed',
          content: 'ИТОГ',
          metadata: { status: 'completed', steps: 4 },
        }),
      ],
      session_id: 'child-1',
    })

    await useSubagentRunsStore.getState().ensure('child-1')
    expect(useSubagentRunsStore.getState().byChild['child-1']!.data?.steps).toBe(4)
  })
})
