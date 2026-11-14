import { describe, it, expect, vi } from 'vitest'
import { runTerminalStreamSession, type TerminalConnectionState } from './terminalStream'
import type { TerminalStreamOptions } from '@/lib/api/terminals'

/**
 * Сессия HTTP-потока вывода терминала (PROP-132, Ф3б): при обрыве — **один**
 * повтор с курсором последнего принятого кадра; после него — «соединение
 * потеряно».
 */

describe('сессия потока вывода терминала', () => {
  it('успешное подключение — одна попытка', async () => {
    const calls: number[] = []
    const states: TerminalConnectionState[] = []
    const chunks: Array<{ seq: number; data: string }> = []
    const stream = vi.fn(async (_id: string, options: TerminalStreamOptions) => {
      calls.push(options.since ?? 0)
      options.onChunk({ seq: 1, data: 'a' })
    })

    await runTerminalStreamSession({
      terminalId: 't1',
      signal: new AbortController().signal,
      onChunk: (chunk) => chunks.push(chunk),
      onState: (state) => states.push(state),
      stream,
    })

    expect(stream).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([0])
    expect(chunks).toEqual([{ seq: 1, data: 'a' }])
    expect(states).toEqual(['live'])
  })

  it('после обрыва — один повтор с курсором последнего seq', async () => {
    const calls: number[] = []
    const states: TerminalConnectionState[] = []
    const chunks: Array<{ seq: number; data: string }> = []
    const stream = vi.fn(async (_id: string, options: TerminalStreamOptions) => {
      calls.push(options.since ?? 0)
      if (calls.length === 1) {
        options.onChunk({ seq: 7, data: 'a' })
        throw new Error('обрыв')
      }
      options.onChunk({ seq: 8, data: 'b' })
    })

    await runTerminalStreamSession({
      terminalId: 't1',
      since: 5,
      signal: new AbortController().signal,
      onChunk: (chunk) => chunks.push(chunk),
      onState: (state) => states.push(state),
      stream,
    })

    expect(stream).toHaveBeenCalledTimes(2)
    // Повтор идёт с курсора последнего принятого кадра — вывод не теряется
    // и не двоится.
    expect(calls).toEqual([5, 7])
    expect(chunks).toEqual([
      { seq: 7, data: 'a' },
      { seq: 8, data: 'b' },
    ])
    expect(states).toEqual(['live', 'reconnecting', 'live'])
  })

  it('второй обрыв — «соединение потеряно», попыток ровно две', async () => {
    const states: TerminalConnectionState[] = []
    const stream = vi.fn(async () => {
      throw new Error('обрыв')
    })

    await runTerminalStreamSession({
      terminalId: 't1',
      signal: new AbortController().signal,
      onChunk: () => undefined,
      onState: (state) => states.push(state),
      stream,
    })

    expect(stream).toHaveBeenCalledTimes(2)
    expect(states).toEqual(['reconnecting', 'lost'])
  })

  it('отмена (abort) не даёт реконнекта', async () => {
    const controller = new AbortController()
    const states: TerminalConnectionState[] = []
    const stream = vi.fn(async () => {
      controller.abort()
      throw new Error('отмена')
    })

    await runTerminalStreamSession({
      terminalId: 't1',
      signal: controller.signal,
      onChunk: () => undefined,
      onState: (state) => states.push(state),
      stream,
    })

    expect(stream).toHaveBeenCalledTimes(1)
    expect(states).toEqual([])
  })

  it('кадр выхода доходит до вызывающего', async () => {
    const exits: Array<{ exitCode?: number; signal?: string }> = []
    const stream = vi.fn(async (_id: string, options: TerminalStreamOptions) => {
      options.onExit?.({ exitCode: 0 })
    })

    await runTerminalStreamSession({
      terminalId: 't1',
      signal: new AbortController().signal,
      onChunk: () => undefined,
      onExit: (info) => exits.push(info),
      stream,
    })

    expect(exits).toEqual([{ exitCode: 0 }])
  })
})
