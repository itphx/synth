/**
 * `terminalContext` — блок контекста терминала для сообщения агенту.
 *
 * Проверяем чистые части модуля: хвост буфера xterm и сборку блока
 * `<terminal_context>`.
 */
import { describe, it, expect } from 'vitest'

import {
  buildTerminalContextBlock,
  buildTerminalReadBlock,
  readTerminalBufferLines,
  tailLines,
  type TerminalBufferLike,
} from './terminalContext'

/** Буфер xterm: `length` — число строк, `baseY` — начало нижней страницы. */
function makeBuffer(total: number, baseY: number): TerminalBufferLike {
  return {
    buffer: {
      active: {
        length: total,
        baseY,
        getLine(index: number) {
          if (index < 0 || index >= total) return undefined
          return { translateToString: () => `line-${index}` }
        },
      },
    },
  }
}

describe('readTerminalBufferLines — хвост буфера терминала', () => {
  it('пустой буфер — пустой хвост', () => {
    expect(readTerminalBufferLines(makeBuffer(0, 0), 50)).toEqual([])
  })

  it('буфер без прокрутки — последние строки страницы', () => {
    const lines = readTerminalBufferLines(makeBuffer(24, 0), 3)
    expect(lines).toEqual(['line-21', 'line-22', 'line-23'])
  })

  it('буфер с прокруткой — хвост всего буфера, а не пустота', () => {
    // 200 строк вывода в вьюпорте 24: `baseY` = 176 (прокрутка), `length` = 200.
    const lines = readTerminalBufferLines(makeBuffer(200, 176), 50)
    expect(lines).toHaveLength(50)
    expect(lines[0]).toBe('line-150')
    expect(lines[49]).toBe('line-199')
  })

  it('лимит больше буфера — весь буфер', () => {
    expect(readTerminalBufferLines(makeBuffer(5, 0), 50)).toEqual([
      'line-0',
      'line-1',
      'line-2',
      'line-3',
      'line-4',
    ])
  })

  it('пустые строки в начале хвоста отбрасываются', () => {
    const term: TerminalBufferLike = {
      buffer: {
        active: {
          length: 4,
          baseY: 0,
          getLine(index: number) {
            if (index < 0 || index >= 4) return undefined
            return { translateToString: () => (index < 2 ? '' : `line-${index}`) }
          },
        },
      },
    }
    expect(readTerminalBufferLines(term, 4)).toEqual(['line-2', 'line-3'])
  })

  it('терминала нет — пустой хвост', () => {
    expect(readTerminalBufferLines(null, 50)).toEqual([])
    expect(readTerminalBufferLines(undefined, 50)).toEqual([])
  })
})

describe('tailLines — хвост текста', () => {
  it('последние N строк без пустого хвоста', () => {
    expect(tailLines('a\nb\nc\n', 2)).toEqual(['b', 'c'])
  })

  it('лимит <= 0 — пусто', () => {
    expect(tailLines('a\nb', 0)).toEqual([])
  })
})

describe('buildTerminalContextBlock — блок <terminal_context>', () => {
  it('блок несёт терминал, каталог, оболочку и строки', () => {
    const block = buildTerminalContextBlock({
      terminalId: 't1',
      cwd: '/workspace/demo',
      shell: '/bin/bash',
      lines: ['первая', 'вторая'],
    })
    expect(block).toBe(
      '<terminal_context terminal="t1" cwd="/workspace/demo" shell="/bin/bash">\nпервая\nвторая\n</terminal_context>',
    )
  })

  it('значения атрибутов экранируются', () => {
    const block = buildTerminalContextBlock({
      terminalId: 't"1',
      cwd: null,
      shell: undefined,
      lines: [],
    })
    expect(block).toContain('terminal="t&quot;1"')
    expect(block).toContain('cwd=""')
    expect(block).toContain('shell=""')
  })
})

describe('buildTerminalReadBlock — блок вывода в формате terminal_read', () => {
  it('маркеры и метаданные — как у тула terminal_read', () => {
    const block = buildTerminalReadBlock({
      terminalId: 'term_1',
      status: 'running',
      lines: ['first', 'second'],
    })
    expect(block).toBe(
      '[CONTENT terminal=term_1 status=running bytes=12 tail=2 stripped=true]\n'
      + 'first\nsecond\n'
      + '[CONTENT END]',
    )
  })

  it('закрывающий маркер — именно [CONTENT END]', () => {
    const block = buildTerminalReadBlock({
      terminalId: 'term_1',
      status: 'running',
      lines: ['a'],
    })
    expect(block.endsWith('[CONTENT END]')).toBe(true)
    expect(block).not.toContain('[/CONTENT]')
  })

  it('bytes — размер тела в UTF-8, tail — число строк', () => {
    const block = buildTerminalReadBlock({
      terminalId: 'term_1',
      status: 'exited',
      lines: ['ы', 'b'],
    })
    // «ы» — 2 байта в UTF-8, «b» — 1, перевод строки — 1 → 4 байта.
    expect(block).toContain('bytes=4')
    expect(block).toContain('tail=2')
    expect(block).toContain('status=exited')
  })

  it('пустой вывод — открывающий маркер и сразу [CONTENT END]', () => {
    const block = buildTerminalReadBlock({
      terminalId: 'term_1',
      status: 'running',
      lines: [],
    })
    expect(block).toBe(
      '[CONTENT terminal=term_1 status=running bytes=0 tail=0 stripped=true]\n[CONTENT END]',
    )
  })

  it('значения маркера не ломают формат (пробелы и скобка)', () => {
    const block = buildTerminalReadBlock({
      terminalId: 'term 1]',
      status: 'running',
      lines: [],
    })
    expect(block).toContain('terminal=term1')
    expect(block).not.toContain('term 1]')
  })
})
