import { describe, expect, it } from 'vitest';
import type {
  MemoryChunkRecord,
  MemoryFactRecord,
  MemoryFactRepository,
  MemoryIndexRecord,
  MemoryIndexRepository,
} from '../ports/index.js';

/** Факт памяти для контрактного прогона. */
function fact(id: string, overrides: Partial<MemoryFactRecord> = {}): MemoryFactRecord {
  return {
    id,
    namespace: 'plugin:synth-plugin-memory',
    version: 1,
    text: `утверждение ${id}`,
    kind: 'decision',
    projectId: 'project-1',
    provenance: {
      sourceKind: 'session',
      sourceId: 'session-1',
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
    confidence: 0.8,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Индекс памяти для контрактного прогона. */
function index(id: string, overrides: Partial<MemoryIndexRecord> = {}): MemoryIndexRecord {
  return {
    id,
    namespace: 'plugin:synth-plugin-memory',
    name: id,
    providerId: 'plugin:synth-plugin-memory',
    projectId: 'project-1',
    scope: 'project',
    source: { kind: 'project', filter: '**/*.ts' },
    state: 'building',
    generation: 1,
    fingerprint: {
      model: 'text-embed-small',
      dimension: 384,
      normalize: true,
      chunkerVersion: 'v1',
      wrapTier: 'default',
    },
    stats: { documents: 0, chunks: 0, updatedAt: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Чанк индекса для контрактного прогона. */
function chunk(
  indexId: string,
  generation: number,
  id: string,
  overrides: Partial<MemoryChunkRecord> = {},
): MemoryChunkRecord {
  return {
    indexId,
    generation,
    id,
    documentId: 'doc-1',
    ordinal: 0,
    text: `чанк ${id}`,
    vector: [0.1, 0.2, 0.3],
    embeddingInputHash: `hash-${id}`,
    ...overrides,
  };
}

/**
 * Паспорт порта `MemoryFactRepository` (PROP-047 §2.1, ADR-096).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - upsert по `id` (`createdAt` не теряется, `updatedAt` обновляется), чтение;
 * - фильтры `namespace`/`projectId`/`userId`/`status`/`kind` — по «И»;
 * - пагинация `limit`/`offset` и детерминированный порядок списка;
 * - `delete` — `true`/`false`, `count` — по тем же фильтрам;
 * - `supersede` — помечает факт заменённым и **идемпотентен**;
 * - версия факта и история ревизий сохраняются как есть.
 */
export function describeMemoryFactRepository(
  name: string,
  make: () => Promise<{ repo: MemoryFactRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('факт: сохранение, чтение и upsert (createdAt иммутабельно)', async () => {
      const { repo } = await make();
      expect(await repo.get('fact-1')).toBeNull();

      await repo.save(fact('fact-1'));
      const saved = await repo.get('fact-1');
      expect(saved?.namespace).toBe('plugin:synth-plugin-memory');
      expect(saved?.text).toBe('утверждение fact-1');
      expect(saved?.kind).toBe('decision');
      expect(saved?.status).toBe('active');
      expect(saved?.confidence).toBe(0.8);
      expect(saved?.provenance.sourceKind).toBe('session');
      expect(saved?.createdAt).toBe('2026-01-01T00:00:00.000Z');

      // Перезапись: `createdAt` сохраняется, `updatedAt` обновляется.
      await repo.save(
        fact('fact-1', {
          text: 'уточнённое утверждение',
          version: 2,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        }),
      );
      const updated = await repo.get('fact-1');
      expect(updated?.text).toBe('уточнённое утверждение');
      expect(updated?.version).toBe(2);
      expect(updated?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(updated?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    });

    it('факты: фильтры namespace/project/status/kind работают по «И»', async () => {
      const { repo } = await make();
      await repo.save(fact('fact-1', { namespace: 'plugin:a', projectId: 'project-1', kind: 'decision' }));
      await repo.save(fact('fact-2', { namespace: 'plugin:a', projectId: 'project-2', kind: 'constraint' }));
      await repo.save(
        fact('fact-3', {
          namespace: 'plugin:b',
          projectId: 'project-1',
          kind: 'decision',
          status: 'candidate',
        }),
      );
      await repo.save(
        fact('fact-4', {
          namespace: 'plugin:b',
          projectId: 'project-1',
          kind: 'decision',
          userId: 'user-1',
        }),
      );

      expect((await repo.list()).map((f) => f.id).sort()).toEqual([
        'fact-1',
        'fact-2',
        'fact-3',
        'fact-4',
      ]);
      expect((await repo.list({ namespace: 'plugin:a' })).map((f) => f.id).sort()).toEqual([
        'fact-1',
        'fact-2',
      ]);
      expect((await repo.list({ projectId: 'project-1' })).map((f) => f.id).sort()).toEqual([
        'fact-1',
        'fact-3',
        'fact-4',
      ]);
      expect((await repo.list({ kind: 'constraint' })).map((f) => f.id)).toEqual(['fact-2']);
      expect((await repo.list({ userId: 'user-1' })).map((f) => f.id)).toEqual(['fact-4']);
      expect((await repo.list({ status: 'candidate' })).map((f) => f.id)).toEqual(['fact-3']);
      // Статус — список: попадают оба.
      expect(
        (await repo.list({ status: ['candidate', 'active'] })).map((f) => f.id).sort(),
      ).toEqual(['fact-1', 'fact-2', 'fact-3', 'fact-4']);
      // AND: namespace И статус.
      expect((await repo.list({ namespace: 'plugin:b', status: 'candidate' })).map((f) => f.id)).toEqual([
        'fact-3',
      ]);
      // Несовпадение фильтра — пустой список (не ошибка).
      expect(await repo.list({ namespace: 'plugin:missing' })).toEqual([]);
    });

    it('факты: порядок «свежие первыми» и пагинация limit/offset', async () => {
      const { repo } = await make();
      await repo.save(fact('fact-old', { createdAt: '2026-01-01T00:00:00.000Z' }));
      await repo.save(fact('fact-mid', { createdAt: '2026-02-01T00:00:00.000Z' }));
      await repo.save(fact('fact-new', { createdAt: '2026-03-01T00:00:00.000Z' }));

      expect((await repo.list()).map((f) => f.id)).toEqual(['fact-new', 'fact-mid', 'fact-old']);
      expect((await repo.list({ limit: 2 })).map((f) => f.id)).toEqual(['fact-new', 'fact-mid']);
      expect((await repo.list({ offset: 1 })).map((f) => f.id)).toEqual(['fact-mid', 'fact-old']);
      expect((await repo.list({ limit: 1, offset: 1 })).map((f) => f.id)).toEqual(['fact-mid']);
      // Повторный вызов — тот же порядок (детерминированность).
      expect((await repo.list()).map((f) => f.id)).toEqual(['fact-new', 'fact-mid', 'fact-old']);
    });

    it('факт: удаление — true/false', async () => {
      const { repo } = await make();
      expect(await repo.delete('fact-1')).toBe(false);

      await repo.save(fact('fact-1'));
      expect(await repo.delete('fact-1')).toBe(true);
      expect(await repo.get('fact-1')).toBeNull();
      expect(await repo.delete('fact-1')).toBe(false);
    });

    it('факт: supersede помечает заменённым и идемпотентен', async () => {
      const { repo } = await make();
      // Отсутствующий факт — `false` (не ошибка).
      expect(await repo.supersede('missing', 'fact-2')).toBe(false);

      await repo.save(fact('fact-1'));
      expect(await repo.supersede('fact-1', 'fact-2')).toBe(true);

      const superseded = await repo.get('fact-1');
      expect(superseded?.status).toBe('superseded');
      expect(superseded?.supersededBy).toBe('fact-2');

      // Идемпотентность: повторный вызов с тем же `nextId` — тот же результат.
      expect(await repo.supersede('fact-1', 'fact-2')).toBe(true);
      const again = await repo.get('fact-1');
      expect(again?.status).toBe('superseded');
      expect(again?.supersededBy).toBe('fact-2');
    });

    it('факты: count считает под фильтрами (limit/offset не влияют)', async () => {
      const { repo } = await make();
      expect(await repo.count()).toBe(0);

      await repo.save(fact('fact-1', { namespace: 'plugin:a' }));
      await repo.save(fact('fact-2', { namespace: 'plugin:a', kind: 'constraint' }));
      await repo.save(fact('fact-3', { namespace: 'plugin:b' }));

      expect(await repo.count()).toBe(3);
      expect(await repo.count({ namespace: 'plugin:a' })).toBe(2);
      expect(await repo.count({ namespace: 'plugin:a', kind: 'constraint' })).toBe(1);
      expect(await repo.count({ namespace: 'plugin:missing' })).toBe(0);
      // `limit`/`offset` на подсчёт не влияют.
      expect(await repo.count({ limit: 1 })).toBe(3);
      expect(await repo.count({ offset: 2 })).toBe(3);
    });

    it('факт: версия и история ревизий сохраняются', async () => {
      const { repo } = await make();
      await repo.save(
        fact('fact-1', {
          version: 1,
          revisions: [
            {
              version: 1,
              text: 'первая формулировка',
              changedAt: '2026-01-01T00:00:00.000Z',
              reason: 'извлечено из сессии',
            },
          ],
        }),
      );
      expect((await repo.get('fact-1'))?.revisions).toHaveLength(1);

      await repo.save(
        fact('fact-1', {
          version: 2,
          revisions: [
            {
              version: 1,
              text: 'первая формулировка',
              changedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              version: 2,
              text: 'вторая формулировка',
              changedAt: '2026-02-01T00:00:00.000Z',
              reason: 'коррекция',
            },
          ],
        }),
      );

      const stored = await repo.get('fact-1');
      expect(stored?.version).toBe(2);
      expect(stored?.revisions).toHaveLength(2);
      expect(stored?.revisions?.[1]?.text).toBe('вторая формулировка');
      expect(stored?.revisions?.[1]?.reason).toBe('коррекция');
    });
  });
}

/**
 * Паспорт порта `MemoryIndexRepository` (PROP-047 §2.1, ADR-096).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - индексы — upsert по `id` (`createdAt` не теряется), чтение, фильтры
 *   `namespace`/`projectId`/`scope`/`providerId`/`state`, пагинация, удаление;
 * - область видимости (`scope`) — сохраняется при записи и при upsert, фильтр
 *   `listIndexes({scope})` отбирает записи по области;
 * - `setState` — смена состояния (с ошибкой), для отсутствующего — `false`;
 * - чанки — `replaceChunks` **атомарно заменяет поколение** (старое поколение
 *   не трогается), `listChunks` с фильтрами и пагинацией, `deleteChunks`,
 *   `countChunks`;
 * - `deleteIndex` удаляет чанки индекса **каскадом**.
 */
export function describeMemoryIndexRepository(
  name: string,
  make: () => Promise<{ repo: MemoryIndexRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('индекс: сохранение, чтение и upsert (createdAt иммутабельно)', async () => {
      const { repo } = await make();
      expect(await repo.getIndex('index-1')).toBeNull();

      await repo.saveIndex(index('index-1'));
      const saved = await repo.getIndex('index-1');
      expect(saved?.name).toBe('index-1');
      expect(saved?.namespace).toBe('plugin:synth-plugin-memory');
      expect(saved?.providerId).toBe('plugin:synth-plugin-memory');
      expect(saved?.state).toBe('building');
      expect(saved?.generation).toBe(1);
      expect(saved?.source.kind).toBe('project');
      expect(saved?.fingerprint.dimension).toBe(384);
      expect(saved?.createdAt).toBe('2026-01-01T00:00:00.000Z');

      // Перезапись: `createdAt` сохраняется, `updatedAt` обновляется.
      await repo.saveIndex(
        index('index-1', {
          name: 'переименованный',
          generation: 2,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        }),
      );
      const updated = await repo.getIndex('index-1');
      expect(updated?.name).toBe('переименованный');
      expect(updated?.generation).toBe(2);
      expect(updated?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(updated?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    });

    it('индексы: фильтры namespace/project/provider/state работают по «И»', async () => {
      const { repo } = await make();
      await repo.saveIndex(index('index-1', { namespace: 'plugin:a', projectId: 'project-1' }));
      await repo.saveIndex(
        index('index-2', {
          namespace: 'plugin:a',
          projectId: 'project-2',
          providerId: 'plugin:other',
          state: 'ready',
        }),
      );
      await repo.saveIndex(index('index-3', { namespace: 'plugin:b', state: 'failed' }));

      expect((await repo.listIndexes()).map((i) => i.id).sort()).toEqual([
        'index-1',
        'index-2',
        'index-3',
      ]);
      expect((await repo.listIndexes({ namespace: 'plugin:a' })).map((i) => i.id).sort()).toEqual([
        'index-1',
        'index-2',
      ]);
      expect((await repo.listIndexes({ projectId: 'project-2' })).map((i) => i.id)).toEqual(['index-2']);
      expect((await repo.listIndexes({ providerId: 'plugin:other' })).map((i) => i.id)).toEqual([
        'index-2',
      ]);
      expect((await repo.listIndexes({ state: 'failed' })).map((i) => i.id)).toEqual(['index-3']);
      expect(
        (await repo.listIndexes({ state: ['ready', 'failed'] })).map((i) => i.id).sort(),
      ).toEqual(['index-2', 'index-3']);
      // AND: namespace И состояние.
      expect(
        (await repo.listIndexes({ namespace: 'plugin:a', state: 'ready' })).map((i) => i.id),
      ).toEqual(['index-2']);
      expect(await repo.listIndexes({ namespace: 'plugin:missing' })).toEqual([]);
    });

    it('индекс: область видимости сохраняется (roundtrip)', async () => {
      const { repo } = await make();
      await repo.saveIndex(index('index-instance', { scope: 'instance', projectId: undefined }));

      const saved = await repo.getIndex('index-instance');
      expect(saved?.scope).toBe('instance');
      // Запись без проекта (источник корпуса — не проект) допустима.
      expect(saved?.projectId).toBeUndefined();

      const listed = await repo.listIndexes({ scope: 'instance' });
      expect(listed.map((i) => i.id)).toEqual(['index-instance']);
      expect(listed[0]?.scope).toBe('instance');
    });

    it('индексы: фильтр по области видимости (scope)', async () => {
      const { repo } = await make();
      await repo.saveIndex(index('index-project', { scope: 'project', projectId: 'project-1' }));
      await repo.saveIndex(index('index-instance', { scope: 'instance', projectId: 'project-1' }));

      expect((await repo.listIndexes({ scope: 'project' })).map((i) => i.id)).toEqual([
        'index-project',
      ]);
      expect((await repo.listIndexes({ scope: 'instance' })).map((i) => i.id)).toEqual([
        'index-instance',
      ]);
      // Без фильтра — оба.
      expect((await repo.listIndexes()).map((i) => i.id).sort()).toEqual([
        'index-instance',
        'index-project',
      ]);
      // AND: область видимости И проект.
      expect(
        (await repo.listIndexes({ scope: 'instance', projectId: 'project-1' })).map((i) => i.id),
      ).toEqual(['index-instance']);
      expect(await repo.listIndexes({ scope: 'instance', projectId: 'project-2' })).toEqual([]);
    });

    it('индекс: upsert не сбрасывает область видимости', async () => {
      const { repo } = await make();
      await repo.saveIndex(index('index-1', { scope: 'instance' }));

      await repo.saveIndex(
        index('index-1', { scope: 'instance', name: 'переименованный', generation: 2 }),
      );
      const updated = await repo.getIndex('index-1');
      expect(updated?.scope).toBe('instance');
      expect(updated?.name).toBe('переименованный');
      expect(updated?.generation).toBe(2);

      // Смена области видимости — только явная (значение из записи).
      await repo.saveIndex(index('index-1', { scope: 'project' }));
      expect((await repo.getIndex('index-1'))?.scope).toBe('project');
    });

    it('enabled: false сохраняется, true/undefined — читаются как включённые', async () => {
      const { repo } = await make();
      await repo.saveIndex(index('index-off', { enabled: false }));
      await repo.saveIndex(index('index-on', { enabled: true }));
      await repo.saveIndex(index('index-legacy'));

      expect((await repo.getIndex('index-off'))?.enabled).toBe(false);
      expect((await repo.getIndex('index-on'))?.enabled).not.toBe(false);
      expect((await repo.getIndex('index-legacy'))?.enabled).not.toBe(false);
    });

    it('индексы: порядок «свежие первыми» и пагинация', async () => {
      const { repo } = await make();
      await repo.saveIndex(index('index-old', { createdAt: '2026-01-01T00:00:00.000Z' }));
      await repo.saveIndex(index('index-mid', { createdAt: '2026-02-01T00:00:00.000Z' }));
      await repo.saveIndex(index('index-new', { createdAt: '2026-03-01T00:00:00.000Z' }));

      expect((await repo.listIndexes()).map((i) => i.id)).toEqual([
        'index-new',
        'index-mid',
        'index-old',
      ]);
      expect((await repo.listIndexes({ limit: 2 })).map((i) => i.id)).toEqual(['index-new', 'index-mid']);
      expect((await repo.listIndexes({ offset: 1 })).map((i) => i.id)).toEqual(['index-mid', 'index-old']);
    });

    it('индекс: setState меняет состояние и текст ошибки', async () => {
      const { repo } = await make();
      // Отсутствующий индекс — `false` (не ошибка).
      expect(await repo.setState('missing', 'ready')).toBe(false);

      await repo.saveIndex(index('index-1'));
      expect(await repo.setState('index-1', 'failed', 'эмбеддинг не удался')).toBe(true);

      const failed = await repo.getIndex('index-1');
      expect(failed?.state).toBe('failed');
      expect(failed?.error).toBe('эмбеддинг не удался');

      expect(await repo.setState('index-1', 'ready')).toBe(true);
      const ready = await repo.getIndex('index-1');
      expect(ready?.state).toBe('ready');
    });

    it('чанки: replaceChunks заменяет поколение, старое не трогается', async () => {
      const { repo } = await make();
      await repo.saveIndex(index('index-1'));

      expect(await repo.replaceChunks('index-1', 1, [
        chunk('index-1', 1, 'chunk-1', { ordinal: 0 }),
        chunk('index-1', 1, 'chunk-2', { ordinal: 1 }),
      ])).toBe(2);
      expect(await repo.countChunks('index-1', 1)).toBe(2);

      // Новое поколение — рядом, старое остаётся целым.
      expect(await repo.replaceChunks('index-1', 2, [
        chunk('index-1', 2, 'chunk-3', { ordinal: 0 }),
      ])).toBe(1);
      expect(await repo.countChunks('index-1')).toBe(3);
      expect(await repo.countChunks('index-1', 1)).toBe(2);
      expect(await repo.countChunks('index-1', 2)).toBe(1);
      expect((await repo.listChunks('index-1', { generation: 1 })).map((c) => c.id)).toEqual([
        'chunk-1',
        'chunk-2',
      ]);

      // Повторная запись того же поколения **заменяет** его, а не дописывает.
      expect(await repo.replaceChunks('index-1', 2, [
        chunk('index-1', 2, 'chunk-4', { ordinal: 0 }),
      ])).toBe(1);
      expect(await repo.countChunks('index-1', 2)).toBe(1);
      expect((await repo.listChunks('index-1', { generation: 2 })).map((c) => c.id)).toEqual([
        'chunk-4',
      ]);
      // Старое поколение по-прежнему на месте.
      expect(await repo.countChunks('index-1', 1)).toBe(2);
    });

    it('чанки: listChunks с фильтрами и пагинацией', async () => {
      const { repo } = await make();
      await repo.saveIndex(index('index-1'));
      await repo.replaceChunks('index-1', 1, [
        chunk('index-1', 1, 'chunk-1', { documentId: 'doc-1', ordinal: 0 }),
        chunk('index-1', 1, 'chunk-2', { documentId: 'doc-1', ordinal: 1 }),
        chunk('index-1', 1, 'chunk-3', { documentId: 'doc-2', ordinal: 0 }),
      ]);

      expect((await repo.listChunks('index-1')).map((c) => c.id)).toEqual([
        'chunk-1',
        'chunk-2',
        'chunk-3',
      ]);
      expect((await repo.listChunks('index-1', { documentId: 'doc-1' })).map((c) => c.id)).toEqual([
        'chunk-1',
        'chunk-2',
      ]);
      expect((await repo.listChunks('index-1', { limit: 2 })).map((c) => c.id)).toEqual([
        'chunk-1',
        'chunk-2',
      ]);
      expect((await repo.listChunks('index-1', { offset: 1 })).map((c) => c.id)).toEqual([
        'chunk-2',
        'chunk-3',
      ]);
      expect((await repo.listChunks('index-1', { offset: 1, limit: 1 })).map((c) => c.id)).toEqual([
        'chunk-2',
      ]);
      // Чанк другого индекса не виден.
      expect(await repo.listChunks('index-other')).toEqual([]);
    });

    it('чанки: deleteChunks удаляет поколение (или все) и возвращает число', async () => {
      const { repo } = await make();
      await repo.saveIndex(index('index-1'));
      await repo.replaceChunks('index-1', 1, [
        chunk('index-1', 1, 'chunk-1'),
        chunk('index-1', 1, 'chunk-2'),
      ]);
      await repo.replaceChunks('index-1', 2, [chunk('index-1', 2, 'chunk-3')]);

      expect(await repo.deleteChunks('index-1', 1)).toBe(2);
      expect(await repo.countChunks('index-1')).toBe(1);
      expect(await repo.countChunks('index-1', 1)).toBe(0);

      // Без поколения — удаляются все поколения индекса.
      expect(await repo.deleteChunks('index-1')).toBe(1);
      expect(await repo.countChunks('index-1')).toBe(0);
      // Повторное удаление — ноль (не ошибка).
      expect(await repo.deleteChunks('index-1')).toBe(0);
    });

    it('индекс: deleteIndex каскадно удаляет чанки', async () => {
      const { repo } = await make();
      expect(await repo.deleteIndex('index-1')).toBe(false);

      await repo.saveIndex(index('index-1'));
      await repo.replaceChunks('index-1', 1, [chunk('index-1', 1, 'chunk-1')]);

      expect(await repo.deleteIndex('index-1')).toBe(true);
      expect(await repo.getIndex('index-1')).toBeNull();
      expect(await repo.countChunks('index-1')).toBe(0);
      expect(await repo.listChunks('index-1')).toEqual([]);
      expect(await repo.deleteIndex('index-1')).toBe(false);
    });
  });
}
