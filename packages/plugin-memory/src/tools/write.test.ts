/**
 * Тесты тула `memory_write` (явная запись факта).
 *
 * Проверяется контракт валидации аргументов: невалидные аргументы дают
 * `isError` с понятным текстом, а не падение хода (ADR-090).
 */
import { describe, expect, it } from 'vitest';

import { MemoryProviderLite } from '../provider.js';
import { createTestFacade, toolCtx } from '../test-support.js';
import { createMemoryWriteTool, MEMORY_WRITE_TOOL_NAME } from './write.js';

describe('тул memory_write', () => {
  it('имя тула и capability — как в манифесте', () => {
    const { facade } = createTestFacade();
    const tool = createMemoryWriteTool(new MemoryProviderLite(facade));
    expect(tool.name).toBe(MEMORY_WRITE_TOOL_NAME);
    expect(tool.capabilities).toEqual(['memory']);
  });

  it('невалидные аргументы → isError с понятным текстом', async () => {
    const { facade } = createTestFacade();
    const tool = createMemoryWriteTool(new MemoryProviderLite(facade));

    const result = await tool.execute({ text: '' }, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Некорректные аргументы');
    expect(result.content).toContain('text');
  });

  it('неизвестный вид факта → isError', async () => {
    const { facade } = createTestFacade();
    const tool = createMemoryWriteTool(new MemoryProviderLite(facade));

    const result = await tool.execute({ text: 'факт', kind: 'unknown' }, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Некорректные аргументы');
    expect(result.content).toContain('kind');
  });

  it('валидные аргументы → факт записан', async () => {
    const { facade } = createTestFacade();
    const tool = createMemoryWriteTool(new MemoryProviderLite(facade));

    const result = await tool.execute(
      { text: 'Деплой идёт через Fleet', kind: 'decision', confidence: 0.9 },
      toolCtx(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Факт сохранён в память');
  });
});
