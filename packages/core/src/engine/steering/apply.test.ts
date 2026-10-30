/**
 * ADR-104 + ADR-115: общая точка применения инъекций — в событии
 * `message.injected` должны быть части сообщения (медиа — иначе UI не покажет
 * вложение в живой ленте).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { applySteerInjections, dropSteerInjections, isBackgroundNoticeMessage } from './apply.js';
import type { SteerInjectedEvent, SteerDroppedEvent } from './apply.js';
import { generateId, MessageRole, nowISO, makeTextPart, makeMediaPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';
import type { LLMMessage } from '../../providers/base.js';

/** Минимальное LLM-сообщение — инъекция просто дописывается в контекст хода. */
function makeLlmMessage(message: Message): LLMMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    disabled: false,
    pinned: false,
    branchId: 'main',
  };
}

function makeSteerMessage(content: string, parts = [makeTextPart(content)]): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts,
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

describe('applySteerInjections — parts в message.injected (ADR-115)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-steer-parts-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    const session = await sessionManager.createSession({ title: 'SteerParts' });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('событие несёт части: медиа целиком, текст с лимитом', async () => {
    const longText = 'б'.repeat(800);
    await sessionManager.enqueueSteerMessage(
      sessionId,
      makeSteerMessage(`[image: Yeti 2.jpg] ${longText}`, [
        makeTextPart(longText),
        makeMediaPart('image', {
          blobPath: 'attachments/cd/cdef',
          sha256: 'cdef',
          mime: 'image/png',
          size: 512,
          name: 'Yeti 2.jpg',
        }),
      ]),
    );

    const injected: SteerInjectedEvent[] = [];
    const llmMessages: LLMMessage[] = [];

    await applySteerInjections({
      sessionManager,
      sessionId,
      llmMessages,
      toLlmMessages: (message) => [makeLlmMessage(message)],
      persist: async (message) => {
        const updated = await sessionManager.addMessage(sessionId, message);
        return { index: (updated?.messages.length ?? 1) - 1 };
      },
      publishInjected: (event) => injected.push(event),
      publishDropped: () => {},
      streamId: 'st1',
    });

    expect(injected).toHaveLength(1);
    const parts = injected[0]!.parts!;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0]!.data as string)).toHaveLength(500);
    expect(parts[1]).toMatchObject({
      type: 'image',
      data: { blobPath: 'attachments/cd/cdef', mime: 'image/png', size: 512, name: 'Yeti 2.jpg' },
    });
    // Инъекция всё так же доехала до LLM-контекста текущего хода.
    expect(llmMessages).toHaveLength(1);
  });

  it('текстовая инъекция → parts содержит только текст', async () => {
    await sessionManager.enqueueSteerMessage(sessionId, makeSteerMessage('обычный текст'));

    const injected: SteerInjectedEvent[] = [];
    await applySteerInjections({
      sessionManager,
      sessionId,
      llmMessages: [],
      toLlmMessages: () => [],
      persist: async () => ({ index: 0 }),
      publishInjected: (event) => injected.push(event),
      publishDropped: () => {},
    });

    expect(injected).toHaveLength(1);
    expect(injected[0]!.parts!.map((p) => p.type)).toEqual(['text']);
  });
});

/**
 * ADR-104 × ADR-111/ADR-113: остаток steer-очереди в конце хода **не теряется**.
 * По умолчанию в обычную очередь через `requeue` возвращаются **все** сообщения
 * (в т.ч. пользовательский ввод, отправленный «в разрыв»); `steer.dropped`
 * публикуется только по фактически потерянным (переполнение очереди).
 */
