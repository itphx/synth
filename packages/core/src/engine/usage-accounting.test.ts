/**
 * ADR-102/ADR-118: aux-учёт LLM-вызовов (паритет opencode `session.usage.recorded`).
 * Счётчики сессии + роллап `usage` (`requests=1`, без `messages`), сообщений нет.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message, TokenUsage } from '@itphx/synth-shared';
import { createMemoryStorage } from '../storage/storage-context.js';
import { FileStore } from '../storage/file-store.js';
import { SessionManager } from '../sessions/manager.js';
import { AnalyticsRecorder } from '../analytics/recorder.js';
import { recordAuxUsage } from './usage-accounting.js';

const NOW = new Date('2026-10-18T09:00:00.000Z');
const USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 10,
  totalTokens: 110,
  cacheReadTokens: 20,
  cacheWriteTokens: 5,
  reasoningTokens: 3,
};

function makeEnv() {
  const storage = createMemoryStorage();
  const sessionManager = new SessionManager(storage.sessions);
  const analytics = new AnalyticsRecorder({ repo: storage.analyticsRollups, now: () => NOW });
  return { storage, sessionManager, analytics };
}

describe('recordAuxUsage', () => {
  it('добавляет токены в счётчики сессии и роллап usage (requests=1, без messages)', async () => {
    const { storage, sessionManager, analytics } = makeEnv();
    const session = await sessionManager.createSession({ userId: 'u1', projectId: 'p1' });

    await recordAuxUsage(
      { sessionManager, analytics, modelPriceLoader: () => ({ inputPrice: 1, outputPrice: 2 }) },
      { sessionId: session.id, usage: USAGE, provider: 'p', model: 'm', agent: 'title', source: 'title' },
    );

    const saved = (await sessionManager.getSession(session.id))!;
    expect(saved.inputTokens).toBe(100);
    expect(saved.outputTokens).toBe(10);
    expect(saved.totalTokens).toBe(110);
    expect(saved.cacheReadTokens).toBe(20);
    expect(saved.cacheWriteTokens).toBe(5);
    expect(saved.reasoningTokens).toBe(3);

    const rows = await storage.analyticsRollups.query({ family: 'usage', groupBy: ['user', 'model', 'agent'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dimensions).toMatchObject({ user: 'u1', model: 'm', agent: 'title' });
    expect(rows[0]!.measures).toMatchObject({
      input_tokens: 100,
      output_tokens: 10,
      requests: 1,
    });
    expect(rows[0]!.measures.messages).toBeUndefined();
  });

  it('нулевой usage — no-op (ни счётчиков, ни бакетов)', async () => {
    const { storage, sessionManager, analytics } = makeEnv();
    const session = await sessionManager.createSession({ userId: 'u1' });

    await recordAuxUsage(
      { sessionManager, analytics },
      { sessionId: session.id, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, source: 'title' },
    );

    const saved = (await sessionManager.getSession(session.id))!;
    expect(saved.inputTokens).toBe(0);
    expect(await storage.analyticsRollups.query({ family: 'usage' })).toEqual([]);
  });

  it('использует стоимость провайдера (usage.cost), а не каталог', async () => {
    const { storage, sessionManager, analytics } = makeEnv();
    const session = await sessionManager.createSession({ userId: 'u1' });

    await recordAuxUsage(
      { sessionManager, analytics, modelPriceLoader: () => ({ inputPrice: 1000, currency: 'USD' }) },
      {
        sessionId: session.id,
        usage: { ...USAGE, cost: { amount: 0.42, currency: 'RUB' } },
        model: 'm',
        source: 'qa-self-check',
      },
    );

    const rows = await storage.analyticsRollups.query({ family: 'usage' });
    expect(rows[0]!.costByCurrency).toEqual({ RUB: 0.42 });
  });

  it('messages=1 без токенов пишет запись сообщения (micro), без requests', async () => {
    const { storage, sessionManager, analytics } = makeEnv();
    const session = await sessionManager.createSession({ userId: 'u1' });

    await recordAuxUsage(
      { sessionManager, analytics },
      {
        sessionId: session.id,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: 'micro:small_talk',
        source: 'micro-message',
        messages: 1,
      },
    );

    const rows = await storage.analyticsRollups.query({ family: 'usage' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.measures).toMatchObject({ messages: 1 });
    expect(rows[0]!.measures.requests).toBeUndefined();
  });
});

/**
 * Этап 2b-1: счётчики aux-расхода пишутся **точечной мутацией метаданных**
 * (`mutateMeta`) — инкременты считаются по свежему чтению под локом хранилища.
 * Проверяем на файловом хранилище (реальные `await`-точки): параллельные
 * начисления не теряются, история не переписывается, `updatedAt` двигается
 * (паритет: старый код выставлял его явно).
 */
describe('recordAuxUsage — параллельные начисления (этап 2b-1)', () => {
  const OLD_UPDATED_AT = '2020-01-01T00:00:00.000Z';

  function witnessMessage(): Message {
    return {
      id: generateId(),
      role: MessageRole.USER,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart('свидетель')],
      content: 'свидетель',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
    };
  }

  it('два параллельных начисления суммируются, сообщение-свидетель цело, updatedAt изменился', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'synth-aux-usage-'));
    try {
      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
      const session = await sessionManager.createSession({ userId: 'u1', projectId: 'p1' });
      await sessionManager.mutateMeta(session.id, (meta) => {
        meta.updatedAt = OLD_UPDATED_AT;
      }, { touchUpdatedAt: false });
      const witness = witnessMessage();

      await Promise.all([
        recordAuxUsage(
          { sessionManager },
          { sessionId: session.id, usage: USAGE, model: 'm', source: 'title' },
        ),
        recordAuxUsage(
          { sessionManager },
          { sessionId: session.id, usage: USAGE, model: 'm', source: 'qa-self-check' },
        ),
        sessionManager.addMessage(session.id, witness),
      ]);

      const saved = (await sessionManager.getSession(session.id))!;
      // Ни одно начисление не потеряно (lost update исключён).
      expect(saved.inputTokens).toBe(200);
      expect(saved.outputTokens).toBe(20);
      expect(saved.totalTokens).toBe(220);
      expect(saved.cacheReadTokens).toBe(40);
      expect(saved.cacheWriteTokens).toBe(10);
      expect(saved.reasoningTokens).toBe(6);
      // История не переписывалась записью метаданных.
      expect(saved.messages.map((m) => m.id)).toContain(witness.id);
      // Паритет: явный `updatedAt` старого кода → флаг двигается.
      expect(new Date(saved.updatedAt).getTime()).toBeGreaterThan(new Date(OLD_UPDATED_AT).getTime());
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('ошибка хранилища не ломает вызов (best-effort), сессия не меняется', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'synth-aux-usage-'));
    try {
      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
      await expect(recordAuxUsage(
        { sessionManager },
        { sessionId: 'missing-session', usage: USAGE, source: 'title' },
      )).resolves.toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
