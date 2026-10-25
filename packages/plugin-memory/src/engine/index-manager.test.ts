/**
 * М2: тесты менеджера индексов памяти (жизненный цикл корпуса).
 *
 * Проверяются: сборка files-индекса из временного каталога, поколения
 * (1 → 2) и удаление старого поколения после переключения, корректность
 * статистики, деградация в `failed` при ошибке эмбеддинга и переход индекса в
 * `stale` при смене модели/размерности эмбеддинга.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StorageContext } from '@itphx/synth-core';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoryProviderLite } from '../provider.js';
import { createTestFacade, createTestStorage, fakeEmbed } from '../test-support.js';

/** Временные каталоги — убираются после каждого теста. */
const tempDirs: string[] = [];

/** Создать временный каталог корпуса. */
async function makeCorpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-memory-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'deploy.md'), '# Деплой\n\nДеплой идёт через Fleet.\n', 'utf-8');
  await writeFile(join(dir, 'notes.txt'), 'Заметка про провайдера itphx.\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', 'ignored.md'), 'не индексируем\n', 'utf-8');
  await writeFile(join(dir, 'binary.bin'), 'ignored\n', 'utf-8');
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Провайдер с заданной размерностью эмбеддингов. */
function makeProvider(
  storage: StorageContext,
  options: { dimension?: number; embed?: (texts: readonly string[]) => Promise<number[][]> } = {},
): MemoryProviderLite {
  const { facade } = createTestFacade({
    storage,
    settings: { dimensionProbeTtlMs: 0 },
    ...(options.embed ? { embed: options.embed } : {}),
    ...(options.dimension !== undefined ? { embedDimension: options.dimension } : {}),
  });
  return new MemoryProviderLite(facade);
}

/** Засеять факт в памяти плагина (namespace навязывает хост). */
async function seedFact(
  storage: StorageContext,
  over: { id: string; text: string; projectId?: string },
): Promise<void> {
  const ts = '2026-10-24T10:00:00.000Z';
  await storage.memoryFacts.save({
    id: over.id,
    namespace: 'plugin:synth-plugin-memory',
    version: 1,
    text: over.text,
    kind: 'observation',
    ...(over.projectId ? { projectId: over.projectId } : {}),
    provenance: { sourceKind: 'session', sourceId: 's1', capturedAt: ts },
    confidence: 0.8,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  });
}

