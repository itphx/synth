/**
 * ADR-095 (шаг 6a): собственные тесты локальных ответов `/`-команд (ADR-046 §7).
 *
 * Контракты:
 *  - `publishLocalCompletion` завершает стрим теми же событиями, что обычный
 *    ответ (`stream.chunk` + `stream.done`) — иначе SSE-цикл промпта не закрывается;
 *  - `finishLocalCommand` помечает user-команду и ответ эфемерными, сохраняет
 *    user-сообщение ДО `addMessage` (иначе `updateSession` перезапишет сессию),
 *    публикует upsert user-команды и отдаёт реальные `message_index`/`message_id`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { BusEvent, Message, Session, TokenUsage } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBus } from '../../events/bus.js';
import { publishLocalCompletion, finishLocalCommand } from './commands.js';

type Published = { event: string; data: Record<string, unknown> };

function makeUserMessage(content = '/help'): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: 'stream1' },
  };
}

describe('publishLocalCompletion', () => {
  it('публикует stream.chunk (is_final) и stream.done с дефолтами command', () => {
    const published: Published[] = [];
    publishLocalCompletion((event, data) => published.push({ event, data }), 's1', 'ответ');

    expect(published.map((p) => p.event)).toEqual(['stream.chunk', 'stream.done']);
    expect(published[0]!.data).toEqual({ stream_id: 's1', content: 'ответ', is_final: true });
    expect(published[1]!.data).toMatchObject({
      stream_id: 's1',
      content: 'ответ',
      pending_count: 0,
      model: 'command',
      provider: 'command',
    });
    expect(published[1]!.data).not.toHaveProperty('message_index');
    expect(published[1]!.data).not.toHaveProperty('message_id');
    expect(published[1]!.data).not.toHaveProperty('usage');
    expect(published[1]!.data).not.toHaveProperty('duration_ms');
  });

  it('model/provider/usage/duration/metadata и index/id прокидываются, когда заданы', () => {
    const published: Published[] = [];
    const usage: TokenUsage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
    publishLocalCompletion(
      (event, data) => published.push({ event, data }),
      's1',
      'ответ',
      {
        model: 'micro:small_talk',
        provider: 'micro',
        usage,
        durationMs: 12,
        metadata: { command: true },
        messageIndex: 4,
        messageId: 'msg-1',
      },
    );

    expect(published[0]!.data).toMatchObject({ model: 'micro:small_talk', provider: 'micro' });
    expect(published[1]!.data).toMatchObject({
      model: 'micro:small_talk',
      provider: 'micro',
      usage,
      duration_ms: 12,
      metadata: { command: true },
      message_index: 4,
      message_id: 'msg-1',
    });
  });
});

describe('finishLocalCommand', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let events: BusEvent[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-commands-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    events = [];
    unsubscribe = eventBus.subscribeAll((e) => events.push(e));
  });

  afterEach(async () => {
    unsubscribe();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup(settings: Record<string, unknown> = { agentRole: 'developer' }) {
    const session = await sessionManager.createSession({ title: 'Cmd', settings: settings as never });
    const userMessage = makeUserMessage();
    await sessionManager.addMessage(session.id, userMessage);
    const fresh = (await sessionManager.getSession(session.id))!;
    return { session: fresh, userMessage };
  }

  /** Обёртка с записью порядка вызовов (сравнение «сохранение user до addMessage»). */
  function recording(order: string[]): SessionManager {
    return {
      updateSession: async (s: Session) => {
        order.push('updateSession');
        await sessionManager.updateSession(s);
      },
      addMessage: async (sessionId: string, message: Message) => {
        order.push('addMessage');
        return sessionManager.addMessage(sessionId, message);
      },
      withLock: <T>(sessionId: string, fn: (s: never) => Promise<T>) => sessionManager.withLock(sessionId, fn as never),
      saveSession: (s: never) => sessionManager.saveSession(s as never),
      getSession: (sessionId: string) => sessionManager.getSession(sessionId),
    } as unknown as SessionManager;
  }

  it('сохраняет user-команду до addMessage и публикует upsert с commandPrompt', async () => {
    const { session, userMessage } = await setup();
    const order: string[] = [];
    const published: Published[] = [];
    const publishLocalCompletionSpy = vi.fn();

    const result = await finishLocalCommand(
      session, userMessage, (event, data) => published.push({ event, data }), 'вывод /help', 'stream1',
      { name: 'help', i18nKey: 'command.help' },
      {
        sessionManager: recording(order),
        eventBus,
        publishLocalCompletion: publishLocalCompletionSpy as never,
      },
    );

    expect(result).toEqual({});
    expect(order).toEqual(['updateSession', 'addMessage']);

    const stored = (await sessionManager.getSession(session.id))!;
    expect(stored.messages).toHaveLength(2);
    const [storedUser, assistant] = stored.messages;

    expect(storedUser!.ephemeral).toBe(true);
    expect(storedUser!.metadata).toMatchObject({ stream_id: 'stream1', commandPrompt: true });

    expect(assistant).toMatchObject({
      role: MessageRole.ASSISTANT,
      content: 'вывод /help',
      origin: 'local',
      ephemeral: true,
      model: 'command',
      provider: 'command',
      agentRole: 'developer',
      metadata: {
        command: true,
        commandName: 'help',
        commandArgs: '',
        i18n: { key: 'command.help' },
      },
    });

    // Upsert user-команды в UI (live message.added нёс metadata без commandPrompt)
    const added = events.filter((e) => e.type === 'message.added');
    expect(added).toHaveLength(1);
    expect(added[0]!.data).toMatchObject({
      message_index: 0,
      role: MessageRole.USER,
      content: '/help',
      metadata: { stream_id: 'stream1', commandPrompt: true },
    });

    // Завершение стрима — с реальными index/id сохранённого ответа
    expect(publishLocalCompletionSpy).toHaveBeenCalledTimes(1);
    expect(publishLocalCompletionSpy.mock.calls[0]!.slice(1)).toEqual([
      'stream1',
      'вывод /help',
      expect.objectContaining({
        model: 'command',
        provider: 'command',
        messageIndex: 1,
        messageId: assistant!.id,
        metadata: expect.objectContaining({ command: true, commandName: 'help' }),
      }),
    ]);
  });

  it('agentRole берётся из user-сообщения, при отсутствии — из настроек сессии', async () => {
    const withRole = await setup({ agentRole: 'developer' });
    const commandUser = { ...withRole.userMessage, agentRole: 'researcher' };
    await finishLocalCommand(
      withRole.session, commandUser, () => {}, 'out', 'stream1', { name: 'skills' },
      { sessionManager, eventBus, publishLocalCompletion: () => {} },
    );
    let stored = (await sessionManager.getSession(withRole.session.id))!;
    expect(stored.messages[1]!.agentRole).toBe('researcher');

    const fromSettings = await setup({ agentRole: 'assistant' });
    await finishLocalCommand(
      fromSettings.session, fromSettings.userMessage, () => {}, 'out', 'stream1', { name: 'skills' },
      { sessionManager, eventBus, publishLocalCompletion: () => {} },
    );
    stored = (await sessionManager.getSession(fromSettings.session.id))!;
    expect(stored.messages[1]!.agentRole).toBe('assistant');
  });

  it('без описания команды metadata содержит только признак command', async () => {
    const { session, userMessage } = await setup();
    const publishLocalCompletionSpy = vi.fn();

    await finishLocalCommand(
      session, userMessage, () => {}, 'out', 'stream1', undefined,
      { sessionManager, eventBus, publishLocalCompletion: publishLocalCompletionSpy as never },
    );

    const stored = (await sessionManager.getSession(session.id))!;
    expect(stored.messages[1]!.metadata).toEqual({ command: true });
    expect(publishLocalCompletionSpy.mock.calls[0]![3].metadata).toEqual({ command: true });
  });

  it('args и i18nKey команды попадают в metadata ответа и события', async () => {
    const { session, userMessage } = await setup();
    const published: Published[] = [];
    const publishLocalCompletionSpy = vi.fn();

    await finishLocalCommand(
      session, userMessage, (event, data) => published.push({ event, data }), 'вывод', 'stream1',
      { name: 'summary', args: '--force', i18nKey: 'command.summary_unavailable' },
      { sessionManager, eventBus, publishLocalCompletion: publishLocalCompletionSpy as never },
    );

    const metadata = (await sessionManager.getSession(session.id))!.messages[1]!.metadata;
    expect(metadata).toEqual({
      command: true,
      commandName: 'summary',
      commandArgs: '--force',
      i18n: { key: 'command.summary_unavailable' },
    });
    expect(publishLocalCompletionSpy.mock.calls[0]![3].metadata).toEqual(metadata);
    // publishLocalCompletion здесь подменён шпионом — реальные события не публикуются
    expect(published).toHaveLength(0);
  });
});
