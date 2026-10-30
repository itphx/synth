/**
 * ADR-095 (шаг 6a): собственные тесты локальных ответов `/`-команд (ADR-046 §7).
 *
 * Контракты:
 *  - `publishLocalCompletion` завершает локальный ответ как **ход из одного
 *    шага** (`turn.started` → `step.started` → `part.delta` → `step.finished` →
 *    `turn.finished`) — иначе клиент не увидит ни хода, ни его содержимого;
 *  - `finishLocalCommand` помечает user-команду и ответ эфемерными, сохраняет
 *    user-сообщение ДО `addMessage` (иначе `updateSession` перезапишет сессию),
 *    публикует upsert user-команды и отдаёт реальные `message_index`/`message_id`.
 *
 * ADR-118 §4: `stream.chunk`/`stream.done` удалены без dual-emit; расход шага
 * едет в `step.finished.usage`, а `duration_ms`/`metadata`/`message_index` из
 * контракта события убраны.
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
  it('публикует ход из одного шага: turn.started → step.started → part.delta → step.finished → turn.finished', () => {
    const published: Published[] = [];
    publishLocalCompletion((event, data) => published.push({ event, data }), 's1', 'ответ');

    expect(published.map((p) => p.event)).toEqual([
      'turn.started',
      'step.started',
      'part.delta',
      'step.finished',
      'turn.finished',
    ]);
    const turnId = 'turn_s1';
    const messageId = 'msg_s1';
    expect(published[0]!.data).toEqual({ turnId, messageId });
    expect(published[1]!.data).toEqual({ turnId, stepIndex: 0, messageId });
    expect(published[2]!.data).toEqual({
      messageId,
      partId: 'msg:text:0',
      field: 'text',
      delta: 'ответ',
    });
    expect(published[3]!.data).toEqual({
      turnId,
      stepIndex: 0,
      messageId,
      status: 'completed',
    });
    expect(published[4]!.data).toEqual({ turnId, status: 'completed' });
    // ADR-118 §4: прежние поля `stream.done` (`pending_count`/`message_index`/
    // `message_id`/`usage`/`duration_ms`) в контракте события больше нет.
    expect(published[3]!.data).not.toHaveProperty('usage');
    expect(published[3]!.data).not.toHaveProperty('duration_ms');
    expect(published[3]!.data).not.toHaveProperty('message_index');
    expect(published[3]!.data).not.toHaveProperty('message_id');
  });

  it('model/provider/usage прокидываются в step.finished, messageId шага — заданный', () => {
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

    const finished = published.find((p) => p.event === 'step.finished')!;
    expect(finished.data).toMatchObject({
      turnId: 'turn_s1',
      stepIndex: 0,
      messageId: 'msg-1',
      status: 'completed',
      model: 'micro:small_talk',
      provider: 'micro',
      usage,
    });
    // `duration_ms`/`metadata`/`message_index` в ADR-118-контракт шага не входят.
    expect(finished.data).not.toHaveProperty('duration_ms');
    expect(finished.data).not.toHaveProperty('metadata');
    expect(finished.data).not.toHaveProperty('message_index');
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

  async function setup(settings: Record<string, unknown> = { agentRole: 'fixer' }) {
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
      agentRole: 'fixer',
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

  it('ADR-118 §1: часть сохранённого ответа — с id `msg:text:0` (как в стриме)', async () => {
    const { session, userMessage } = await setup();
    const published: Published[] = [];

    await finishLocalCommand(
      session, userMessage, (event, data) => published.push({ event, data }), 'вывод /help', 'stream1',
      { name: 'help' },
      { sessionManager, eventBus, publishLocalCompletion },
    );

    const stored = (await sessionManager.getSession(session.id))!;
    const assistant = stored.messages[1]!;
    expect(assistant.parts.map((p) => p.id)).toEqual(['msg:text:0']);
    // Тот же id, что и в опубликованной дельте текста шага.
    const delta = published.find((p) => p.event === 'part.delta')!;
    expect(delta.data.partId).toBe('msg:text:0');
    expect(delta.data.messageId).toBe(assistant.id);
  });

  it('agentRole берётся из user-сообщения, при отсутствии — из настроек сессии', async () => {    const withRole = await setup({ agentRole: 'fixer' });
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
