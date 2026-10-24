/**
 * М2: тесты чанкера (markdown-aware нарезка корпуса).
 *
 * Проверяются свойства, от которых зависит воспроизводимость индекса и
 * читаемость выдачи: детерминизм, границы строк, перекрытие, поведение на
 * длинном блоке и на заголовках markdown.
 */
import { describe, expect, it } from 'vitest';

import { CHUNKER_VERSION, chunkText } from './chunker.js';

/** Строки исходного текста (1-based). */
function linesOf(text: string): string[] {
  return text.split('\n');
}

describe('чанкер текста', () => {
  it('версия чанкера — константа (входит в фингерпринт индекса)', () => {
    expect(CHUNKER_VERSION).toBe('1');
  });

  it('одинаковый вход → одинаковые чанки (детерминизм)', () => {
    const text = [
      '# Заголовок',
      '',
      'Первый абзац про деплой и Fleet.',
      '',
      'Второй абзац про kubectl.',
    ].join('\n');
    const first = chunkText(text, { chunkChars: 40, chunkOverlap: 10 });
    const second = chunkText(text, { chunkChars: 40, chunkOverlap: 10 });
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it('пустой текст → ни одного чанка', () => {
    expect(chunkText('', { chunkChars: 100, chunkOverlap: 10 })).toEqual([]);
    expect(chunkText('   \n\n  ', { chunkChars: 100, chunkOverlap: 10 })).toEqual([]);
  });

  it('абзацы режутся по пустым строкам, заголовок — начало блока', () => {
    const text = ['# Title', '', 'Alpha beta gamma.', '', 'Delta epsilon.'].join('\n');
    const chunks = chunkText(text, { chunkChars: 500, chunkOverlap: 0 });

    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.text).toBe('# Title');
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(1);
    expect(chunks[1]!.text).toBe('Alpha beta gamma.');
    expect(chunks[1]!.startLine).toBe(3);
    expect(chunks[1]!.endLine).toBe(3);
    expect(chunks[2]!.text).toBe('Delta epsilon.');
    expect(chunks[2]!.startLine).toBe(5);
    expect(chunks[2]!.endLine).toBe(5);
  });

  it('границы строк совпадают с исходным текстом (чанк не режет строку)', () => {
    const text = ['# Title', '', 'первая строка', 'вторая строка', 'третья строка'].join('\n');
    const chunks = chunkText(text, { chunkChars: 500, chunkOverlap: 0 });
    const lines = linesOf(text);

    for (const chunk of chunks) {
      const slice = lines.slice(chunk.startLine - 1, chunk.endLine).join('\n');
      expect(chunk.text).toBe(slice);
    }
  });

  it('длинный блок режется по chunkChars с перекрытием', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `строка номер ${i + 1}`);
    const text = lines.join('\n');
    const chunks = chunkText(text, { chunkChars: 40, chunkOverlap: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    // Каждый чанк — не длиннее лимита (строки короче лимита).
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(40);
    // Перекрытие: хвост предыдущего чанка — начало следующего.
    const firstLines = chunks[0]!.text.split('\n');
    const secondLines = chunks[1]!.text.split('\n');
    const overlap = firstLines.filter((line) => secondLines.includes(line));
    expect(overlap.length).toBeGreaterThan(0);
    // Границы строк непрерывны и корректны.
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[chunks.length - 1]!.endLine).toBe(lines.length);
  });

  it('перекрытие не съедает блок целиком (прогресс гарантирован)', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    const chunks = chunkText(lines.join('\n'), { chunkChars: 20, chunkOverlap: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it('строка длиннее лимита остаётся целой', () => {
    const long = 'x'.repeat(500);
    const chunks = chunkText(long, { chunkChars: 100, chunkOverlap: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(long);
  });

  it('ordinal нумерует чанки документа подряд с нуля', () => {
    const text = ['# A', '', 'один', '', 'два', '', 'три'].join('\n');
    const chunks = chunkText(text, { chunkChars: 500, chunkOverlap: 0 });
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2, 3]);
  });
});
