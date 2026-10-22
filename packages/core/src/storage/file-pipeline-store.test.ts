import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePipelineStore } from './file-pipeline-store.js';
import type { PipelineDefinitionRecord, PipelineInstanceRecord } from './ports/pipeline-repository.js';

const definition = (
  id: string,
  overrides: Partial<PipelineDefinitionRecord> = {},
): PipelineDefinitionRecord => ({
  id,
  name: `pipeline-${id}`,
  steps: [{ id: 'step-1', kind: 'agent', agent: 'assistant' }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const instance = (
  id: string,
  overrides: Partial<PipelineInstanceRecord> = {},
): PipelineInstanceRecord => ({
  id,
  pipelineId: 'pipeline-1',
  status: 'pending',
  steps: [],
  attempts: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('FilePipelineStore (ADR-051/ADR-100, ADR-005)', () => {
  let store: FilePipelineStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-pipelines-'));
    store = new FilePipelineStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('отсутствие файлов — пустой репозиторий (не ошибка)', async () => {
    expect(existsSync(join(tmpDir, 'pipelines'))).toBe(false);
    expect(await store.listDefinitions()).toEqual([]);
    expect(await store.listInstances()).toEqual([]);
    expect(await store.getDefinition('missing')).toBeNull();
    expect(await store.getInstance('missing')).toBeNull();
    expect(await store.deleteDefinition('missing')).toBe(false);
  });

  it('каталог и файлы создаются при первой записи; определения и экземпляры — раздельно', async () => {
    await store.saveDefinition(definition('pipeline-1'));
    await store.saveInstance(instance('run-1'));

    const dir = join(tmpDir, 'pipelines');
    expect(existsSync(dir)).toBe(true);
    const files = await readdir(dir);
    expect(files).toContain('definitions.json');
    expect(files).toContain('instances.json');

    const definitions = JSON.parse(await readFile(join(dir, 'definitions.json'), 'utf-8'));
    expect(definitions.schemaVersion).toBe(1);
    expect(definitions.definitions).toHaveLength(1);
    const instances = JSON.parse(await readFile(join(dir, 'instances.json'), 'utf-8'));
    expect(instances.instances).toHaveLength(1);
  });

  it('запись атомарна: временных .tmp-файлов не остаётся', async () => {
    await store.saveDefinition(definition('pipeline-1'));
    await store.saveInstance(instance('run-1'));

    const files = await readdir(join(tmpDir, 'pipelines'));
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
  });

  it('порча JSON — понятная ошибка, а не тихий пустой список', async () => {
    const dir = join(tmpDir, 'pipelines');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'definitions.json'), '{ not json', 'utf-8');
    await writeFile(join(dir, 'instances.json'), '{ not json', 'utf-8');

    await expect(store.listDefinitions()).rejects.toThrow(/Повреждён файл/);
    await expect(store.getDefinition('pipeline-1')).rejects.toThrow(/Повреждён файл/);
    await expect(store.listInstances()).rejects.toThrow(/Повреждён файл/);
  });

  it('неверная форма файла (поле не массив) — понятная ошибка', async () => {
    const dir = join(tmpDir, 'pipelines');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'definitions.json'), JSON.stringify({ schemaVersion: 1, definitions: 'oops' }), 'utf-8');

    await expect(store.listDefinitions()).rejects.toThrow(/ожидался массив/);
  });

  it('данные переживают пересоздание стора (персист)', async () => {
    await store.saveDefinition(definition('pipeline-1', { name: 'Release' }));
    await store.saveInstance(instance('run-1'));

    const reloaded = new FilePipelineStore({ dataDir: tmpDir });
    expect((await reloaded.getDefinition('pipeline-1'))?.name).toBe('Release');
    expect((await reloaded.getInstance('run-1'))?.pipelineId).toBe('pipeline-1');
  });

  it('удаление определения убирает запись из файла', async () => {
    await store.saveDefinition(definition('pipeline-1'));
    expect(await store.deleteDefinition('pipeline-1')).toBe(true);

    const raw = JSON.parse(await readFile(join(tmpDir, 'pipelines', 'definitions.json'), 'utf-8'));
    expect(raw.definitions).toHaveLength(0);
  });

  it('параллельные записи не теряют данные (лок стора)', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.saveDefinition(definition(`pipeline-${i}`))),
    );
    expect(await store.listDefinitions()).toHaveLength(10);
  });
});
