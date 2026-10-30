/**
 * ADR-104 (этап 2): прерывание текущей генерации (`interrupt`).
 *
 * Отличие от «Стоп» (`cancel`, ADR-005): ход НЕ завершается и НЕ
 * отменяется — обрывается только текущая генерация, цикл Tool Use
 * продолжается, сообщение пользователя вплетается на ближайшей границе шага.
 *
 * Проверяем:
 * - прерванная генерация закрывает шаг `step.finished` со статусом `cancelled`
 *   (ADR-118 §4 — замена удалённого `stream.interrupted`), а НЕ ход
 *   `stream.cancelled`;
 * - ход продолжается: инъекция попадает в контекст, итоговый ответ есть;
 * - пары toolUse/toolResult не рвутся;
 * - «принципал» (ADR-106) и «потолок хода» (номер шага) не меняются.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { EventBus } from '../events/bus.js';
import { createToolRegistry } from './tools/index.js';
import { ContextConfig } from './context/config.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { AuthorityShadowInput } from './authority/hook.js';
import type { PermissionConfig, Message } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import { enqueueSteerMessage } from '../queue/processor.js';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeMessage(content = 'выполни задачу'): Message {
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
    metadata: { stream_id: generateId() },
  };
}

/**
 * Провайдер с тремя генерациями:
 * - вызов 0 — прерываемая генерация: частичный текст, затем запрос
 *   прерывания от теста (`onPartial`) и обрыв сетевого стрима (провайдер
 *   закрывает запрос, но `cancelled` НЕ выставляется);
 * - вызов 1 — tool call (`read_file`) + побочный эффект (тул выполняется);
 * - вызов 2 — финальный текст.
 *
 * Запросы к провайдеру сохраняются, чтобы проверить, что инъекция попала в
 * контекст ПОСЛЕ прерванной генерации, а пара assistant(toolUse) →
 * tool(toolResult) осталась целой.
 */
class MockInterruptProvider extends BaseProvider {
  static calls = 0;
  static captures: LLMMessage[][] = [];
  /** Вызывается после первого чанка — тест просит прервать генерацию. */
  static onPartial: ((n: number) => Promise<void> | void) | null = null;
  /** Токены отмены, которые видел провайдер (для проверки «не отмена»). */
  static tokens: CancellationToken[] = [];

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'Готово', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const n = MockInterruptProvider.calls++;
    MockInterruptProvider.captures.push(messages.map((m) => ({ ...m })));
    if (cancellationToken) MockInterruptProvider.tokens.push(cancellationToken);

    if (n === 0) {
      yield {
        content: 'Частичный ответ', isFinal: false,
        model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      // Пользователь просит прервать генерацию; после этого провайдер
      // обрывает сетевой стрим (как при `interrupt()` у реальных провайдеров).
      if (MockInterruptProvider.onPartial) await MockInterruptProvider.onPartial(n);
      return;
    }

    if (n === 1) {
      yield {
        content: 'Шаг 1: читаю файл', isFinal: true,
        toolCalls: [{
          id: 'call_s1',
          function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'missing.txt' }) },
        }],
        model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      return;
    }

    yield {
      content: 'Готово', isFinal: true,
      model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'mockinterrupt';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  eventBus: EventBus;
  tmpDir: string;
  sessionId: string;
  shadowInputs: AuthorityShadowInput[];
}

async function makeHarness(): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-interrupt-orch-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('Interrupt', 'u1', { workspace: tmpDir });
  await projectStore.save(project);
  const shadowInputs: AuthorityShadowInput[] = [];
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => {
      return { name, type: 'mockinterrupt', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
    },
    toolRegistry: createToolRegistry(),
    permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
    projectStore,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
    // ADR-106 Ф1: shadow-запись принципала хода (для проверки, что
    // прерывание принципала и ход не меняет).
    authorityShadow: (input: AuthorityShadowInput) => { shadowInputs.push(input); },
  });
  const session = await sessionManager.createSession({
    title: 'Interrupt',
    projectId: project.id,
    // Владелец сессии — владелец проекта (`u1`): принципал хода (ADR-106)
    // берётся из `session.ownerId`/`session.userId`.
    userId: 'u1',
    settings: { provider: 'mockinterrupt', model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
  });
  await sessionManager.addMessage(session.id, makeMessage());
  return { orchestrator, sessionManager, eventBus, tmpDir, sessionId: session.id, shadowInputs };
}

async function run(
  h: Harness,
  publishChunk: (event: string, data: Record<string, unknown>) => void,
): Promise<import('./orchestrator.js').ProcessMessageResult> {
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  return processMessage(fresh, userMsg, new AbortController().signal, publishChunk);
}

/**
 * `stream_id` хода — из метаданных реплики пользователя (оркестратор берёт
 * его оттуда). ADR-118 §4: `stream.chunk` с `stream_id` удалён, поэтому id
 * больше не «подсматривается» из событий стрима.
 */
