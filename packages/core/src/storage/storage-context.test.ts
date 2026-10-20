// PROP-032 (W2.3): единая точка сборки слоя хранения — контрактные проверки
// `createFileStorage`/`createMemoryStorage`/`createStorageContext`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@itphx/synth-shared';
import {
  createFileStorage,
  createMemoryStorage,
  createStorageContext,
} from './storage-context.js';
import type { StorageContext } from './storage-context.js';

/** Поля контекста (кроме `kind`) — доменные порты слоя хранения. */
const PORT_KEYS = [
  'sessions', 'projects', 'profiles', 'settings', 'defaults', 'secretPatterns',
  'protectedPaths', 'dictionaries', 'providers', 'models', 'agents', 'mcpRegistry',
  'serviceKeys', 'eventApiKeys',
  'eventBindings', 'eventRoutes', 'eventJournal', 'identityClaims', 'webhooks',
  'webhookDeliveries', 'schedules', 'jobs', 'maintenanceAudit', 'dedup', 'skills', 'skillBundles',
  'contextFiles', 'sshKeys', 'blobs',
  'pipelines', 'packs',
] as const satisfies readonly (keyof StorageContext)[];

describe('StorageContext (PROP-032, W2.3)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-storage-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Минимальная сессия (паритет с `file-store.test.ts`). */
  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: 'test-1',
      title: 'Test Session',
      sessionOrigin: 'user',
      userId: 'user-1',
      projectId: 'proj-1',
      messages: [],
      pendingMessages: [],
      status: {},
      settings: {
        temperature: 0.7,
        maxTokens: 4096,
        debugEnabled: true,
        streamEnabled: true,
        contextOptimization: 'none' as const,
        slidingWindowMode: 'messages' as const,
        slidingWindowMessageLimit: 10,
        slidingWindowTokenThreshold: 80,
        summarizationEnabled: false,
        summarizationTriggerMode: 'messages' as const,
        summarizeAfterN: 10,
        summarizeTokenThreshold: 50,
        summarizationHeadMessages: 2,
        summarizationTailMessages: 3,
        showInterview: true,
        websocketEnabled: true,
        routingEnabled: true,
        routingStrategy: 'auto',
        routingContent: { coding: { provider: '', model: '' }, chat: { provider: '', model: '' }, research: { provider: '', model: '' } },
        routingEscalation: { enabled: true, fallbackProvider: '', fallbackModel: '', checks: ['min_length', 'constraint'], minLength: 10 },
        routingCost: { enabled: false, cheapProvider: '', cheapModel: '', maxCheapTokens: 500 },
        subagentRouting: { enabled: true },
        microFirst: false,
        microConfidenceThreshold: 0.8,
        embeddingEnabled: false,
      },
      checkpoints: [],
      stickyNotes: [],
      references: [],
      summarizationPending: false,
      canSummarize: false,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      ...overrides,
    };
  }

  it('createFileStorage: все поля контекста определены', () => {
    const ctx = createFileStorage({ dataDir: tmpDir });
    expect(ctx.kind).toBe('file');
    for (const key of PORT_KEYS) {
      expect(ctx[key], `поле ${key} не определено`).toBeDefined();
    }
  });

  it('createFileStorage: каждый вызов — независимые экземпляры (разные dataDir)', async () => {
    const a = createFileStorage({ dataDir: tmpDir });
    const b = createFileStorage({ dataDir: tmpDir });
    // Разные инстансы — не модульные синглтоны.
    expect(a.settings).not.toBe(b.settings);

    const otherDir = join(tmpDir, 'other');
    const c = createFileStorage({ dataDir: otherDir });

    await a.settings.setWorkspace('/ws/a');
    // Разные dataDir — независимые данные: запись в `a` не видна через `c`.
    expect(await c.settings.getWorkspace()).toBeUndefined();
    await c.settings.setWorkspace('/ws/c');
    expect(await c.settings.getWorkspace()).toBe('/ws/c');
    expect(await a.settings.getWorkspace()).toBe('/ws/a');
  });

  it('createMemoryStorage: kind=memory, файловая система не создаётся', async () => {
    const dir = join(tmpDir, 'memory-data');
    const ctx = createMemoryStorage({ dataDir: dir });
    expect(ctx.kind).toBe('memory');
    expect(existsSync(dir)).toBe(false);
    for (const key of PORT_KEYS) {
      expect(ctx[key], `поле ${key} не определено`).toBeDefined();
    }

    // PROP-032 (W2.4): конфигурационные словари (providers/models/agents) — в памяти,
    // на диск ничего не пишется (иначе `storage.backend=memory` протекал бы на ФС).
    await ctx.providers.save('ollama', { name: 'ollama', type: 'ollama' } as never);
    await ctx.models.save('ollama/llama3', { id: 'ollama/llama3', provider: 'ollama' } as never);
    await ctx.agents.save('assistant', { id: 'assistant' } as never);
    expect((await ctx.providers.list()).length).toBe(1);
    expect(existsSync(join(dir, 'providers'))).toBe(false);
    expect(existsSync(join(dir, 'models'))).toBe(false);
    expect(existsSync(join(dir, 'agents'))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it('createStorageContext: диспетчер по backend', () => {
    expect(createStorageContext('memory', { dataDir: tmpDir }).kind).toBe('memory');
    expect(createStorageContext('file', { dataDir: tmpDir }).kind).toBe('file');
  });

  it('memory-контекст: сквозная операция проект+сессия, видимость listForUserScope', async () => {
    const ctx = createStorageContext('memory', { dataDir: tmpDir });

    const project = ctx.projects.create('Project', 'owner-1');
    await ctx.projects.save(project);

    const session = makeSession({
      id: 'session-1',
      userId: 'someone-else',
      projectId: project.id,
    });
    await ctx.sessions.save(session);

    // Проект читается списком у владельца.
    const projects = await ctx.projects.list('owner-1');
    expect(projects.map((p) => p.id)).toContain(project.id);

    // Сессия проекта видна участнику проекта (через проектную область видимости).
    const scoped = await ctx.sessions.listForUserScope('member-2', [project.id]);
    expect(scoped.map((s) => s.id)).toContain(session.id);

    // Без проектной области чужая сессия не видна.
    const stranger = await ctx.sessions.listForUserScope('member-2', []);
    expect(stranger.map((s) => s.id)).not.toContain(session.id);

    // Владелец сессии (userId) видит её и без проектной области.
    const owner = await ctx.sessions.listForUserScope('someone-else', []);
    expect(owner.map((s) => s.id)).toContain(session.id);
  });
});
