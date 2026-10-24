/**
 * Тесты скоупа записи: `memory_write` наследует проект сессии.
 *
 * Правило (обратная сторона скоупа чтения, docs/MEMORY.md §3): проект сессии
 * задан → факт принадлежит **ему**, аргумент модели `projectId` игнорируется
 * (передан другой — не ошибка, приоритет у контекста сессии). Проект не задан →
 * поведение прежнее: аргумент модели разрешён, без него факт общий.
 *
 * Без этого правила факт, записанный в проекте A, либо уезжал в чужой проект
 * B, либо становился «общим» и утекал во все проекты сразу.
 */
import type { StorageContext } from '@itphx/synth-core';
import { describe, expect, it } from 'vitest';

import { MemoryProviderLite } from './provider.js';
import { createMemoryWriteTool } from './tools/write.js';
import { createTestFacade, createTestStorage, toolCtx } from './test-support.js';

/** Тул записи над настоящим in-memory хранилищем (фасад — тестовый). */
function makeWriteTool(): { write: ReturnType<typeof createMemoryWriteTool>; storage: StorageContext } {
  const storage = createTestStorage();
  const { facade } = createTestFacade({ storage });
  return { write: createMemoryWriteTool(new MemoryProviderLite(facade)), storage };
}

/** Прочитать записанный факт из хранилища по id. */
async function readFact(storage: StorageContext, factId: string) {
  const fact = await storage.memoryFacts.get(factId);
  if (!fact) throw new Error(`факт ${factId} не найден`);
  return fact;
}

describe('память: скоуп записи наследует проект сессии', () => {
  it('запись из проекта A без projectId в аргументах → факт принадлежит A', async () => {
    const { write, storage } = makeWriteTool();

    const written = await write.execute({ text: 'Деплой идёт через Fleet' }, toolCtx('s1', 'pA'));
    expect(written.isError).toBeUndefined();

    const fact = await readFact(storage, String(written.metadata?.factId));
    expect(fact.projectId).toBe('pA');
  });

  it('запись с projectId: B из проекта A → факт всё равно принадлежит A', async () => {
    const { write, storage } = makeWriteTool();

    const written = await write.execute(
      { text: 'Релиз только по тегу', projectId: 'pB' },
      toolCtx('s1', 'pA'),
    );
    expect(written.isError).toBeUndefined();

    const fact = await readFact(storage, String(written.metadata?.factId));
    expect(fact.projectId).toBe('pA');
  });

  it('сессия без проекта: аргумент модели по-прежнему задаёт владельца факта', async () => {
    const { write, storage } = makeWriteTool();

    const written = await write.execute(
      { text: 'Общее утверждение', projectId: 'pB' },
      toolCtx('s1'),
    );
    expect(written.isError).toBeUndefined();

    const fact = await readFact(storage, String(written.metadata?.factId));
    expect(fact.projectId).toBe('pB');
  });

  it('сессия без проекта и без аргумента → факт общий (без projectId)', async () => {
    const { write, storage } = makeWriteTool();

    const written = await write.execute({ text: 'Общее утверждение' }, toolCtx('s1'));
    expect(written.isError).toBeUndefined();

    const fact = await readFact(storage, String(written.metadata?.factId));
    expect(fact.projectId).toBeUndefined();
  });
});
