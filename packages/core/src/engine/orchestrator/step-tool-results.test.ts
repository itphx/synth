/**
 * ADR-118 §1 (аудит): точечная запись `metadata.tool_results` сообщения шага.
 *
 * `_persistStepToolResults` пишет результаты вызовов **шага** (карточки
 * инструментов рисуются на своём шаге). Инварианты:
 *  1. запись точечная — меняется только `metadata.tool_results` сообщения с
 *     нужным `id` (остальные поля и остальная история не трогаются);
 *  2. запись идемпотентна — повтор с тем же набором не меняет запись;
 *  3. параллельные записи (append/`updateMessage` других сообщений) не
 *     теряются: история целиком не перезаписывается.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from '../orchestrator.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import type { ContextBuilder } from '../context/builder.js';
import { generateId, MessageRole, nowISO, makeTextPart, type Message } from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeAssistant(content: string): Message {
  return {
    id: generateId(),
    role: MessageRole.ASSISTANT,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    metadata: { stream_id: 'stream-1' },
  };
}

/** Прямой доступ к приватному методу оркестратора (как в других тестах). */
type PersistStepToolResults = (
  sessionId: string,
  messageId: string,
  toolResults: Array<Record<string, unknown>>,
) => Promise<void>;

describe('ADR-118 §1: _persistStepToolResults — точечная запись metadata.tool_results', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let orchestrator: ChatOrchestrator;
  let sessionId: string;
  let stepMessageId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-step-tool-results-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: () => null,
      defaultWorkingDir: tmpDir,
    });
    const session = await sessionManager.createSession({
      title: 'StepToolResults',
      userId: 'u1',
      settings: { provider: 'mock', model: 'm' },
    });
    sessionId = session.id;
    const step = makeAssistant('текст шага');
    stepMessageId = step.id;
    await sessionManager.addMessage(sessionId, step);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function persist(): PersistStepToolResults {
    return (orchestrator as unknown as {
      _persistStepToolResults: PersistStepToolResults;
    })._persistStepToolResults.bind(orchestrator);
  }

  it('пишет только metadata.tool_results у сообщения с нужным id', async () => {
    const toolResults = [{ id: 'call_1', name: 'noop_tool', iteration: 0 }];
    await persist()(sessionId, stepMessageId, toolResults);

    const session = (await sessionManager.getSession(sessionId))!;
    const step = session.messages.find((m) => m.id === stepMessageId)!;
    expect(step.metadata?.tool_results).toEqual(toolResults);
    // Остальные поля записи не изменились.
    expect(step.content).toBe('текст шага');
    expect(step.metadata?.stream_id).toBe('stream-1');
    // Прочие сообщения не тронуты.
    expect(session.messages).toHaveLength(1);
  });

  it('идемпотентно: повторная запись того же набора не меняет запись', async () => {
    const toolResults = [{ id: 'call_1', name: 'noop_tool', iteration: 0 }];
    await persist()(sessionId, stepMessageId, toolResults);
    const first = (await sessionManager.getSession(sessionId))!.messages
      .find((m) => m.id === stepMessageId)!;

    await persist()(sessionId, stepMessageId, toolResults);
    const second = (await sessionManager.getSession(sessionId))!.messages
      .find((m) => m.id === stepMessageId)!;

    expect(second.metadata?.tool_results).toEqual(first.metadata?.tool_results);
    expect(second.content).toBe('текст шага');
  });

  it('не теряет параллельный updateMessage другого сообщения', async () => {
    // Второе сообщение сессии — цель параллельного `updateMessage` (запись
    // шага обновляется точечно, чужие сообщения не затрагиваются).
    const other = makeAssistant('другое сообщение');
    await sessionManager.addMessage(sessionId, other);

    const toolResults = [{ id: 'call_1', name: 'noop_tool', iteration: 0 }];
    await Promise.all([
      persist()(sessionId, stepMessageId, toolResults),
      // Текст сообщения хранится в частях (`content` восстанавливается из
      // них при чтении) — меняем части.
      sessionManager.updateMessage(sessionId, {
        ...other,
        parts: [makeTextPart('обновлённое другое сообщение')],
        content: 'обновлённое другое сообщение',
      }),
    ]);

    const session = (await sessionManager.getSession(sessionId))!;
    // Параллельная запись на месте…
    expect(session.messages.some((m) => m.content === 'обновлённое другое сообщение')).toBe(true);
    // …и результаты вызовов записаны в сообщение шага.
    const step = session.messages.find((m) => m.id === stepMessageId)!;
    expect(step.metadata?.tool_results).toEqual(toolResults);
    expect(step.content).toBe('текст шага');
  });

  it('не теряет параллельный append', async () => {
    const toolResults = [{ id: 'call_1', name: 'noop_tool', iteration: 0 }];
    await Promise.all([
      persist()(sessionId, stepMessageId, toolResults),
      sessionManager.addMessage(sessionId, makeAssistant('параллельное сообщение')),
    ]);

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.messages.some((m) => m.content === 'параллельное сообщение')).toBe(true);
    const step = session.messages.find((m) => m.id === stepMessageId)!;
    expect(step.metadata?.tool_results).toEqual(toolResults);
  });

  it('неизвестное сообщение — no-op, ход не падает', async () => {
    await expect(persist()(sessionId, 'нет-такого', [{ id: 'call_1' }])).resolves.toBeUndefined();
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.messages[0]!.metadata?.tool_results).toBeUndefined();
  });
});
