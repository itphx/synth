import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './manager.js';
import { FileStore } from '../storage/file-store.js';
import type { Message } from '@itphx/synth-shared';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';

function message(partial: Partial<Message> & Pick<Message, 'role' | 'content'>): Message {
  return {
    id: generateId(),
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(partial.content)],
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ...partial,
  };
}

describe('SessionManager.recoverStreamingMessages (шаг 2б)', () => {
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-recover-'));
    manager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('помечает streaming-сообщения прерванными', async () => {
    const session = await manager.createSession({ title: 'Recovery' });
    await manager.appendMessage(session.id, message({
      role: MessageRole.ASSISTANT,
      content: 'частичный ответ',
      metadata: { stream_id: 's1', streaming: true },
    }));

    const changed = await manager.recoverStreamingMessages(session.id);
    expect(changed).toBe(1);

    const stored = (await manager.getSession(session.id))!;
    const assistant = stored.messages[0]!;
    expect(assistant.metadata).toMatchObject({
      streaming: false,
      interrupted: true,
      status: 'error',
    });
    expect(assistant.content).toBe('частичный ответ');
  });

  it('отключает assistant(tool_calls) без пары, парные не трогает', async () => {
    const session = await manager.createSession({ title: 'Recovery pairs' });
    // Осиротевший вызов (tool-результата нет) — должен стать disabled.
    await manager.appendMessage(session.id, message({
      role: MessageRole.ASSISTANT,
      content: 'шаг 1',
      toolCalls: [{ id: 'call_orphan', function: { name: 'read_file', arguments: '{}' } }],
      metadata: { stream_id: 's1', tool_chain: true },
    }));
    // Парный вызов: assistant + tool — не трогаем.
    await manager.appendMessage(session.id, message({
      role: MessageRole.ASSISTANT,
      content: 'шаг 2',
      toolCalls: [{ id: 'call_ok', function: { name: 'read_file', arguments: '{}' } }],
      metadata: { stream_id: 's1', tool_chain: true },
    }));
    await manager.appendMessage(session.id, message({
      role: MessageRole.TOOL,
      content: 'результат',
      toolCallId: 'call_ok',
      metadata: { stream_id: 's1', tool_chain: true },
    }));

    const changed = await manager.recoverStreamingMessages(session.id);
    expect(changed).toBe(1);

    const stored = (await manager.getSession(session.id))!;
    const orphan = stored.messages.find((m) => m.toolCalls?.some((c) => c.id === 'call_orphan'))!;
    const paired = stored.messages.find((m) => m.toolCalls?.some((c) => c.id === 'call_ok'))!;
    expect(orphan.disabled).toBe(true);
    expect(orphan.metadata?.interrupted).toBe(true);
    expect(paired.disabled).toBe(false);
    expect(paired.metadata?.interrupted).toBeUndefined();
  });

  it('не пишет сессию, если нечего исправлять', async () => {
    const session = await manager.createSession({ title: 'Clean' });
    await manager.appendMessage(session.id, message({
      role: MessageRole.ASSISTANT,
      content: 'готовый ответ',
      metadata: { stream_id: 's1' },
    }));

    const before = (await manager.getSession(session.id))!;
    const changed = await manager.recoverStreamingMessages(session.id);
    const after = (await manager.getSession(session.id))!;

    expect(changed).toBe(0);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.messages).toEqual(before.messages);
  });
});