describe('менеджер индексов: сборка корпуса', () => {
  it('files-индекс собирается в фоне: состояние building → ready', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const provider = makeProvider(storage);

    const created = await provider.createIndex({
      name: 'project',
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: dir,
    });
    // Вызов не ждёт сборки — запись возвращается сразу.
    expect(created.state).toBe('building');
    expect(created.index.id).toMatch(/^idx_/);
    expect(created.index.providerId).toBe('plugin:synth-plugin-memory');

    await provider.indexManager.whenIdle();

    const status = await provider.getIndex(created.index.id);
    expect(status).not.toBeNull();
    expect(status!.state).toBe('ready');
    expect(status!.index.generation).toBe(1);
    // Два текстовых файла корпуса (node_modules и бинарный — пропущены).
    expect(status!.index.stats.documents).toBe(2);
    expect(status!.index.stats.chunks).toBeGreaterThan(0);
    expect(status!.index.fingerprint.dimension).toBe(8);
    expect(status!.index.fingerprint.chunkerVersion).toBe('1');
  });

  it('чанки индекса несут вектор, хэш входа эмбеддинга и путь', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const provider = makeProvider(storage);

    const created = await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: dir,
    });
    await provider.indexManager.whenIdle();

    const chunks = await storage.memoryIndexes.listChunks(created.index.id, { generation: 1 });
    expect(chunks.length).toBeGreaterThan(0);
    const chunk = chunks[0]!;
    expect(chunk.vector?.length).toBe(8);
    expect(chunk.embeddingInputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof chunk.metadata?.path).toBe('string');
    expect(typeof chunk.metadata?.startLine).toBe('number');
    expect(typeof chunk.metadata?.endLine).toBe('number');
    // Пути — относительные POSIX.
    expect(String(chunk.metadata?.path)).not.toContain('\\');
  });

  it('пересборка: поколение 1 → 2, старое поколение удаляется после переключения', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const provider = makeProvider(storage);

    const created = await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: dir,
    });
    await provider.indexManager.whenIdle();
    expect(await storage.memoryIndexes.countChunks(created.index.id, 1)).toBeGreaterThan(0);

    await provider.rebuildIndex(created.index.id, { workingDir: dir });
    await provider.indexManager.whenIdle();

    const status = await provider.getIndex(created.index.id);
    expect(status!.state).toBe('ready');
    expect(status!.index.generation).toBe(2);
    // Прежнее поколение удалено, новое — на месте.
    expect(await storage.memoryIndexes.countChunks(created.index.id, 1)).toBe(0);
    expect(await storage.memoryIndexes.countChunks(created.index.id, 2)).toBeGreaterThan(0);
  });

  it('индекс фактов: чанк — сам факт, метаданные {factId, kind}', async () => {
    const storage = createTestStorage();
    await storage.memoryFacts.save({
      id: 'mem_1',
      namespace: 'plugin:synth-plugin-memory',
      version: 1,
      text: 'Деплой идёт через Fleet',
      kind: 'decision',
      projectId: 'p1',
      provenance: { sourceKind: 'session', sourceId: 's1', capturedAt: '2026-10-20T10:00:00.000Z' },
      confidence: 0.9,
      status: 'active',
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
    });
    const provider = makeProvider(storage);

    const created = await provider.createIndex({
      source: { kind: 'facts' },
      projectId: 'p1',
    });
    await provider.indexManager.whenIdle();

    const status = await provider.getIndex(created.index.id);
    expect(status!.state).toBe('ready');
    expect(status!.index.stats.documents).toBe(1);
    expect(status!.index.stats.chunks).toBe(1);

    const chunks = await storage.memoryIndexes.listChunks(created.index.id, { generation: 1 });
    expect(chunks[0]!.text).toBe('Деплой идёт через Fleet');
    expect(chunks[0]!.metadata?.factId).toBe('mem_1');
    expect(chunks[0]!.metadata?.kind).toBe('decision');
  });

  it('ошибка эмбеддинга → индекс failed с текстом ошибки, процесс не падает', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const provider = makeProvider(storage, {
      embed: async () => {
        throw new Error('plugin.embedding_not_configured: задайте plugins.embeddingProvider');
      },
    });

    const created = await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: dir,
    });
    await provider.indexManager.whenIdle();

    const status = await provider.getIndex(created.index.id);
    expect(status!.index.state).toBe('failed');
    expect(status!.index.error).toContain('embedding_not_configured');
    // Части корпуса не записаны.
    expect(await storage.memoryIndexes.countChunks(created.index.id)).toBe(0);
  });

  it('провал пересборки не теряет прежнее поколение (индекс остаётся искомым)', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    let broken = false;
    const provider = makeProvider(storage, {
      embed: async (texts) => {
        if (broken) throw new Error('провайдер эмбеддингов недоступен');
        return fakeEmbed(texts, 8);
      },
    });

    const created = await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: dir,
    });
    await provider.indexManager.whenIdle();

    broken = true;
    await provider.rebuildIndex(created.index.id, { workingDir: dir });
    await provider.indexManager.whenIdle();

    const status = await provider.getIndex(created.index.id);
    expect(status!.index.state).toBe('failed');
    expect(status!.index.error).toContain('недоступен');
    // Прежнее поколение осталось доступным.
    expect(await storage.memoryIndexes.countChunks(created.index.id, 1)).toBeGreaterThan(0);
  });

  it('смена размерности эмбеддинга → индекс stale (без авто-перестройки)', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    let dimension = 4;
    const provider = makeProvider(storage, {
      embed: (texts) => fakeEmbed(texts, dimension),
    });

    const created = await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: dir,
    });
    await provider.indexManager.whenIdle();

    let status = await provider.getIndex(created.index.id);
    expect(status!.state).toBe('ready');
    expect(status!.index.fingerprint.dimension).toBe(4);

    // Модель инстанса сменилась (размерность вектора — другая).
    dimension = 8;
    status = await provider.getIndex(created.index.id);
    expect(status!.stale).toBe(true);
    expect(status!.state).toBe('stale');
    // Авто-перестройки нет: поколение прежнее.
    expect(status!.index.generation).toBe(1);
  });

  it('смена модели эмбеддинга при той же размерности → stale', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const make = (model: string): MemoryProviderLite => {
      const { facade } = createTestFacade({
        storage,
        settings: { dimensionProbeTtlMs: 0 },
        embedDimension: 8,
        embedding: { provider: 'ollama', model },
      });
      return new MemoryProviderLite(facade);
    };

    const first = make('model-a');
    const created = await first.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: dir,
    });
    await first.indexManager.whenIdle();
    const ready = await first.getIndex(created.index.id);
    expect(ready!.index.fingerprint.model).toBe('ollama/model-a');

    // Другая модель хоста, та же размерность: индекс должен стать stale.
    const second = make('model-b');
    const status = await second.getIndex(created.index.id);
    expect(status!.index.fingerprint.dimension).toBe(8);
    expect(status!.stale).toBe(true);
    expect(status!.state).toBe('stale');
  });

  it('удаление индекса каскадно удаляет чанки', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const provider = makeProvider(storage);

    const created = await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: dir,
    });
    await provider.indexManager.whenIdle();

    expect(await provider.deleteIndex(created.index.id)).toBe(true);
    expect(await storage.memoryIndexes.getIndex(created.index.id)).toBeNull();
    expect(await storage.memoryIndexes.countChunks(created.index.id)).toBe(0);
  });
});

