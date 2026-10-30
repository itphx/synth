/**
 * `subagent.progress` → live-блок `task` в родительском ходе.
 *
 * Актуальное ядро присылает **дельты** (`content_delta`/`reasoning_delta`).
 * Старое ядро (гибрид с другой версией) присылало накопленный текст в полях
 * `content`/`reasoning` — UI обязан вычесть уже показанный префикс, иначе
 * текст задваивается (`дум` + `думаю` → `думдумаю`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 'parent', messages: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { createDispatcher } from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

const SESSION = 'parent'
const STREAM = 'st-parent'
const CALL = 'call-1'

/** Ход с одним running-партом `task` (в него и вкладывается прогресс). */
function startTask(): void {
  const chat = useChatStore.getState()
  chat.startStream(SESSION, STREAM, 'assistant')
  chat.addToolCall(SESSION, STREAM, {
    callId: CALL,
    name: 'task',
    args: {},
    status: 'running',
    startedAt: new Date().toISOString(),
    iteration: 0,
  })
}

function progress(payload: Record<string, unknown>): void {
  dispatch(makeEvent('subagent.progress', SESSION, {
    stream_id: STREAM,
    parent_call_id: CALL,
    ...payload,
  }))
}

function taskCall() {
  return useChatStore.getState().streamingBySession[SESSION]![STREAM]!.toolCalls[0]!
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore dispatcher: subagent.progress (дельты)', () => {
  it('дельты дописываются, новая итерация открывает новый блок', () => {
    startTask()

    progress({ reasoning_delta: 'дум', content_delta: 'Hel', iteration: 0 })
    progress({ reasoning_delta: 'аю', content_delta: 'lo', iteration: 0 })
    progress({ reasoning_delta: 'дальше', content_delta: 'второй шаг', iteration: 1 })

    expect(taskCall().subagentReasoningBlocks).toEqual([
      { text: 'думаю', iteration: 0 },
      { text: 'дальше', iteration: 1 },
    ])
    expect(taskCall().subagentIntermediateTextBlocks).toEqual([
      { text: 'Hello', iteration: 0 },
      { text: 'второй шаг', iteration: 1 },
    ])
  })

  it('пустые дельты не создают блоков', () => {
    startTask()

    progress({ reasoning_delta: '', content_delta: '', iteration: 0, usage: { inputTokens: 10 } })

    expect(taskCall().subagentReasoningBlocks).toEqual([])
    expect(taskCall().subagentIntermediateTextBlocks).toEqual([])
  })
})

describe('transportStore dispatcher: subagent.progress (совместимость со старым ядром, гибрид)', () => {
  it('накопленный content/reasoning без дельт не задваивает текст', () => {
    startTask()

    // Старое ядро: кадр несёт полный текст с начала итерации, ключей `*_delta` нет.
    progress({ reasoning: 'дум', content: 'Hel', iteration: 0 })
    progress({ reasoning: 'думаю', content: 'Hello', iteration: 0 })
    progress({ reasoning: 'думаю дальше', content: 'Hello второй шаг', iteration: 1 })

    expect(taskCall().subagentReasoningBlocks).toEqual([
      { text: 'думаю', iteration: 0 },
      { text: ' дальше', iteration: 1 },
    ])
    expect(taskCall().subagentIntermediateTextBlocks).toEqual([
      { text: 'Hello', iteration: 0 },
      { text: ' второй шаг', iteration: 1 },
    ])
  })

  it('дельта важнее накопленного поля, если пришли оба', () => {
    startTask()

    // Смешанный кадр (переходный период): доверяем дельте, `content` игнорируем.
    progress({ content_delta: 'Hello', content: 'Hello', iteration: 0 })
    progress({ content_delta: ' мир', content: 'Hello мир', iteration: 0 })

    expect(taskCall().subagentIntermediateTextBlocks).toEqual([
      { text: 'Hello мир', iteration: 0 },
    ])
  })
})
