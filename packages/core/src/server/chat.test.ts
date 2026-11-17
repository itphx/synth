/**
 * Одноразовый CLI-чат (`runSingleChat`) — персистентность сессии.
 *
 * Проверяем ровно то, что закреплено этапом 2b-2a: атрибуция владельца —
 * точечная правка метаданных (`mutateMeta`, `updatedAt` двигается, паритет с
 * прежним `updateSession`), а сообщение дописывается **точечно**
 * (`appendMessage`): история не переписывается снимком, поэтому параллельная
 * дозапись не теряется.
 *
 * LLM не вызывается: `createProcessMessage` подменяется заглушкой. Временная
 * сессия удаляется в `finally` — её состояние забираем перед удалением.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTextPart } from '@itphx/synth-shared';
import type { ProviderConfig, ModelConfig, Session, SynthConfig } from '@itphx/synth-shared';
import { runSingleChat } from './chat.js';
import { SessionManager } from '../sessions/manager.js';
import { ChatOrchestrator } from '../engine/orchestrator.js';
import { createStorageContextAsync } from '../storage/storage-context.js';
import { FileStore } from '../storage/file-store.js';

/** Заведомо старое время: любое движение `updatedAt` видно однозначно. */
const OLD_STAMP = '2020-01-01T00:00:00.000Z';

describe('runSingleChat — владелец и первое сообщение (этап 2b-2a)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-chat-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Зарегистрировать провайдера и модель в хранилище инстанса (через порты). */
  async function seedProvider(): Promise<void> {
    const storage = await createStorageContextAsync('file', { dataDir: tmpDir, env: process.env });
    try {
      await storage.providers.save('p1', {
        name: 'p1',
        type: 'openai',
        baseUrl: 'http://127.0.0.1:9/v1',
      } as ProviderConfig);
      await storage.models.save('m1', {
        id: 'm1',
        name: 'm1',
        provider: 'p1',
        enabled: true,
      } as ModelConfig);
    } finally {
      await storage.close?.();
    }
  }

  it('ownerId/userId = local, одно сообщение с seq/ord, updatedAt сдвинут, история не переписана', async () => {
    await seedProvider();

    // LLM не зовём: процесс обработки — заглушка (нас интересует персист до хода).
    vi.spyOn(ChatOrchestrator.prototype, 'createProcessMessage')
      .mockReturnValue(async () => ({}));

    // Свежесозданную сессию помечаем «старым» временем: проверяем, что правка
    // владельца идёт точечно и `updatedAt` двигается (паритет `updateSession`).
    const originalCreate = SessionManager.prototype.createSession;
    vi.spyOn(SessionManager.prototype, 'createSession').mockImplementation(async function (
      this: SessionManager,
      data?: Parameters<SessionManager['createSession']>[0],
    ) {
      const created = await originalCreate.call(this, data);
      const store = (this as unknown as { store: FileStore }).store;
      const full = await store.load(created.id);
      await store.save({ ...full!, updatedAt: OLD_STAMP });
      created.updatedAt = OLD_STAMP;
      return created;
    });

    // Временная сессия удаляется в `finally` — забираем её состояние до удаления.
    let captured: Session | null = null;
    vi.spyOn(SessionManager.prototype, 'deleteSession').mockImplementation(async function (
      this: SessionManager,
      sessionId: string,
    ) {
      captured = await this.getSession(sessionId);
    });

    await runSingleChat({
      message: 'привет',
      dataDir: tmpDir,
      config: {
        storage: {},
        llm: { defaultProvider: 'p1', defaultModel: 'm1' },
      } as SynthConfig,
    });

    expect(captured).not.toBeNull();
    const session = captured as unknown as Session;
    // ADR-075/D5: владелец — локальный пользователь (правка метаданных).
    expect(session.ownerId).toBe('local');
    expect(session.userId).toBe('local');
    // Сообщение дописано точечно: ровно одно, с выданными портом seq/ord.
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.content).toBe('привет');
    expect(session.messages[0]?.seq).toBe(1);
    expect(Number.isFinite(session.messages[0]?.ord)).toBe(true);
    // Паритет: прежний `updateSession` двигал `updatedAt`.
    expect(session.updatedAt).not.toBe(OLD_STAMP);

    // Хранилище содержит ровно одно сообщение: дозапись точечная (не снимок),
    // повторов/перезаписи истории нет.
    const store = new FileStore({ dataDir: tmpDir });
    const stored = await store.load(session.id);
    expect(stored?.messages).toHaveLength(1);
    expect(stored?.messages[0]?.content).toBe('привет');
  });

  it('appendMessage не переписывает уже существующую историю (свидетель цел)', async () => {
    const store = new FileStore({ dataDir: tmpDir });
    const sessionManager = new SessionManager(store);
    const session = await sessionManager.createSession({ title: 'T' });

    // Свидетель записан заранее (как параллельная дозапись).
    await sessionManager.appendMessage(session.id, {
      id: 'witness', role: 'user' as never, seq: 0, origin: 'local',
      parts: [makeTextPart('свидетель')], content: 'свидетель',
      createdAt: new Date().toISOString(), disabled: false, pinned: false, hidden: false,
    });

    // Ровно тот шов, которым CLI-чат пишет первое сообщение.
    await sessionManager.appendMessage(session.id, {
      id: 'first', role: 'user' as never, seq: 0, origin: 'local',
      parts: [makeTextPart('привет')], content: 'привет',
      createdAt: new Date().toISOString(), disabled: false, pinned: false, hidden: false,
    });
    // И правка владельца — точечно (метаданные).
    const owned = await sessionManager.mutateMeta(session.id, (meta) => {
      meta.userId = 'local';
      meta.ownerId = 'local';
    });
    expect(owned.found).toBe(true);

    const stored = await sessionManager.getSession(session.id);
    expect(stored?.messages.map((m) => m.content)).toEqual(['свидетель', 'привет']);
    expect(stored?.ownerId).toBe('local');
    expect(stored?.messages.map((m) => m.seq)).toEqual([1, 2]);
  });
});
