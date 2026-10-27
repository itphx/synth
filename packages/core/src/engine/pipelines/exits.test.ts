/**
 * ADR-101 §9 (Э5): обработчики выходов пайплайна.
 *
 * Покрываются виды выхода `session`/`file`/`gateway`/`none` и правила
 * containment'а файла (ADR-075): абсолютный путь, выход за пределы рабочего
 * каталога и отсутствие workspace — **отказ**, при котором прогон не падает,
 * а ошибка попадает в результат выхода (журнал прогона).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message, Project, Session } from '@itphx/synth-shared';

import {
  MemoryPipelineRunRepository,
  MemoryProjectPipelineRepository,
} from '../../storage/memory/index.js';
import { MemoryBlobRefRepository } from '../../storage/memory/blob-refs.js';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import { PipelineArtifactStore } from './artifacts.js';
import { createPipelineExitHandler } from './exits.js';
import { PipelineEngine } from './engine.js';
import type { PipelineExitContext, StepExecutor } from './types.js';

/** Мок менеджера сессий: фиксирует создание сессии и добавленные сообщения. */
function sessionManagerMock() {
  const created: Array<Record<string, unknown>> = [];
  const messages: Array<{ sessionId: string; message: Message }> = [];
  const session: Session = {
    id: 'sess-1',
    title: 'Пайплайн: Тестовый пайплайн',
    sessionOrigin: 'user',
    ownerId: 'owner-1',
    userId: 'owner-1',
    projectId: 'proj-1',
    messages: [],
    pendingMessages: [],
    status: {},
    settings: {},
    checkpoints: [],
    stickyNotes: [],
    references: [],
    summarizationPending: false,
    canSummarize: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Session;
  return {
    created,
    messages,
    session,
    manager: {
      createSession: async (data: Record<string, unknown>) => {
        created.push(data);
        return session;
      },
      getSession: async () => session,
      addMessage: async (sessionId: string, message: Message) => {
        messages.push({ sessionId, message });
        return session;
      },
    },
  };
}

/** Мок порта проектов: отдаёт проект с заданным владельцем и workspace. */
function projectStoreMock(project: Partial<Project> | null) {
  return {
    load: async (id: string) =>
      (project ? ({ id, ...project } as Project) : null),
  };
}

/** Контекст выхода для проверки обработчика напрямую. */
function exitContext(
  exit: PipelineExitContext['exit'],
  overrides: Partial<PipelineExitContext> = {},
): PipelineExitContext {
  return {
    runId: 'prun_1',
    pipelineId: 'p1',
    version: 1,
    projectId: 'proj-1',
    exit,
    spec: { id: 'p1', name: 'Тестовый пайплайн', version: 1, status: 'published', mode: 'act', nodes: [], exits: [exit] },
    trigger: { kind: 'manual' },
    output: { text: 'готово', secret: 'не должен утечь' },
    vars: {},
    ...overrides,
  };
}

describe('выход session', () => {
  it('создаёт сессию в проекте, владелец — владелец проекта, результат шага — сообщение', async () => {
    const sm = sessionManagerMock();
    const published: Array<{ sessionId: string; type: string; data: Record<string, unknown> }> = [];
    const materialized: Session[] = [];

    const handler = createPipelineExitHandler({
      sessionManager: sm.manager,
      projectStore: projectStoreMock({ ownerId: 'owner-1' }),
      eventBus: {
        publish: (sessionId, type, data) => published.push({ sessionId, type, data: data ?? {} }),
      },
      resolveLlmDefaults: async () => ({ provider: 'itphx', model: 'model-1' }),
    });

    await handler.handle(exitContext({ kind: 'session', session: { agent: 'assistant' } }));

    // Сессия создана в проекте прогона, владелец — владелец проекта.
    expect(sm.created).toHaveLength(1);
    expect(sm.created[0]).toMatchObject({
      projectId: 'proj-1',
      ownerId: 'owner-1',
      userId: 'owner-1',
      sessionOrigin: 'user',
    });
    // Дефолты модели инстанца — в настройках сессии.
    expect((sm.created[0]!.settings as Record<string, unknown>)).toMatchObject({
      provider: 'itphx',
      model: 'model-1',
      agentRole: 'assistant',
    });
    // `session.created` опубликован в канал сессии (инвариант 18).
    expect(published).toHaveLength(1);
    expect(published[0]!.type).toBe('session.created');
    expect(published[0]!.sessionId).toBe('sess-1');
    // Результат шага стал сообщением сессии.
    expect(sm.messages).toHaveLength(1);
    expect(sm.messages[0]!.sessionId).toBe('sess-1');
    expect(sm.messages[0]!.message.author).toBe('Pipeline');
    expect(sm.messages[0]!.message.content).toContain('готово');
    expect(materialized).toHaveLength(0);
  });

  it('продолжает существующую сессию (владелец не меняется)', async () => {
    const sm = sessionManagerMock();
    const handler = createPipelineExitHandler({
      sessionManager: sm.manager,
      projectStore: projectStoreMock({ ownerId: 'owner-1' }),
    });

    await handler.handle(
      exitContext({ kind: 'session', session: { sessionId: 'sess-existing' } }),
    );

    expect(sm.created).toHaveLength(0);
    expect(sm.messages).toHaveLength(1);
    expect(sm.messages[0]!.sessionId).toBe('sess-existing');
  });

  it('уведомляет хаб о материализованной сессии', async () => {
    const sm = sessionManagerMock();
    const materialized: Session[] = [];
    const handler = createPipelineExitHandler({
      sessionManager: sm.manager,
      projectStore: projectStoreMock({ ownerId: 'owner-1' }),
      onSessionMaterialized: (session) => {
        materialized.push(session);
      },
    });

    await handler.handle(exitContext({ kind: 'session', session: { agent: 'assistant' } }));

    expect(materialized).toHaveLength(1);
    expect(materialized[0]!.id).toBe('sess-1');
  });

  it('без менеджера сессий — выход пропускается, ошибки нет', async () => {
    const handler = createPipelineExitHandler({});
    await expect(
      handler.handle(exitContext({ kind: 'session', session: { agent: 'assistant' } })),
    ).resolves.toBeUndefined();
  });
});

describe('выход file', () => {
  it('пишет артефакт в workspace проекта', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'synth-pipeline-'));
    const handler = createPipelineExitHandler({
      projectStore: projectStoreMock({ ownerId: 'owner-1', workspace }),
    });

    await handler.handle(
      exitContext({ kind: 'file', file: { path: 'out/report.md', contentFrom: 'text' } }),
    );

    const content = await readFile(join(workspace, 'out', 'report.md'), 'utf8');
    expect(content).toContain('готово');
  });

  it('абсолютный путь — отказ', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'synth-pipeline-'));
    const handler = createPipelineExitHandler({
      projectStore: projectStoreMock({ ownerId: 'owner-1', workspace }),
    });

    await expect(
      handler.handle(exitContext({ kind: 'file', file: { path: '/etc/passwd' } })),
    ).rejects.toThrow(/абсолютный путь/);
  });

  it('выход за пределы workspace — отказ', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'synth-pipeline-'));
    const handler = createPipelineExitHandler({
      projectStore: projectStoreMock({ ownerId: 'owner-1', workspace }),
    });

    await expect(
      handler.handle(exitContext({ kind: 'file', file: { path: '../escape.txt' } })),
    ).rejects.toThrow(/за пределы/);
  });

  it('без workspace у проекта — отказ', async () => {
    const handler = createPipelineExitHandler({
      projectStore: projectStoreMock({ ownerId: 'owner-1' }),
    });

    await expect(
      handler.handle(exitContext({ kind: 'file', file: { path: 'report.md' } })),
    ).rejects.toThrow(/рабочего каталога/);
  });

  it('ADR-116: после workspace те же байты кладутся в blob-порт и возвращается артефакт', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'synth-pipeline-'));
    const blobDir = await mkdtemp(join(tmpdir(), 'synth-pipeline-blobs-'));
    const blobs = new FileBlobStore({ root: join(blobDir, 'blobs') });
    const refs = new MemoryBlobRefRepository();
    const artifacts = new PipelineArtifactStore({ blobs, blobRefs: refs });
    const handler = createPipelineExitHandler({
      projectStore: projectStoreMock({ ownerId: 'owner-1', workspace }),
      artifacts,
    });

    const result = await handler.handle(
      exitContext({ kind: 'file', file: { path: 'out/report.md', contentFrom: 'text' } }),
    );

    // Артефакт — объект blob-хранилища с адресуемым путём и MIME по расширению.
    expect(result?.artifacts).toHaveLength(1);
    const artifact = result!.artifacts![0]!;
    expect(artifact).toMatchObject({
      kind: 'blob',
      path: 'artifacts/prun_1/report.md',
      name: 'report.md',
    });
    expect(artifact.mime).toContain('text/markdown');
    expect((await artifacts.read({ path: artifact.path! }))?.toString('utf8')).toContain('готово');
    // Ссылка владельца записана — объект не считается осиротевшим.
    expect(await refs.listByOwner('pipeline-run', 'prun_1')).toContain(artifact.path);
    // Файл в workspace при этом на месте.
    expect(await readFile(join(workspace, 'out', 'report.md'), 'utf8')).toContain('готово');
  });

  it('ADR-116: файл больше лимита — workspace пишется, blob пропускается, прогон не падает', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'synth-pipeline-'));
    const blobDir = await mkdtemp(join(tmpdir(), 'synth-pipeline-blobs-'));
    const blobs = new FileBlobStore({ root: join(blobDir, 'blobs') });
    const refs = new MemoryBlobRefRepository();
    // Предел меньше содержимого выхода (`{ text: 'готово', … }`).
    const artifacts = new PipelineArtifactStore({ blobs, blobRefs: refs, maxBytes: 4 });
    const handler = createPipelineExitHandler({
      projectStore: projectStoreMock({ ownerId: 'owner-1', workspace }),
      artifacts,
    });

    const result = await handler.handle(
      exitContext({ kind: 'file', file: { path: 'out/big.md', contentFrom: 'text' } }),
    );

    // Выход не падает и не отдаёт артефакт; файл в workspace записан.
    expect(result).toBeUndefined();
    expect(await blobs.list('artifacts/')).toEqual([]);
    expect(await readFile(join(workspace, 'out', 'big.md'), 'utf8')).toContain('готово');
  });
});