async function streamIdOf(h: Harness): Promise<string> {
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  return (userMsg.metadata as Record<string, unknown>).stream_id as string;
}

describe('ChatOrchestrator: прерывание генерации (ADR-104, этап 2)', () => {
  beforeEach(() => {
    ProviderFactory.register('mockinterrupt', MockInterruptProvider);
    MockInterruptProvider.calls = 0;
    MockInterruptProvider.captures = [];
    MockInterruptProvider.onPartial = null;
    MockInterruptProvider.tokens = [];
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('mockinterrupt');
  });

  it('прерывание: step.finished со статусом cancelled, ход продолжается, stream.cancelled не публикуется', async () => {
    const h = await makeHarness();
    const streamId = await streamIdOf(h);

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    // Флаг `interrupted` оркестратор снимает на границе шага (`continue` в
    // цикле Tool Use) — поэтому его проверяем СРАЗУ после запроса
    // прерывания (внутри `onPartial`), а не после завершения хода.
    let interruptedAtRequest: boolean | undefined;
    // Пользователь просит прервать генерацию: инъекция с маркером
    // `interrupt` + прерывание живого стрима.
    MockInterruptProvider.onPartial = async () => {
      await enqueueSteerMessage(
        h.sessionManager, h.eventBus, h.sessionId, makeMessage('Остановись, сделай иначе'),
        10, undefined, { interrupt: true },
      );
      expect(h.orchestrator.interrupt(streamId)).toBe(true);
      interruptedAtRequest = MockInterruptProvider.tokens[0]!.interrupted;
    };

    const result = await run(h, (event, data) => {
      chunks.push({ event, data });
    });
    expect(result.error).toBeUndefined();

    // ADR-118 §4: `stream.interrupted` удалён — прерывание генерации
    // закрывает шаг статусом `cancelled` (это НЕ отмена хода). Частичный
    // текст — в сохранённом сообщении шага (в событии контента нет).
    const interrupted = chunks.find(
      (c) => c.event === 'step.finished' && c.data.status === 'cancelled',
    );
    expect(interrupted).toBeDefined();
    expect(interrupted!.data).toMatchObject({
      turnId: expect.any(String),
      stepIndex: 0,
      status: 'cancelled',
      provider: 'mockinterrupt',
      model: 'm',
      agentRole: 'fixer',
    });
    expect(interrupted!.data).not.toHaveProperty('reason');
    expect(interrupted!.data).not.toHaveProperty('stream_id');

    const interruptedSession = (await h.sessionManager.getSession(h.sessionId))!;
    const partial = interruptedSession.messages.find((m) => m.metadata?.interrupted === true);
    expect(partial!.content).toBe('Частичный ответ');

    // Отмены хода не было.
    expect(chunks.find((c) => c.event === 'stream.cancelled')).toBeUndefined();
    expect(chunks.find((c) => c.event === 'stream.error')).toBeUndefined();

    // Ход продолжился и завершился штатно: ровно один `turn.finished`
    // со статусом `completed` (замена удалённого `stream.done`).
    const turns = chunks.filter((c) => c.event === 'turn.finished');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.data.status).toBe('completed');

    // Токен провайдера: прерывание — не отмена (`cancelled` не выставлен).
    expect(MockInterruptProvider.tokens.length).toBeGreaterThan(0);
    expect(MockInterruptProvider.tokens[0]!.cancelled).toBe(false);
    expect(interruptedAtRequest).toBe(true);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('сообщение пользователя вплетается в тот же ход после прерывания', async () => {
    const h = await makeHarness();
    const streamId = await streamIdOf(h);

    MockInterruptProvider.onPartial = async () => {
      await enqueueSteerMessage(
        h.sessionManager, h.eventBus, h.sessionId, makeMessage('Остановись, сделай иначе'),
        10, undefined, { interrupt: true },
      );
      h.orchestrator.interrupt(streamId);
    };

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    await run(h, (event, data) => {
      chunks.push({ event, data });
    });

    // Три генерации: прерванная, повторная (tool call) и финальная.
    expect(MockInterruptProvider.captures).toHaveLength(3);

    // Инъекция попала в контекст ПОСЛЕ прерванной генерации.
    const first = MockInterruptProvider.captures[0]!;
    expect(first.some((m) => m.content.includes('Остановись, сделай иначе'))).toBe(false);
    const second = MockInterruptProvider.captures[1]!;
    expect(second.some((m) => m.content.includes('Остановись, сделай иначе'))).toBe(true);

    // Инъекция персистится в истории как user-сообщение с маркерами
    // вмешательства и прерывания.
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const injected = session.messages.find((m) => m.content === 'Остановись, сделай иначе');
    expect(injected).toBeDefined();
    expect(injected!.role).toBe(MessageRole.USER);
    expect(injected!.metadata?.steer).toBe(true);
    expect(injected!.metadata?.interrupt).toBe(true);

    // Прерванная генерация сохранена отдельным сообщением со статусом
    // `interrupted` — ход не «закрыт».
    const partial = session.messages.find((m) => m.metadata?.interrupted === true);
    expect(partial).toBeDefined();
    expect(partial!.role).toBe(MessageRole.ASSISTANT);
    expect(partial!.metadata?.status).toBe('interrupted');
    expect(partial!.content).toContain('Частичный ответ');

    // Итоговый ответ хода есть.
    const final = session.messages.find((m) => m.content === 'Готово');
    expect(final).toBeDefined();
    expect(final!.role).toBe(MessageRole.ASSISTANT);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('пары toolUse/toolResult целы: прерванная генерация не оставляет висячих пар', async () => {
    const h = await makeHarness();
    const streamId = await streamIdOf(h);

    MockInterruptProvider.onPartial = async () => {
      await enqueueSteerMessage(
        h.sessionManager, h.eventBus, h.sessionId, makeMessage('Остановись, сделай иначе'),
        10, undefined, { interrupt: true },
      );
      h.orchestrator.interrupt(streamId);
    };

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    await run(h, (event, data) => {
      chunks.push({ event, data });
    });

    const session = (await h.sessionManager.getSession(h.sessionId))!;

    // Прерванный ответ — без tool-вызовов (вызова не было: генерация
    // оборвалась до его выполнения).
    const partial = session.messages.find((m) => m.metadata?.interrupted === true)!;
    expect(partial.toolCalls).toBeUndefined();

    // Пара assistant(toolUse) → tool(toolResult) — соседняя в истории.
    const assistantIdx = session.messages.findIndex(
      (m) => m.role === MessageRole.ASSISTANT && Array.isArray(m.toolCalls) && m.toolCalls.length > 0,
    );
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    const toolMsg = session.messages[assistantIdx + 1]!;
    expect(toolMsg.role).toBe(MessageRole.TOOL);
    expect(toolMsg.toolCallId).toBe('call_s1');

    // «Висячих» tool-сообщений (без парного assistant с toolUse) нет.
    let pendingToolUse = 0;
    for (const m of session.messages) {
      if (m.role === MessageRole.ASSISTANT && Array.isArray(m.toolCalls)) {
        pendingToolUse += m.toolCalls.length;
      } else if (m.role === MessageRole.TOOL) {
        pendingToolUse -= 1;
      }
      expect(pendingToolUse).toBeGreaterThanOrEqual(0);
    }
    expect(pendingToolUse).toBe(0);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('принципал и потолок хода не меняются: тот же ход, тот же номер шага', async () => {
    const h = await makeHarness();
    const streamId = await streamIdOf(h);

    MockInterruptProvider.onPartial = async () => {
      await enqueueSteerMessage(
        h.sessionManager, h.eventBus, h.sessionId, makeMessage('Остановись, сделай иначе'),
        10, undefined, { interrupt: true },
      );
      h.orchestrator.interrupt(streamId);
    };

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    await run(h, (event, data) => {
      chunks.push({ event, data });
    });

    // Потолок хода: прерывание НЕ съедает шаг — повторная генерация
    // (`step.started` после прерывания) идёт с тем же `stepIndex`, что и
    // прерванная. ADR-118 §4: отдельного `stream.interrupted` нет, прерванный
    // шаг закрыт `step.finished` со статусом `cancelled`.
    const interruptedIdx = chunks.findIndex(
      (c) => c.event === 'step.finished' && c.data.status === 'cancelled',
    );
    expect(interruptedIdx).toBeGreaterThanOrEqual(0);
    const interruptedStepIndex = chunks[interruptedIdx]!.data.stepIndex as number;
    const resumedStep = chunks.slice(interruptedIdx + 1).find((c) => c.event === 'step.started');
    expect(resumedStep).toBeDefined();
    expect(resumedStep!.data.stepIndex).toBe(interruptedStepIndex);

    // Номер шага не убывает по ходу хода.
    const stepIndexes = chunks
      .filter((c) => c.event === 'step.started')
      .map((c) => c.data.stepIndex as number);
    expect(stepIndexes.length).toBeGreaterThan(1);
    for (let i = 1; i < stepIndexes.length; i++) {
      expect(stepIndexes[i]!).toBeGreaterThanOrEqual(stepIndexes[i - 1]!);
    }

    // Принципал хода (ADR-106) не меняется: все решения shadow-контура —
    // с тем же принципалом, агентом и идентификатором хода.
    expect(h.shadowInputs.length).toBeGreaterThan(0);
    const principals = h.shadowInputs.map((i) => JSON.stringify(i.principal));
    expect(new Set(principals).size).toBe(1);
    expect(h.shadowInputs[0]!.principal?.kind).toBe('user');
    expect(h.shadowInputs[0]!.principal?.id).toBe('u1');
    expect(h.shadowInputs[0]!.agentId).toBe('fixer');
    expect(new Set(h.shadowInputs.map((i) => i.turnId)).size).toBe(1);
    expect(h.shadowInputs[0]!.turnId).toBe(streamId);

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});
