import { describe, it, expect } from 'vitest'
import { isVisibleMessage, isStateMessage, isLlmFailureMessage, STATE_MESSAGE_TYPES } from './messageVisibility'

describe('messageVisibility', () => {
  it('скрывает служебный tool-result (role: tool, metadata.tool_chain === true)', () => {
    expect(isVisibleMessage({ role: 'tool', metadata: { tool_chain: true } })).toBe(false)
    expect(isStateMessage({ metadata: { tool_chain: true } })).toBe(false)
  })

  it('живой tool-chain шаг (status: streaming) виден — с карточками инструментов', () => {
    expect(isVisibleMessage({ role: 'assistant', metadata: { tool_chain: true }, status: 'streaming' })).toBe(true)
    // После завершения служебная запись без tool_results снова скрыта.
    expect(isVisibleMessage({ role: 'assistant', metadata: { tool_chain: true }, status: 'completed' })).toBe(false)
  })

  it('assistant-шаг с tool_results видим даже при legacy tool_chain', () => {
    const results = [{ id: 'call_q', name: 'question', args: {}, result: { content: 'ok' } }]
    expect(isVisibleMessage({
      role: 'assistant',
      metadata: { tool_chain: true, tool_results: results },
      status: 'completed',
    })).toBe(true)
    // Пустой массив результатом не считается — служебный шаг скрыт.
    expect(isVisibleMessage({
      role: 'assistant',
      metadata: { tool_chain: true, tool_results: [] },
      status: 'completed',
    })).toBe(false)
    // Не-assistant с tool_results правило не расширяет.
    expect(isVisibleMessage({
      role: 'tool',
      metadata: { tool_chain: true, tool_results: results },
      status: 'completed',
    })).toBe(false)
  })

  it('state-сообщение остаётся скрытым даже в streaming', () => {
    expect(isVisibleMessage({ role: 'assistant', metadata: { state: true, tool_chain: true }, status: 'streaming' })).toBe(false)
    expect(isVisibleMessage({ role: 'assistant', metadata: { type: 'plan_updated' }, status: 'streaming' })).toBe(false)
  })

  it('скрывает state-сообщения по metadata.state === true', () => {
    expect(isVisibleMessage({ role: 'assistant', metadata: { state: true } })).toBe(false)
  })

  it('скрывает state-сообщения по metadata.type из STATE_MESSAGE_TYPES', () => {
    for (const type of STATE_MESSAGE_TYPES) {
      expect(isVisibleMessage({ role: 'assistant', metadata: { type } })).toBe(false)
      expect(isStateMessage({ metadata: { type } })).toBe(true)
    }
  })

  it('скрывает user-сообщение системной команды (metadata.commandPrompt === true)', () => {
    expect(isVisibleMessage({ role: 'user', metadata: { commandPrompt: true } })).toBe(false)
    // Признак не относится к state-сообщениям.
    expect(isStateMessage({ metadata: { commandPrompt: true } })).toBe(false)
  })

  it('пропускает обычные сообщения', () => {
    expect(isVisibleMessage({ role: 'assistant', metadata: undefined })).toBe(true)
    expect(isVisibleMessage({ role: 'assistant', metadata: null })).toBe(true)
    expect(isVisibleMessage({ role: 'assistant', metadata: {} })).toBe(true)
    expect(isVisibleMessage({ role: 'assistant', metadata: { tool_chain: false } })).toBe(true)
    expect(isVisibleMessage({ role: 'user', metadata: { commandPrompt: false } })).toBe(true)
    expect(isVisibleMessage({ role: 'system', metadata: { command: true } })).toBe(true)
    expect(isVisibleMessage({ role: 'assistant', metadata: { type: 'unknown_type' } })).toBe(true)
  })
})

describe('messageVisibility: isLlmFailureMessage', () => {
  const assistant = (status: string | null | undefined, metadata?: Record<string, unknown>) => ({
    role: 'assistant',
    status: status as never,
    metadata,
  })

  it('терминальная ошибка провайдера (router.*) — ошибка', () => {
    expect(isLlmFailureMessage(assistant('error', {
      status: 'error',
      i18n: { key: 'router.network_error' },
    }))).toBe(true)
    expect(isLlmFailureMessage(assistant('error', {
      status: 'error',
      i18n: { key: 'router.remote_auth_expired' },
    }))).toBe(true)
    expect(isLlmFailureMessage(assistant('error', {
      status: 'error',
      i18n: { key: 'worktree.directory_missing' },
    }))).toBe(true)
  })

  it('сырой текст без i18n — тоже ошибка', () => {
    expect(isLlmFailureMessage(assistant('error', { status: 'error' }))).toBe(true)
  })

  it('legacy-запись без статуса шага (metadata.status: error) — ошибка', () => {
    expect(isLlmFailureMessage(assistant(null, { status: 'error' }))).toBe(true)
    expect(isLlmFailureMessage(assistant(undefined, { status: 'error' }))).toBe(true)
  })

  it('fallback-ответы ядра (output_limit/empty_response) ошибкой не считаются', () => {
    expect(isLlmFailureMessage(assistant('error', {
      status: 'error',
      i18n: { key: 'session.output_limit' },
    }))).toBe(false)
    expect(isLlmFailureMessage(assistant('error', {
      status: 'error',
      i18n: { key: 'session.empty_response' },
    }))).toBe(false)
    // Legacy-запись без статуса шага — тоже видима.
    expect(isLlmFailureMessage(assistant(null, {
      status: 'error',
      i18n: { key: 'session.output_limit' },
    }))).toBe(false)
  })

  it('interrupted — частичный ответ, не ошибка', () => {
    expect(isLlmFailureMessage(assistant('error', {
      status: 'error',
      interrupted: true,
    }))).toBe(false)
  })

  it('не-assistant, успешные и незавершённые ответы — не ошибка', () => {
    expect(isLlmFailureMessage({ role: 'user', status: 'error', metadata: { status: 'error' } })).toBe(false)
    expect(isLlmFailureMessage({ role: 'tool', status: 'error', metadata: { status: 'error' } })).toBe(false)
    expect(isLlmFailureMessage({ role: 'error', status: 'error', metadata: {} })).toBe(false)
    expect(isLlmFailureMessage(assistant('completed', { status: 'completed' }))).toBe(false)
    expect(isLlmFailureMessage(assistant('streaming', { status: 'error' }))).toBe(false)
    expect(isLlmFailureMessage(assistant('cancelled', { status: 'error' }))).toBe(false)
  })
})
