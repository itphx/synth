/**
 * Общий предел вывода инструментов (`tools.outputMaxLines`/
 * `tools.outputMaxBytes`) — усечение результата тула.
 *
 * Проверяем чистую функцию `boundToolOutput`: усечение по строкам и по байтам
 * (срабатывает более жёсткий предел), счётчик строк исходного вывода и маркер
 * усечения с подстановкой `{shown}`/`{total}`.
 */

import { describe, it, expect } from 'vitest';
import { t as sm } from '../system-messages.js';
import { boundToolOutput } from './output-bound.js';

/** Байтовая длина строки (UTF-8). */
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

describe('boundToolOutput — общий предел вывода тула', () => {
  it('вывод ровно в лимит не усекается', () => {
    const content = 'a\nb\nc';
    const result = boundToolOutput(content, { maxLines: 3, maxBytes: 1000 });

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
    expect(result.shownLines).toBe(3);
    expect(result.totalLines).toBe(3);
  });

  it('вывод ровно в байтовый лимит не усекается', () => {
    const content = 'aaaa\nbb'; // 8 байт
    const result = boundToolOutput(content, { maxLines: 10, maxBytes: 8 });

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
    expect(result.totalLines).toBe(2);
  });

  it('превышение лимита строк: остаются первые строки, totalLines — все', () => {
    const content = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const result = boundToolOutput(content, { maxLines: 3, maxBytes: 1000 });

    expect(result.truncated).toBe(true);
    expect(result.shownLines).toBe(3);
    expect(result.totalLines).toBe(5);
    expect(result.content.startsWith('l1\nl2\nl3')).toBe(true);
    expect(result.content).not.toContain('l4');
  });

  it('превышение лимита байт: вывод обрезается по байтам', () => {
    const content = 'aaaa\nbbbb';
    const result = boundToolOutput(content, { maxLines: 10, maxBytes: 5 });

    expect(result.truncated).toBe(true);
    expect(result.shownLines).toBe(1);
    expect(result.totalLines).toBe(2);
    // Показанная часть укладывается в байтовый лимит.
    expect(bytes(result.content.split('\n\n')[0]!)).toBeLessThanOrEqual(5);
    expect(result.content.startsWith('aaaa')).toBe(true);
    expect(result.content).not.toContain('bbbb');
  });

  it('более жёсткий предел побеждает: строки укладываются, байты — нет', () => {
    // 4 строки по 10 байт: лимит строк не срабатывает, лимит байт — да.
    const content = ['0123456789', '0123456789', '0123456789', '0123456789'].join('\n');
    const result = boundToolOutput(content, { maxLines: 10, maxBytes: 25 });

    expect(result.truncated).toBe(true);
    expect(result.shownLines).toBe(2);
    expect(result.totalLines).toBe(4);
    expect(bytes(result.content.split('\n\n')[0]!)).toBeLessThanOrEqual(25);
  });

  it('многобайтовые символы: лимит считается в байтах, символ не разрезается', () => {
    const content = '😀😀\n😀😀'; // 16 байт, 2 строки
    const result = boundToolOutput(content, { maxLines: 10, maxBytes: 6 });

    expect(result.truncated).toBe(true);
    const kept = result.content.split('\n\n')[0]!;
    expect(bytes(kept)).toBeLessThanOrEqual(6);
    // Символ не разорван (нет «битых» сурогатных пар).
    expect(kept).toBe('😀');
    expect([...kept].every((ch) => ch === '😀')).toBe(true);
    expect(result.shownLines).toBe(1);
    expect(result.totalLines).toBe(2);
  });

  it('totalLines считает все строки исходного вывода', () => {
    const content = Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n');
    const result = boundToolOutput(content, { maxLines: 4, maxBytes: 1000 });

    expect(result.totalLines).toBe(10);
    expect(result.shownLines).toBe(4);
  });

  it('висящий перевод строки в конце не считается отдельной строкой', () => {
    const result = boundToolOutput('a\nb\n', { maxLines: 1, maxBytes: 1000 });

    expect(result.totalLines).toBe(2);
    expect(result.shownLines).toBe(1);
  });

  it('маркер усечения содержит число показанных и всех строк', () => {
    const content = ['l1', 'l2', 'l3', 'l4'].join('\n');
    const result = boundToolOutput(content, { maxLines: 2, maxBytes: 1000 });

    const marker = sm('tool.output_bounded', { shown: '2', total: '4' });
    expect(result.content).toContain(marker);
    expect(result.content.endsWith(marker)).toBe(true);
    // Маркер отделён пустой строкой от усечённого вывода.
    expect(result.content).toBe(`l1\nl2\n\n${marker}`);
    expect(marker).toContain('2');
    expect(marker).toContain('4');
  });

  it('пустой вывод не усекается', () => {
    const result = boundToolOutput('', { maxLines: 10, maxBytes: 100 });

    expect(result.truncated).toBe(false);
    expect(result.content).toBe('');
  });

  it('маркер усечения самого тула (tailNote) возвращается в конец вывода', () => {
    const note = '... (showing 4 of 9 matches)';
    const content = ['l1', 'l2', 'l3', 'l4', 'l5', note].join('\n');
    const result = boundToolOutput(content, { maxLines: 2, maxBytes: 1000 }, { tailNote: note });

    expect(result.truncated).toBe(true);
    // Маркер тула не потерян и не продублирован.
    expect(result.content.split(note).length - 1).toBe(1);
    expect(result.content).toContain(note);
    expect(result.content.endsWith(sm('tool.output_bounded', { shown: '2', total: '6' }))).toBe(true);
  });

  it('маркер тула, который бунд не срезал, не дублируется', () => {
    const note = '... (showing 1 of 1 matches)';
    const content = ['l1', note].join('\n');
    const result = boundToolOutput(content, { maxLines: 10, maxBytes: 1000 }, { tailNote: note });

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
    expect(result.content.split(note).length - 1).toBe(1);
  });

  it('несколько маркеров тула (tailNote[]) возвращаются в хвост усечённого вывода', () => {
    // Тул оставил два маркера: «показаны не все совпадения» и «скрыто совпадений
    // в исключённых путях». Общий бунд срезает хвост — оба маркера должны
    // дойти до модели.
    const truncation = '... (showing 4 of 9 matches)';
    const excluded = '... (1 matches hidden: excluded paths were skipped — node_modules)';
    const content = ['l1', 'l2', 'l3', 'l4', 'l5', truncation, excluded].join('\n');
    const result = boundToolOutput(content, { maxLines: 2, maxBytes: 1000 }, { tailNote: [truncation, excluded] });

    expect(result.truncated).toBe(true);
    expect(result.content).toContain(truncation);
    expect(result.content).toContain(excluded);
    // Каждый маркер — ровно один раз.
    expect(result.content.split(truncation).length - 1).toBe(1);
    expect(result.content.split(excluded).length - 1).toBe(1);
    expect(result.content.endsWith(sm('tool.output_bounded', { shown: '2', total: '7' }))).toBe(true);
  });

  it('маркеры, которые бунд не срезал, не дублируются (список)', () => {
    const truncation = '... (showing 1 of 1 matches)';
    const excluded = '... (1 matches hidden: excluded paths were skipped — node_modules)';
    const content = ['l1', truncation, excluded].join('\n');
    const result = boundToolOutput(content, { maxLines: 10, maxBytes: 1000 }, { tailNote: [truncation, excluded] });

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
    expect(result.content.split(truncation).length - 1).toBe(1);
    expect(result.content.split(excluded).length - 1).toBe(1);
  });

  it('некорректные лимиты не ломают функцию (минимум 1)', () => {
    const result = boundToolOutput('a\nb', { maxLines: 0, maxBytes: 0 });

    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(2);
    expect(result.shownLines).toBeLessThanOrEqual(1);
  });
});