describe('выход gateway', () => {
  it('публикует событие через ingress с санитизированным payload', async () => {
    const ingested: Array<{ source: string; type: string; payload?: unknown }> = [];
    const instanceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const handler = createPipelineExitHandler({
      ingress: {
        ingest: async (input) => {
          ingested.push(input);
          return undefined;
        },
      },
      eventBus: {
        publish: () => {},
        publishInstance: (type, data) => instanceEvents.push({ type, data: data ?? {} }),
      },
    });

    await handler.handle(
      exitContext({ kind: 'gateway', gateway: { event: 'release_published' } }),
    );

    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.source).toBe('pipeline');
    expect(ingested[0]!.type).toBe('release_published');
    // Секреты из результата шага вырезаны.
    const payload = ingested[0]!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('secret');
    expect(JSON.stringify(payload)).not.toContain('не должен утечь');
    expect(payload.runId).toBe('prun_1');
    // Событие также уходит в инстансный канал шины (webhooks/UI).
    expect(instanceEvents.map((event) => event.type)).toContain('pipeline.completed');
  });

  it('тип по умолчанию — pipeline.completed', async () => {
    const ingested: Array<{ source: string; type: string }> = [];
    const handler = createPipelineExitHandler({
      ingress: {
        ingest: async (input) => {
          ingested.push(input);
          return undefined;
        },
      },
    });

    await handler.handle(exitContext({ kind: 'gateway', gateway: {} }));

    expect(ingested[0]!.type).toBe('pipeline.completed');
  });
});

