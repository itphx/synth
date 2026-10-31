/**
 * Видимость tool-chain в истории сессии (маркер `metadata.tool_chain`).
 *
 * `tool_chain` — маркер «служебное сообщение, скрыть в транскрипте»
 * (UI: `isVisibleMessage`). Ставить его можно ТОЛЬКО сообщениям без
 * видимого текста: шаг с текстом — реальный ответ агента, и после
 * перезагрузки страницы он обязан остаться в истории (иначе ответ
 * «исчезает»).
 *
 * Проверяем четыре сценария:
 *  - шаг с текстом + вызовы инструментов → маркера нет, текст виден в DTO;
 *  - шаг только с вызовами инструментов (без текста) → `tool_chain: true`;
 *  - tool-результат → `tool_chain: true` (всегда);
 *  - отмена хода → в истории нет двух записей с одинаковым `id`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrchestrator } from '../orchestrator.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { EventBus } from '../../events/bus.js';
import { createToolRegistry } from '../tools/index.js';
import { ContextConfig } from '../context/config.js';
import { ProviderFactory, BaseProvider } from '../../providers/base.js';
import type { LLMMessage, CancellationToken } from '../../providers/base.js';
import type { ContextBuilder } from '../context/builder.js';
import type { PermissionConfig, ToolDefinition, Message } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart, makeMediaPart, ToolCapability } from '@itphx/synth-shared';
import { serializeMessage } from '../../server/serialize.js';
import { hasVisibleStepContent } from './persistence.js';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeUserMessage(): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('выполни задачу')],
    content: 'выполни задачу',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

/** Тул-заглушка: работает мгновенно (для сценариев без отмены). */
function makeNoopTool(): ToolDefinition {
  return {
    name: 'noop_tool',
    description: 'тестовый тул без побочных эффектов',
    parameters: z.object({}),
    capabilities: [ToolCapability.RUNTIME],
    async execute() {
      return { content: 'noop_tool: ок' };
    },
  } as unknown as ToolDefinition;
}

/** Тул, который «работает», пока его не прервут через ctx.abortSignal. */
function makeSlowAbortableTool(): ToolDefinition {
  return {
    name: 'slow_tool',
    description: 'тестовый долгий тул — завершается при отмене',
    parameters: z.object({}),
    capabilities: [ToolCapability.RUNTIME],
    async execute(_args: Record<string, unknown>, ctx: { abortSignal?: AbortSignal }) {
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal?.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { content: 'slow_tool: прерван отменой' };
    },
  } as unknown as ToolDefinition;
}

/**
 * Провайдер с двумя шагами: первый — вызов инструмента (с текстом или без —
 * см. `withText`), второй — финальный текст.
 */
class TwoStepProvider extends BaseProvider {
  /** Текст первого шага (пусто → шаг без видимого текста). */
  static withText = 'Читаю файл';
  /** Имя вызываемого тула. */
  static toolName = 'noop_tool';

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'done', model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  async *chatAsync(
    messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const hasToolResult = messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      yield {
        content: TwoStepProvider.withText,
        isFinal: false,
        toolCalls: [{
          id: 'call_1',
          type: 'function',
          function: { name: TwoStepProvider.toolName, arguments: '{}' },
        }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: this.model,
      };
      return;
    }
    yield {
      content: 'Готово',
      isFinal: false,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      model: this.model,
    };
  }

  getProviderName(): string {
    return 'mocktwostep';
  }
}

/**
 * Провайдер для сценария отмены: первый шаг — текст + вызов `slow_tool`,
 * второй шаг не должен наступить (ход отменяется во время тула).
 */
class CancelDuringToolProvider extends BaseProvider {
  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: '', model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  async *chatAsync(
    messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const hasToolResult = messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      yield {
        content: 'Запускаю долгий тул', isFinal: true,
        toolCalls: [{ id: 'call_slow', function: { name: 'slow_tool', arguments: '{}' } }],
        model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      return;
    }
    // Второй шаг не должен начаться: ход отменяется во время исполнения тула.
    while (!ct?.cancelled) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  getProviderName(): string {
    return 'mockcanceltool';
  }
}

/**
 * Провайдер для сценария серии отказов: каждый шаг — один и тот же вызов
 * `execute_shell` с опасной командой (отказ по системной shell-политике).
 * Пять одинаковых отказов подряд завершают ход (doom-loop по deny).
 */
class AlwaysDenyProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: '', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield {
      content: '', isFinal: true,
      toolCalls: [{ id: 'call_deny', function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'rm -rf /' }) } }],
      model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'mockalwaysdeny';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  tmpDir: string;
  sessionId: string;
}

