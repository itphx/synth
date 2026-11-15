/**
 * PROP-132 (Ф5): обрамление и нормализация вывода терминала для модели
 * (`engine/terminal/output.ts`).
 *
 * Проверяется:
 *   • обрамление `[CONTENT]` … `[CONTENT END]` (константы протокола, не i18n);
 *   • обрезка хвостовых пустых строк;
 *   • нормализация `\r\n` → `\n` (только возвращаемый текст — буфер не трогаем);
 *   • одиночный `\r` (возврат каретки прогрес-вывода) не трогаем;
 *   • очистка вывода запуска: ANSI/OSC целиком, backspace, «широкие» пробелы,
 *     точное эхо строки-обёртки (`cleanRunOutput`).
 */
import { describe, it, expect } from 'vitest';
import {
  cleanRunOutput,
  frameTerminalOutput,
  normalizeTerminalLineEndings,
  normalizeTerminalOutput,
  removeRunWrapper,
  stripTerminalAnsi,
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

describe('Очистка вывода запуска', () => {
  it('stripTerminalAnsi: CSI и OSC вырезаются целиком', () => {
    expect(stripTerminalAnsi('\u001B[32mok\u001B[0m')).toBe('ok');
    // OSC до BEL.
    expect(stripTerminalAnsi('a\u001B]0;window title\u0007b')).toBe('ab');
    // OSC до ST (`ESC \`).
    expect(stripTerminalAnsi('a\u001B]3008;t\u001B\\b')).toBe('ab');
  });

  it('stripTerminalAnsi: backspace удаляет символ, одиночный \\r вырезан', () => {
    expect(stripTerminalAnsi('ab\bc')).toBe('ac');
    expect(stripTerminalAnsi('\bab')).toBe('ab');
    expect(stripTerminalAnsi('50%\r100%')).toBe('50%100%');
    expect(stripTerminalAnsi('a\r\nb')).toBe('a\r\nb');
  });

  it('stripTerminalAnsi: «широкие» вставки пробелов схлопываются', () => {
    expect(stripTerminalAnsi(`a${' '.repeat(80)}b`)).toBe('a b');
    // Обычный отступ (≤40) сохраняется.
    expect(stripTerminalAnsi(`a${' '.repeat(40)}b`)).toBe(`a${' '.repeat(40)}b`);
  });

  it('removeRunWrapper: удаляет точное эхо строки целиком', () => {
    const wrapper = "printf '\\n@@srn-abc:%s@@\\n' \"$?\"";
    const text = ['out1', wrapper, 'out2'].join('\n');
    expect(removeRunWrapper(text, wrapper)).toBe('out1\nout2');
    // Эхо с промптом оболочки в той же строке — тоже эхо обёртки.
    expect(removeRunWrapper(`out1\nuser@host:~$ ${wrapper}\nout2`, wrapper)).toBe(
      'out1\nout2',
    );
    // «Похожая» строка (текст вывода, не эхо) не трогается.
    expect(removeRunWrapper(`out1\n${wrapper}.bak\nout2`, wrapper)).toBe(
      `out1\n${wrapper}.bak\nout2`,
    );
    // Пустая обёртка — очистка не выполняется.
    expect(removeRunWrapper('a\nb', '')).toBe('a\nb');
  });

  it('removeRunWrapper: строка-маркер и обрывки вырезаются по nonce', () => {
    const wrapper = "printf '\\n@@srn-abc:%s@@\\n' \"$?\"";
    const text = [
      'out1',
      '@@srn-abc:0@@', // полный маркер
      '@@srn-abc:7', // обрывок без закрывающих `@@`
      '@@srn-abc', // обрывок, оборванный внутри `<nonce>:`
      '@@srn-other:0@@', // чужой nonce — не наш маркер
      'out2',
    ].join('\n');
    expect(removeRunWrapper(text, wrapper)).toBe('out1\n@@srn-other:0@@\nout2');
    // Nonce можно передать явно — сравнение то же.
    expect(removeRunWrapper('@@srn-abc:0@@\nout', '', 'abc')).toBe('out');
    // Без nonce и без обёртки — очистка не выполняется.
    expect(removeRunWrapper('@@srn-abc:0@@', '')).toBe('@@srn-abc:0@@');
  });

  it('cleanRunOutput: strip → removeWrapper → normalize', () => {
    const wrapper = "printf '\\n@@srn-abc:%s@@\\n' \"$?\"";
    const raw = `\u001B[1m$ ls\u001B[0m\r\n${wrapper}\r\nfile1\r\nfile2\r\n\r\n`;
    expect(cleanRunOutput(raw, wrapper)).toBe('$ ls\nfile1\nfile2');
    // Без обёртки — только ANSI/нормализация.
    expect(cleanRunOutput('\u001B[31mx\u001B[0m\r\n', undefined)).toBe('x');
  });

  it('cleanRunOutput: строка-маркер (и обрывок) вырезается из вывода', () => {
    const wrapper = "printf '\\n@@srn-abc:%s@@\\n' \"$?\"";
    const raw = [
      '\u001B[2K@@srn-abc:0@@\r\n',
      'file1\r\n',
      '@@srn-abc:3\r\n',
      'file2\r\n',
    ].join('');
    expect(cleanRunOutput(raw, wrapper)).toBe('file1\nfile2');
    // Явный nonce — тот же результат (маркер мог не попасть в обёртку).
    expect(cleanRunOutput('@@srn-abc:0@@\r\nfile1\r\n', undefined, 'abc')).toBe('file1');
  });
});