describe('dropSteerInjections — возврат остатка steer-очереди в pendingMessages', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let sessionId: string;

  function notice(content: string): Message {
    return {
      ...makeSteerMessage(content),
      author: 'Process',
      metadata: { type: 'background_run_result', kind: 'process' },
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-steer-drop-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    const session = await sessionManager.createSession({ title: 'SteerDrop' });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('пользовательское сообщение на turn_ended возвращается в очередь, steer.dropped нет', async () => {
    await sessionManager.enqueueSteerMessage(sessionId, makeSteerMessage('в разрыв'));
    const requeued: Message[][] = [];
    const dropped: SteerDroppedEvent[] = [];

    const returned = await dropSteerInjections({
      sessionManager,
      sessionId,
      reason: 'turn_ended',
      publishDropped: (e) => dropped.push(e),
      requeue: async (messages) => {
        requeued.push(messages);
        return { requeued: messages.length, dropped: 0 };
      },
    });

    // Ничего не потеряно: сообщение вернулось, события дропа нет.
    expect(returned).toHaveLength(0);
    expect(dropped).toHaveLength(0);
    expect(requeued).toHaveLength(1);
    expect(requeued[0]!.map((m) => m.content)).toEqual(['в разрыв']);
    // Очередь инъекций снята (в следующий ход «сама» не переедет).
    expect((await sessionManager.getSession(sessionId))!.steerInbox ?? []).toHaveLength(0);
  });

  it('aborted: весь остаток тоже возвращается (автозапуск решает вызывающий)', async () => {
    await sessionManager.enqueueSteerMessage(sessionId, makeSteerMessage('вмешательство 1'));
    await sessionManager.enqueueSteerMessage(sessionId, notice('<process>ok</process>'));
    const requeued: Message[][] = [];
    const dropped: SteerDroppedEvent[] = [];

    await dropSteerInjections({
      sessionManager,
      sessionId,
      reason: 'aborted',
      streamId: 'st1',
      publishDropped: (e) => dropped.push(e),
      requeue: async (messages) => {
        requeued.push(messages);
        return { requeued: messages.length, dropped: 0 };
      },
    });

    expect(dropped).toHaveLength(0);
    expect(requeued).toHaveLength(1);
    // Порядок (FIFO) сохранён.
    expect(requeued[0]!.map((m) => m.content)).toEqual(['вмешательство 1', '<process>ok</process>']);
  });

  it('background_run_result тоже уходит в requeue и не попадает в steer.dropped', async () => {
    await sessionManager.enqueueSteerMessage(sessionId, notice('<process>ok</process>'));
    const requeued: Message[][] = [];
    const dropped: SteerDroppedEvent[] = [];

    const returned = await dropSteerInjections({
      sessionManager,
      sessionId,
      reason: 'turn_ended',
      publishDropped: (e) => dropped.push(e),
      requeue: async (messages) => {
        requeued.push(messages);
        return { requeued: messages.length, dropped: 0 };
      },
    });

    // JSDoc-контракт: возвращаются только реально потерянные сообщения.
    expect(returned).toHaveLength(0);
    expect(requeued).toHaveLength(1);
    expect(requeued[0]).toHaveLength(1);
    expect(requeued[0]![0]!.metadata?.type).toBe('background_run_result');
    // Дропа нет: терять результат фоновой работы нельзя.
    expect(dropped).toHaveLength(0);
    expect((await sessionManager.getSession(sessionId))!.steerInbox ?? []).toHaveLength(0);
  });

  it('часть вернуть не удалось (переполнение очереди) — dropped_count по факту', async () => {
    await sessionManager.enqueueSteerMessage(sessionId, makeSteerMessage('раз 1'));
    await sessionManager.enqueueSteerMessage(sessionId, makeSteerMessage('раз 2'));
    const dropped: SteerDroppedEvent[] = [];

    const returned = await dropSteerInjections({
      sessionManager,
      sessionId,
      reason: 'turn_ended',
      publishDropped: (e) => dropped.push(e),
      // Очередь приняла только одно сообщение.
      requeue: async () => ({ requeued: 1, dropped: 1 }),
    });

    expect(returned).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ reason: 'turn_ended', dropped_count: 1 });
    expect((dropped[0]!.i18n as { key: string }).key).toBe('steer.dropped_turn_ended');
  });

  it('явный предикат: не подходящие под requeue сообщения дропаются, счётчик — по остатку', async () => {
    await sessionManager.enqueueSteerMessage(sessionId, notice('<process>ok</process>'));
    await sessionManager.enqueueSteerMessage(sessionId, makeSteerMessage('пользовательское 1'));
    await sessionManager.enqueueSteerMessage(sessionId, makeSteerMessage('пользовательское 2'));

    const requeued: Message[][] = [];
    const dropped: SteerDroppedEvent[] = [];

    await dropSteerInjections({
      sessionManager,
      sessionId,
      reason: 'aborted',
      streamId: 'st1',
      publishDropped: (e) => dropped.push(e),
      isRequeuable: isBackgroundNoticeMessage,
      requeue: async (messages) => {
        requeued.push(messages);
        return { requeued: messages.length, dropped: 0 };
      },
    });

    // Уведомление вернули один раз; дроп — ровно по двум остальным.
    expect(requeued).toHaveLength(1);
    expect(requeued[0]).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ reason: 'aborted', dropped_count: 2, stream_id: 'st1' });
  });

  it('повторный вызов — no-op: сообщение не попадает в очередь дважды', async () => {
    await sessionManager.enqueueSteerMessage(sessionId, makeSteerMessage('один раз'));
    const requeue = vi.fn(async (messages: Message[]) => ({
      requeued: messages.length,
      dropped: 0,
    }));

    await dropSteerInjections({
      sessionManager,
      sessionId,
      reason: 'turn_ended',
      publishDropped: () => {},
      requeue,
    });
    // «Стоп» и следом финализация хода: второй вызов видит пустую очередь.
    const second = await dropSteerInjections({
      sessionManager,
      sessionId,
      reason: 'aborted',
      publishDropped: () => {},
      requeue,
    });

    expect(second).toEqual([]);
    expect(requeue).toHaveBeenCalledTimes(1);
  });

  it('пустая очередь: ни requeue, ни события', async () => {
    const requeue = vi.fn(async () => {});
    const publishDropped = vi.fn();

    const cleared = await dropSteerInjections({
      sessionManager,
      sessionId,
      reason: 'turn_ended',
      publishDropped,
      isRequeuable: isBackgroundNoticeMessage,
      requeue,
    });

    expect(cleared).toEqual([]);
    expect(requeue).not.toHaveBeenCalled();
    expect(publishDropped).not.toHaveBeenCalled();
  });
});
