/**
 * PROP-132 (Ф5): обрамление и нормализация вывода терминала для модели
 * (`engine/terminal/output.ts`).
 *
 * Проверяется:
 *   • обрамление `[CONTENT]` … `[CONTENT END]` (константы протокола, не i18n);
 *   • обрезка хвостовых пустых строк;
 *   • нормализация `\r\n` → `\n` (только возвращаемый текст — буфер не трогаем);
 *   • одиночный `\r` (возврат каретки прогрес-вывода) не трогаем.
 */
import { describe, it, expect } from 'vitest';
import {
  frameTerminalOutput,
  normalizeTerminalLineEndings,
  normalizeTerminalOutput,
  TERMINAL_CONTENT_CLOSE,
  TERMINAL_CONTENT_OPEN,
} from './output.js';

describe('Обрамление вывода терминала', () => {
  it('оборачивает вывод в [CONTENT] … [CONTENT END]', () => {
    expect(frameTerminalOutput('hello')).toBe(
      `${TERMINAL_CONTENT_OPEN}\nhello\n${TERMINAL_CONTENT_CLOSE}`,
    );
  });

  it('пустой вывод — маркеры без пустой строки между ними', () => {
    expect(frameTerminalOutput('')).toBe(
      `${TERMINAL_CONTENT_OPEN}\n${TERMINAL_CONTENT_CLOSE}`,
    );
  });

  it('обрезает хвостовые пустые строки', () => {
    expect(normalizeTerminalOutput('a\nb\n\n\n')).toBe('a\nb');
    expect(normalizeTerminalOutput('a\nb\n')).toBe('a\nb');
    expect(normalizeTerminalOutput('a\nb')).toBe('a\nb');
  });

  it('пустая строка из одних пробелов тоже считается пустой', () => {
    expect(normalizeTerminalOutput('a\n   \n\t\n')).toBe('a');
  });

  it('нормализует CRLF в LF', () => {
    expect(normalizeTerminalOutput('a\r\nb\r\n')).toBe('a\nb');
    expect(normalizeTerminalLineEndings('a\r\nb')).toBe('a\nb');
  });

  it('одиночный \\r (возврат каретки) не трогает', () => {
    expect(normalizeTerminalOutput('50%\r100%')).toBe('50%\r100%');
  });

  it('обрамление убирает хвостовые пустые строки и CRLF', () => {
    expect(frameTerminalOutput('a\r\nb\r\n\r\n')).toBe(
      `${TERMINAL_CONTENT_OPEN}\na\nb\n${TERMINAL_CONTENT_CLOSE}`,
    );
  });
});
