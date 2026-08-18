import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionReferenceTool } from './read-reference.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import type { ToolContext } from '@itphx/shared';
import { generateId, MessageRole, nowISO } from '@itphx/shared';

describe('read_session_reference', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-ref-tool-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    const session = await sessionManager.createSession({ title: 'Reference test' });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: { sessionManager, sessionId },
    };
  }

  it('читает сообщения referenced-сессии', async () => {
    const ref = await sessionManager.createSession({ title: 'Ref' });
    await sessionManager.addMessage(ref.id, {
      id: generateId(),
      role: MessageRole.USER,
      seq: 1,
      origin: 'local',
      content: 'содержимое referenced-сессии',
      parts: [],
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
    });

    const result = await readSessionReferenceTool.execute({ session_id: ref.id }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('# Сессия: Ref');
    expect(result.content).toContain('содержимое referenced-сессии');
  });

  it('не принимает path/cwd-параметры от агента', () => {
    const shape = (readSessionReferenceTool.parameters as { shape?: Record<string, unknown> }).shape ?? {};
    expect(Object.keys(shape)).toEqual(['session_id', 'message_range']);
  });
});