describe('выход none', () => {
  it('ничего не делает', async () => {
    const ingest = vi.fn();
    const handler = createPipelineExitHandler({
      ingress: { ingest },
      eventBus: { publish: vi.fn(), publishInstance: vi.fn() },
    });

    await expect(handler.handle(exitContext({ kind: 'none' }))).resolves.toBeUndefined();
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('выходы в движке: прогон не падает, ошибка — в результате выхода', () => {
  async function runWithExit(exit: PipelineExitContext['exit']): Promise<{
    status: string;
    exits: unknown;
  }> {
    const pipelines = new MemoryProjectPipelineRepository();
    const runs = new MemoryPipelineRunRepository();
    const now = new Date().toISOString();
    const pipelineSpec = {
      id: 'p1',
      name: 'Тестовый пайплайн',
      version: 1,
      status: 'published' as const,
      mode: 'act' as const,
      nodes: [{ id: 'first', kind: 'tool' as const, tool: 'noop' }],
      exits: [exit],
    };
    await pipelines.savePipeline({
      id: 'p1',
      scope: 'project',
      projectId: 'proj-1',
      name: pipelineSpec.name,
      draftVersion: 2,
      publishedVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await pipelines.saveVersion({ pipelineId: 'p1', version: 1, spec: pipelineSpec, publishedAt: now });

    const executors: StepExecutor[] = [
      { kind: 'tool', execute: async () => ({ status: 'ok', attempt: 1, output: { text: 'готово' } }) },
    ];
    const exitHandler = createPipelineExitHandler({
      projectStore: projectStoreMock({ ownerId: 'owner-1' }),
    });
    const engine = new PipelineEngine({ pipelines, runs, executors, exits: [exitHandler] });

    const run = await engine.run({
      pipelineId: 'p1',
      trigger: { kind: 'manual' },
      projectId: 'proj-1',
    });
    const events = await runs.listEvents(run.id);
    const finished = events.find((event) => event.type === 'run.finished');
    return { status: run.status, exits: finished?.payload?.exits };
  }

  it('отказ выхода не роняет прогон, ошибка фиксируется в результате выхода', async () => {
    const { status, exits } = await runWithExit({ kind: 'file', file: { path: '/etc/passwd' } });

    expect(status).toBe('done');
    const list = exits as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('file');
    expect(list[0]!.error).toMatchObject({ code: 'pipeline.exit_failed' });
  });

  it('успешный выход ошибки не содержит', async () => {
    const { status, exits } = await runWithExit({ kind: 'none' });

    expect(status).toBe('done');
    const list = exits as Array<Record<string, unknown>>;
    expect(list[0]).not.toHaveProperty('error');
  });
});