describe('менеджер индексов: инстансный индекс (scope: instance)', () => {
  it('индекс по фактам собирает факты всех проектов инстанса', async () => {
    const storage = createTestStorage();
    await seedFact(storage, { id: 'mem_1', text: 'Факт проекта p1', projectId: 'p1' });
    await seedFact(storage, { id: 'mem_2', text: 'Факт проекта p2', projectId: 'p2' });
    const provider = makeProvider(storage);

    const created = await provider.createIndex({
      source: { kind: 'facts' },
      scope: 'instance',
    });
    await provider.indexManager.whenIdle();

    const status = await provider.getIndex(created.index.id);
    expect(status!.state).toBe('ready');
    expect(status!.index.scope).toBe('instance');
    // Имя по умолчанию — по области видимости.
    expect(status!.index.name).toBe('instance');
    // Владельца нет: `projectId` у инстансного индекса по фактам отсутствует.
    expect(status!.index.projectId).toBeUndefined();
    // Корпус — факты обоих проектов.
    expect(status!.index.stats.documents).toBe(2);
    expect(status!.index.stats.chunks).toBe(2);
  });

  it('проектный индекс по фактам берёт только факты своего проекта', async () => {
    const storage = createTestStorage();
    await seedFact(storage, { id: 'mem_1', text: 'Факт проекта p1', projectId: 'p1' });
    await seedFact(storage, { id: 'mem_2', text: 'Факт проекта p2', projectId: 'p2' });
    const provider = makeProvider(storage);

    const created = await provider.createIndex({
      source: { kind: 'facts' },
      projectId: 'p1',
    });
    await provider.indexManager.whenIdle();

    const status = await provider.getIndex(created.index.id);
    expect(status!.index.scope).toBe('project');
    expect(status!.index.name).toBe('project');
    expect(status!.index.stats.documents).toBe(1);
  });

  it('инстансный индекс виден из сессии другого проекта, проектный — нет', async () => {
    const storage = createTestStorage();
    await seedFact(storage, { id: 'mem_1', text: 'Факт проекта p1', projectId: 'p1' });
    const provider = makeProvider(storage);

    const instance = await provider.createIndex({
      source: { kind: 'facts' },
      scope: 'instance',
    });
    const project = await provider.createIndex({
      source: { kind: 'facts' },
      projectId: 'p1',
    });
    await provider.indexManager.whenIdle();

    const inP2 = await provider.listIndexes({ projectId: 'p2' });
    const ids = inP2.map((status) => status.index.id);
    expect(ids).toContain(instance.index.id);
    expect(ids).not.toContain(project.index.id);

    // Сессия без проекта тоже видит инстансный индекс.
    const withoutProject = await provider.listIndexes();
    expect(withoutProject.map((status) => status.index.id)).toContain(instance.index.id);
  });

  it('пересборка сохраняет область видимости', async () => {
    const storage = createTestStorage();
    await seedFact(storage, { id: 'mem_1', text: 'Факт проекта p1', projectId: 'p1' });
    const provider = makeProvider(storage);

    const created = await provider.createIndex({
      source: { kind: 'facts' },
      scope: 'instance',
    });
    await provider.indexManager.whenIdle();

    await provider.rebuildIndex(created.index.id);
    await provider.indexManager.whenIdle();

    const status = await provider.getIndex(created.index.id);
    expect(status!.index.scope).toBe('instance');
    expect(status!.index.name).toBe('instance');
    expect(status!.index.generation).toBe(2);
  });
});
