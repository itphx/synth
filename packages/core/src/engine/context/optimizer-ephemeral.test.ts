import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextOptimizer } from './optimizer.js';
import { ContextConfig } from './config.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { MessageRole, generateId, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message, SummarizationConfig, ProviderConfig } from '@itphx/synth-shared';
import type { Session } from '@itphx/synth-shared';

let tmpDir: string;
let sessionManager: SessionManager;
let optimizer: ContextOptimizer;

const summarization: SummarizationConfig = { provider: 'p', model: 'm', temperature: 0.3, promptFile: 'SUMMARIZING' };

function msg(role: Message['role'], content: string, ephemeral = false): Message {
  return {
    id: generateId(), role, seq: 0, origin: 'local', parts: [makeTextPart(content)], content,
    createdAt: nowISO(), disabled: false, pinned: false, hidden: false,
    ...(ephemeral ? { ephemeral: true } : {}),
  };
}

async function sessionWith(messages: Message[]): Promise<Session> {
  const session = await sessionManager.createSession({ settings: { contextOptimization: 'none' } });
  session.messages = messages;
  return session;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-ctx-ephemeral-'));
  sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const config = new ContextConfig({ userDataDir: join(tmpDir, 'context') });
  optimizer = new ContextOptimizer(
    config,
    (_name: string) => null as ProviderConfig | null,
    summarization,
    () => 0,
  );
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('исключение ephemeral-сообщений из LLM-контекста (ADR-046 §7.1)', () => {
  it('локальные user+assistant команды не попадают в контекст', async () => {
    const session = await sessionWith([
      msg(MessageRole.USER, '/help', true),
      msg(MessageRole.ASSISTANT, 'справка', true),
      msg(MessageRole.USER, 'обычный запрос'),
    ]);
    const out = optimizer.getMessagesForLlm(session);
    expect(out.map((m) => m.content)).toEqual(['обычный запрос']);
  });

  it('обычные сообщения остаются', async () => {
    const session = await sessionWith([
      msg(MessageRole.USER, 'вопрос'),
      msg(MessageRole.ASSISTANT, 'ответ'),
    ]);
    expect(optimizer.getMessagesForLlm(session)).toHaveLength(2);
  });
});
