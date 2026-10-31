/**
 * ADR-118 §5: сведение live-частей с частями из истории.
 *
 * У финального сообщения текст и рассуждения берутся **только** из dto: id
 * текстовых частей `msg:text:<ordinal>` совпадают у разных шагов, и
 * «застрявший» live-текст прошлого шага попал бы в блок хода. А tool-части
 * (id = `callId`) мержутся с dto — карточки инструментов шага не должны
 * пропадать между `step.finished` и приходом истории.
 */
import { describe, it, expect } from 'vitest'
import type { Part } from '@itphx/synth-shared/types'
import { buildPartsView, normalizeLiveToolPart, resolveLiveParts, turnHasContent } from './messageParts'
import type { LivePart, MessageData } from '@/stores/chatStore'

function textPart(id: string, text: string): Part {
  return { id, type: 'text', data: text }
}

function toolPart(id: string, name: string): LivePart {
  return {
    id,
    type: 'tool_use',
    text: '',
    data: { id, type: 'function', function: { name, arguments: '{}' } },
  }
}

describe('resolveLiveParts', () => {
  it('во время шага (isLive) — источник истины: все live-части', () => {
    const live = [toolPart('call-1', 'execute_shell')]
    expect(resolveLiveParts(live, { isLive: true, dtoParts: [] })).toEqual(live)
  })

  it('пустые dto-части — live-части остаются фоллбеком (текст не пропадает)', () => {
    const live: LivePart[] = [{ id: 'msg:text:0', type: 'text', text: 'Запускаю команду.' }]
    expect(resolveLiveParts(live, { isLive: false, dtoParts: [] })).toEqual(live)
  })

  it('непустые dto-части: текст/reasoning — только из dto, live-текст отбрасывается', () => {
    const live: LivePart[] = [
      { id: 'msg:text:0', type: 'text', text: 'Текст прошлого шага' },
      { id: 'msg:reasoning:0', type: 'reasoning', text: 'Рассуждение прошлого шага' },
    ]
    const dto = [textPart('msg:text:0', 'Текст шага из истории')]

    const resolved = resolveLiveParts(live, { isLive: false, dtoParts: dto })
    expect(resolved).toBeUndefined()

    const view = buildPartsView(dto, resolved, {})
    expect(view.text).toBe('Текст шага из истории')
    expect(view.reasoning).toHaveLength(0)
  })

  it('непустые dto-части: tool-части из live мержутся (карточка инструмента не пропадает)', () => {
    const live = [normalizeLiveToolPart(toolPart('call-1', 'execute_shell'))]
    const dto = [textPart('msg:text:0', 'Запускаю команду.')]

    const resolved = resolveLiveParts(live, { isLive: false, dtoParts: dto })
    expect(resolved).toHaveLength(1)
    expect(resolved![0]!.type).toBe('tool_use')

    const view = buildPartsView(dto, resolved, {})
    expect(view.text).toBe('Запускаю команду.')
    expect(view.toolCalls).toHaveLength(1)
    expect(view.toolCalls[0]).toMatchObject({ callId: 'call-1', name: 'execute_shell' })
  })

  it('tool-часть, уже пришедшая в dto, не дублируется', () => {
    const live = [normalizeLiveToolPart(toolPart('call-1', 'execute_shell'))]
    const dto: Part[] = [
      textPart('msg:text:0', 'Запускаю команду.'),
      { id: 'call-1', type: 'tool_use', data: { name: 'execute_shell', args: {} } },
    ]

    const view = buildPartsView(dto, resolveLiveParts(live, { isLive: false, dtoParts: dto }), {})
    expect(view.toolCalls).toHaveLength(1)
  })

  it('live-часть вызова важнее dto-снимка: результат тула виден', () => {
    // DTO — снимок финала шага (до запуска тула), результата в нём нет.
    const dto: Part[] = [
      textPart('msg:text:0', 'Запускаю команду.'),
      { id: 'call-1', type: 'tool_use', data: { name: 'execute_shell', args: {} } },
    ]
    const live: LivePart[] = [{
      id: 'call-1',
      type: 'tool_use',
      text: '',
      data: { name: 'execute_shell', args: {}, status: 'done', result: { content: 'file.txt' } },
    }]

    const view = buildPartsView(dto, resolveLiveParts(live, { isLive: false, dtoParts: dto }), {})
    expect(view.toolCalls).toHaveLength(1)
    expect(view.toolCalls[0]).toMatchObject({ callId: 'call-1', status: 'done' })
    expect(view.toolCalls[0]!.result?.content).toBe('file.txt')
  })

  it('live-частей нет — undefined (без live-фоллбэка)', () => {
    expect(resolveLiveParts(undefined, { isLive: false, dtoParts: [textPart('a', 'b')] })).toBeUndefined()
    expect(resolveLiveParts([], { isLive: false, dtoParts: [textPart('a', 'b')] })).toBeUndefined()
  })

  it('buildPartsView сам нормализует вызов провайдера — карточка с именем', () => {
    // Сырой вызов провайдера (`{type:'function', function:{name, arguments}}`)
    // приходит в dto-части без ручной нормализации.
    const dto: Part[] = [
      textPart('msg:text:0', 'Запускаю команду.'),
      {
        id: 'call-1',
        type: 'tool_use',
        data: { type: 'function', function: { name: 'execute_shell', arguments: '{"command":"ls"}' } },
      },
    ]

    const view = buildPartsView(dto, undefined, {})
    expect(view.toolCalls).toHaveLength(1)
    expect(view.toolCalls[0]).toMatchObject({
      callId: 'call-1',
      name: 'execute_shell',
      args: { command: 'ls' },
    })
  })
})

describe('turnHasContent: признак «контент хода уже был»', () => {
  function message(partial: Partial<MessageData>): MessageData {
    return {
      index: 0,
      id: 'm1',
      role: 'assistant',
      content: '',
      disabled: false,
      pinned: false,
      hidden: false,
      created_at: '2026-10-30T00:00:00Z',
      ...partial,
    }
  }

  it('флаг contentStarted — контент есть', () => {
    expect(turnHasContent([], { turnId: 't1', contentStarted: true })).toBe(true)
  })

  it('непустой контент assistant-сообщения хода — контент есть', () => {
    const messages = [message({ id: 'a-1', turn_id: 't1', content: 'Ответ' })]
    expect(turnHasContent(messages, { turnId: 't1' })).toBe(true)
  })

  it('пустой шаг — контента нет', () => {
    const messages = [message({ id: 'a-1', turn_id: 't1', content: '', parts: [] })]
    expect(turnHasContent(messages, { turnId: 't1' })).toBe(false)
  })

  it('чужой ход не считается контентом', () => {
    const messages = [message({ id: 'a-1', turn_id: 't2', content: 'Ответ' })]
    expect(turnHasContent(messages, { turnId: 't1' })).toBe(false)
  })

  it('fallback — сообщение шага (восстановление хода по current_stream)', () => {
    const step = message({ id: 'a-1', content: 'Ответ' })
    expect(turnHasContent([], { turnId: 't1' }, step)).toBe(true)
  })
})
