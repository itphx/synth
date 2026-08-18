import { describe, it, expect } from 'vitest'
import { detectLogLevel, colorForLevel, stripAnsi, LOG_LEVEL_COLORS } from './logFormat'

describe('detectLogLevel', () => {
  it('находит уровень в скобках [ERROR]', () => {
    expect(detectLogLevel('[ERROR] что-то сломалось')).toBe('ERROR')
  })

  it('находит уровень в начале строки', () => {
    expect(detectLogLevel('INFO started')).toBe('INFO')
  })

  it('работает case-insensitive (warning)', () => {
    expect(detectLogLevel('warning: что-то подозрительное')).toBe('WARNING')
  })

  it('возвращает null для строки без уровня', () => {
    expect(detectLogLevel('GET /api/v2/sessions 200')).toBeNull()
  })

  it('возвращает null для пустой строки', () => {
    expect(detectLogLevel('')).toBeNull()
  })

  it('распознаёт OK и DONE', () => {
    expect(detectLogLevel('OK: всё готово')).toBe('OK')
    expect(detectLogLevel('task DONE')).toBe('DONE')
  })

  it('находит уровень даже при наличии ANSI-кодов перед ним', () => {
    expect(detectLogLevel('\u001b[31mERROR\u001b[0m boom')).toBe('ERROR')
  })
})

describe('colorForLevel', () => {
  it('возвращает цветовой класс для известных уровней', () => {
    for (const level of Object.keys(LOG_LEVEL_COLORS)) {
      expect(colorForLevel(level)).toBe(LOG_LEVEL_COLORS[level])
    }
  })

  it('возвращает нейтральный класс для null', () => {
    expect(colorForLevel(null)).toContain('text-muted-foreground')
  })

  it('возвращает нейтральный класс для неизвестного уровня', () => {
    expect(colorForLevel('TRACE')).toContain('text-muted-foreground')
  })
})

describe('stripAnsi', () => {
  it('удаляет ANSI-коды из строки', () => {
    expect(stripAnsi('\u001b[32m200\u001b[0m OK')).toBe('200 OK')
  })

  it('не меняет строку без ANSI-кодов', () => {
    const plain = 'GET /api/v2/sessions 200'
    expect(stripAnsi(plain)).toBe(plain)
  })

  it('удаляет последовательные ANSI-последовательности', () => {
    expect(stripAnsi('\u001b[32m\u001b[1mbold green\u001b[0m')).toBe('bold green')
  })
})
