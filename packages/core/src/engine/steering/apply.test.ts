/**
 * ADR-104 + ADR-115: общая точка применения инъекций — в событии
 * `message.injected` должны быть части сообщения (медиа — иначе UI не покажет
 * вложение в живой ленте).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { applySteerInjections } from './apply.js';
import type { SteerInjectedEvent } from './apply.js';
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