async function makeHarness(providerName: string, toolRegistry = createToolRegistry()): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-toolchain-vis-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  // ADR-075: file/shell/git-тулы доступны только при заданном workspace проекта.
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('ToolChainVis', 'u1', { workspace: tmpDir });
  await projectStore.save(project);
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => {
      return { name, type: providerName, baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
    },
    toolRegistry,
    permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
    projectStore,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
  });
  const session = await sessionManager.createSession({
    title: 'ToolChainVis',
    projectId: project.id,
    settings: { provider: providerName, model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
  });
  const msg = makeUserMessage();
  await sessionManager.addMessage(session.id, msg);
  return { orchestrator, sessionManager, tmpDir, sessionId: session.id };
}

async function run(
  h: Harness,
  signal: AbortSignal,
  publishChunk: (event: string, data: Record<string, unknown>) => void = () => {},
): Promise<import('../orchestrator.js').ProcessMessageResult> {
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  return processMessage(fresh, userMsg, signal, publishChunk);
}

describe('Видимость tool-chain: маркер metadata.tool_chain', () => {
  beforeEach(() => {
    ProviderFactory.register('mocktwostep', TwoStepProvider);
    ProviderFactory.register('mockcanceltool', CancelDuringToolProvider);
    ProviderFactory.register('mockalwaysdeny', AlwaysDenyProvider);
    TwoStepProvider.withText = 'Читаю файл';
    TwoStepProvider.toolName = 'noop_tool';
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('mocktwostep');
    ProviderFactory['_providers'].delete('mockcanceltool');
    ProviderFactory['_providers'].delete('mockalwaysdeny');
  });

  it('шаг с текстом: маркера tool_chain нет, текст виден в DTO', async () => {
    const toolRegistry = createToolRegistry();
    toolRegistry.register(makeNoopTool());
    const h = await makeHarness('mocktwostep', toolRegistry);
    const result = await run(h, new AbortController().signal);
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const step = session.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0,
    );
    expect(step).toBeDefined();
    // Текст шага — реальный ответ агента: маркера `tool_chain` быть не должно
    // (иначе после перезагрузки страницы ответ пропадёт из транскрипта).
    expect(step!.metadata?.tool_chain).toBeUndefined();
    expect(step!.content).toBe('Читаю файл');

    // DTO отдаёт текст и части — ответ виден клиенту.
    const dto = serializeMessage(step!, 0);
    expect(dto.content).toBe('Читаю файл');
    expect(dto.parts.some((p) => p.type === 'text' && p.data === 'Читаю файл')).toBe(true);
    expect((dto.metadata as Record<string, unknown> | null)?.tool_chain).toBeUndefined();

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('шаг только с вызовами инструментов: шаг ВИДЕН (маркера tool_chain нет)', async () => {
    TwoStepProvider.withText = '';
    const toolRegistry = createToolRegistry();
    toolRegistry.register(makeNoopTool());
    const h = await makeHarness('mocktwostep', toolRegistry);
    const result = await run(h, new AbortController().signal);
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const step = session.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0,
    );
    expect(step).toBeDefined();
    // ADR-118 §1: шаг с вызовами инструментов **виден** — на нём рисуются
    // карточки инструментов (`metadata.tool_results`), которые иначе
    // дублировались бы в финале хода. Маркера `tool_chain` у него нет.
    expect(step!.metadata?.tool_chain).toBeUndefined();
    expect(step!.content).toBe('');
    // Вызовы шага — в его собственном сообщении.
    const stepToolResults = step!.metadata?.tool_results as Array<Record<string, unknown>> | undefined;
    expect(stepToolResults).toBeDefined();
    expect(stepToolResults).toHaveLength(1);
    expect(stepToolResults![0]!.id).toBe('call_1');

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('шаг без контента и без вызовов: скрыт (видимости нет)', async () => {
    // Проверка уровня правила видимости: шаг без видимого контента и без
    // вызовов инструментов прячется (маркер `tool_chain`), шаг с вызовами —
    // виден (см. кейс выше).
    expect(hasVisibleStepContent('', [])).toBe(false);
    expect(hasVisibleStepContent(undefined, undefined)).toBe(false);
    // Reasoning без текста — тоже не видимый контент.
    expect(hasVisibleStepContent('', [
      { id: generateId(), type: 'reasoning', data: 'думаю' },
    ], { includeReasoning: false })).toBe(false);
  });

  it('tool-результат: маркер tool_chain = true (всегда)', async () => {
    const toolRegistry = createToolRegistry();
    toolRegistry.register(makeNoopTool());
    const h = await makeHarness('mocktwostep', toolRegistry);
    const result = await run(h, new AbortController().signal);
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const toolMsg = session.messages.find((m) => m.role === MessageRole.TOOL);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.metadata?.tool_chain).toBe(true);
    expect(toolMsg!.toolCallId).toBe('call_1');

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('отмена во время тула: в истории нет двух сообщений с одинаковым id', async () => {
    const toolRegistry = createToolRegistry();
    toolRegistry.register(makeSlowAbortableTool());
    const h = await makeHarness('mockcanceltool', toolRegistry);

    const controller = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, controller.signal, (event, data) => {
      chunks.push({ event, data });
      // Тул запущен — жмём «Стоп».
      if (event === 'tool_call.started') {
        setTimeout(() => controller.abort(), 10);
      }
    });
    expect(result.error).toBeUndefined();
    expect(chunks.some((c) => c.event === 'stream.cancelled')).toBe(true);

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    // Ключевой инвариант: id записей в истории уникальны. Раньше запись
    // отмены создавалась с id уже сохранённого tool-chain сообщения шага —
    // в истории оказывалось две записи с одинаковым id.
    const ids = session.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Запись отмены на месте: отдельное сообщение со статусом 'cancelled'.
    const cancelled = session.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && m.metadata?.status === 'cancelled',
    );
    expect(cancelled).toBeDefined();
    expect(cancelled!.id).not.toBe(
      session.messages.find((m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0)?.id,
    );

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('серия отказов (doom-loop по deny): в истории нет двух сообщений с одинаковым id', async () => {
    const h = await makeHarness('mockalwaysdeny');
    const result = await run(h, new AbortController().signal);
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    // Ход закрылся фоллбек-текстом после серии отказов: последний шаг с
    // вызовами инструментов уже сохранён, а финальное сообщение создаётся
    // заново — его id не должен совпадать с id tool-chain сообщения.
    const ids = session.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    const fallback = session.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) === 0,
    );
    expect(fallback).toBeDefined();
    expect(fallback!.id).not.toBe(
      session.messages.find((m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0)?.id,
    );

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});

describe('hasVisibleStepContent: видимость шага по его частям', () => {
  it('reasoning-часть без текста не видна, медиа-часть (ADR-115) — видна', () => {
    // Reasoning-часть с пустым текстом (так выглядит `redacted_thinking`) —
    // видимого контента в шаге нет: он прячется как tool_chain (иначе шаг
    // всплывал бы в транскрипте пустым пузырём).
    expect(hasVisibleStepContent('', [
      { id: generateId(), type: 'reasoning', data: '' },
    ])).toBe(false);
    expect(hasVisibleStepContent('', [
      { id: generateId(), type: 'reasoning', data: '   ' },
    ])).toBe(false);
    // С текстом — видимая.
    expect(hasVisibleStepContent('', [
      { id: generateId(), type: 'reasoning', data: 'думаю' },
    ])).toBe(true);

    // Медиа-часть ответа (ADR-115) — видимый контент: шаг с вложением не
    // должен прятаться как tool-chain.
    for (const type of ['image', 'audio', 'video', 'file'] as const) {
      expect(hasVisibleStepContent('', [
        makeMediaPart(type, {
          blobPath: `attachments/aa/${'a'.repeat(64)}`,
          sha256: 'a'.repeat(64),
          mime: type === 'file' ? 'application/pdf' : `${type}/png`,
          size: 1024,
        }),
      ])).toBe(true);
    }

    // Текстовая часть: с текстом — видимая, пустая — нет.
    expect(hasVisibleStepContent('', [makeTextPart('текст')])).toBe(true);
    expect(hasVisibleStepContent('', [makeTextPart('   ')])).toBe(false);
    // Текст в `content` — тоже видимый контент.
    expect(hasVisibleStepContent('ответ', undefined)).toBe(true);
    // Ничего нет — шаг без видимого содержимого.
    expect(hasVisibleStepContent(undefined, undefined)).toBe(false);
    expect(hasVisibleStepContent('', [])).toBe(false);
  });
});
