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
