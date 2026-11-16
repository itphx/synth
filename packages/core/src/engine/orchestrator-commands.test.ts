/**
 * ADR-126 §1/§8.2: ранний резолвинг `/`-команд в оркестраторе — локальный ответ
 * без LLM, событие `command.invoked`, эфемерные сообщения.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import type { BusEvent, CommandRuntime, CommandResolveResult, PermissionConfig } from '@itphx/synth-shared';
import type { ContextBuilder } from './context/builder.js';
import type { ContextOptimizer } from './context/optimizer.js';
import { generateId, MessageRole, nowISO, makeTextPart, type Message, type Session } from '@itphx/synth-shared';
import { stubContextFiles } from '../test-helpers/storage-stubs.js';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [],
  } as unknown as ContextBuilder;
}

function makeUserMessage(content: string): Message {
  return {
    id: generateId(), role: MessageRole.USER, seq: 0, origin: 'local',
    parts: [makeTextPart(content)], content, createdAt: nowISO(),
    disabled: false, pinned: false, hidden: false, author: 'user',
    metadata: { stream_id: generateId() },
  };
}

const resolveResult: CommandResolveResult = {
  status: 'builtin', name: 'help', args: '', kind: 'builtin', output: 'HELP TEXT',
};

let tmpDir: string;

/**
 * Минимальный оптимизатор контекста: проверка доступности сжатия + план.
 * Реальное сжатие не запускается — `_handleSummarization` подменён (см. `run`).
 */
function makeOptimizer(can: boolean): ContextOptimizer {
  return {
    setGatewayHooks: vi.fn(),
    canCompress: vi.fn(() => can),
    canSummarize: vi.fn(() => can),
    effectiveMode: vi.fn(() => 'compaction'),
    prepareCompression: vi.fn(),
  } as unknown as ContextOptimizer;
}

async function run(
  content: string,
  opts?: {
    commandRuntime?: CommandRuntime;
    permissionConfig?: PermissionConfig;
    contextOptimizer?: ContextOptimizer;
  },
) {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-command-'));
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const eventBus = new EventBus();
  const events: BusEvent[] = [];
  eventBus.subscribeAll((e) => events.push(e));

  const commandRuntime: CommandRuntime = opts?.commandRuntime ?? {
    list: async () => ({ commands: [], diagnostics: [] }),
    resolve: async (input) => (input.startsWith('/help') ? resolveResult : undefined),
  };

  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    contextConfig: stubContextFiles(),
    providerLoader: () => null,
    defaultWorkingDir: tmpDir,
    commandRuntime,
    permissionConfig: opts?.permissionConfig,
    ...(opts?.contextOptimizer ? { contextOptimizer: opts.contextOptimizer } : {}),
  });

  // Сжатие не запускаем — перехватываем служебное сообщение `summarization_request`.
  const summarizationRequests: Message[] = [];
  (
    orchestrator as unknown as {
      _handleSummarization: (session: Session, message: Message) => Promise<unknown>;
    }
  )._handleSummarization = async (_session: Session, message: Message) => {
    summarizationRequests.push(message);
    return {};
  };

  const session = await sessionManager.createSession({
    // Провайдер/модель нужны для ручного сжатия (ADR-119): без них сжимать нечем.
    settings: { provider: 'mock', model: 'mock-model' } as never,
  });
  const msg = makeUserMessage(content);
  await sessionManager.addMessage(session.id, msg);
  const fresh = (await sessionManager.getSession(session.id))!;
  const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
  const result = await orchestrator.createProcessMessage()(
    fresh, msg, new AbortController().signal,
    (event, data) => chunks.push({ event, data }),
  );
  const after = (await sessionManager.getSession(session.id))!;
  return { result, chunks, after, events, msg, summarizationRequests };
}

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe('ChatOrchestrator — slash-команды (ADR-126 §1)', () => {
  it('/help → локальный ответ без LLM, command.invoked, ephemeral-сообщения', async () => {
    const { result, chunks, after, events, msg } = await run('/help');
    expect(result).toEqual({});
    // ADR-118 §4: локальный ответ — ход из одного шага: текст идёт `part.delta`.
    const delta = chunks.find((c) => c.event === 'part.delta');
    expect(delta?.data.delta).toBe('HELP TEXT');
    expect(delta?.data.partId).toBe('msg:text:0');
    expect(chunks.some((c) => c.event === 'part.delta' && c.data.delta === 'HELP TEXT')).toBe(true);
    // `stream.chunk`/`stream.done` удалены — ход закрывают `step.finished`/`turn.finished`.
    expect(chunks.some((c) => c.event === 'stream.chunk' || c.event === 'stream.done')).toBe(false);
    const stepFinished = chunks.find((c) => c.event === 'step.finished');
    expect(stepFinished?.data.status).toBe('completed');
    expect(chunks.find((c) => c.event === 'turn.finished')?.data.status).toBe('completed');
    expect(chunks.some((c) => c.event === 'text' || c.event === 'done')).toBe(false);
    expect(events.some((e) => e.type === 'command.invoked' && e.data.command === 'help')).toBe(true);

    const assistant = after.messages.find((m) => m.role === MessageRole.ASSISTANT);
    // ADR-126 §14: id сохранённого ответа приходит в `step.finished.messageId` —
    // UI не вычисляет index fallback'ом и не сталкивается с user-командой.
    const assistantIndex = after.messages.findIndex((m) => m.role === MessageRole.ASSISTANT);
    expect(stepFinished?.data.messageId).toBe(assistant?.id);
    expect(typeof stepFinished?.data.messageId).toBe('string');
    expect(stepFinished?.data.turnId).toBeTruthy();
    // user-команда обновляется в UI повторным message.added с commandPrompt (upsert).
    const userIdx = after.messages.findIndex((m) => m.id === msg.id);
    expect(assistantIndex).toBeGreaterThan(userIdx);
    expect(
      events.some(
        (e) =>
          e.type === 'message.added' &&
          (e.data.metadata as Record<string, unknown> | undefined)?.commandPrompt === true,
      ),
    ).toBe(true);

    expect(assistant?.content).toBe('HELP TEXT');
    expect(assistant?.ephemeral).toBe(true);
    // ADR-126 §14: нейтральный system-блок в UI — признак команды + имя/аргументы.
    expect(assistant?.model).toBe('command');
    expect(assistant?.provider).toBe('command');
    expect(assistant?.metadata?.command).toBe(true);
    expect(assistant?.metadata?.commandName).toBe('help');
    expect(assistant?.metadata?.commandArgs).toBe('');
    const storedUser = after.messages.find((m) => m.id === msg.id);
    expect(storedUser?.ephemeral).toBe(true);
    // user-команда помечена `commandPrompt` (UI скрывает отдельный пузырь),
    // существующие metadata не затёрты.
    expect(storedUser?.metadata?.commandPrompt).toBe(true);
    expect(typeof storedUser?.metadata?.stream_id).toBe('string');
  });

  it('/summary (недоступна) → нотис в стиле команды', async () => {
    const { after } = await run('/summary', {
      commandRuntime: {
        list: async () => ({ commands: [], diagnostics: [] }),
        resolve: async (input) =>
          input.startsWith('/summary')
            ? { status: 'summarization', name: 'summary', args: '', kind: 'builtin' }
            : undefined,
      },
    });
    const assistant = after.messages.find((m) => m.role === MessageRole.ASSISTANT);
    expect(assistant?.metadata?.command).toBe(true);
    expect(assistant?.metadata?.commandName).toBe('summary');
    expect(assistant?.metadata?.i18n).toEqual({ key: 'command.summary_unavailable' });
    expect(assistant?.model).toBe('command');
    expect(assistant?.provider).toBe('command');
    const storedUser = after.messages.find((m) => m.role === MessageRole.USER);
    expect(storedUser?.metadata?.commandPrompt).toBe(true);
  });

  it('/summary → summarization_request с mode=summarization (ADR-119)', async () => {
    const { summarizationRequests } = await run('/summary', {
      contextOptimizer: makeOptimizer(true),
      commandRuntime: {
        list: async () => ({ commands: [], diagnostics: [] }),
        resolve: async (input) =>
          input.startsWith('/summary')
            ? { status: 'summarization', name: 'summary', args: '', kind: 'builtin', compressionMode: 'summarization' }
            : undefined,
      },
    });
    expect(summarizationRequests).toHaveLength(1);
    expect(summarizationRequests[0]?.metadata?.type).toBe('summarization_request');
    expect(summarizationRequests[0]?.metadata?.reason).toBe('manual');
    expect(summarizationRequests[0]?.metadata?.mode).toBe('summarization');
  });

  it('/compact → summarization_request с mode=compaction (ADR-126 §1, ADR-119)', async () => {
    const { summarizationRequests, events } = await run('/compact', {
      contextOptimizer: makeOptimizer(true),
      commandRuntime: {
        list: async () => ({ commands: [], diagnostics: [] }),
        resolve: async (input) =>
          input.startsWith('/compact')
            ? { status: 'summarization', name: 'compact', args: '', kind: 'builtin', compressionMode: 'compaction' }
            : undefined,
      },
    });
    expect(summarizationRequests).toHaveLength(1);
    expect(summarizationRequests[0]?.metadata?.type).toBe('summarization_request');
    expect(summarizationRequests[0]?.metadata?.reason).toBe('manual');
    // Профиль сжатия — компактизация (не суммаризация).
    expect(summarizationRequests[0]?.metadata?.mode).toBe('compaction');
    expect(events.some((e) => e.type === 'command.invoked' && e.data.command === 'compact')).toBe(true);
  });

  it('/compact (сжимать нечего) → нотис в стиле команды', async () => {
    const { after, summarizationRequests } = await run('/compact', {
      contextOptimizer: makeOptimizer(false),
      commandRuntime: {
        list: async () => ({ commands: [], diagnostics: [] }),
        resolve: async (input) =>
          input.startsWith('/compact')
            ? { status: 'summarization', name: 'compact', args: '', kind: 'builtin', compressionMode: 'compaction' }
            : undefined,
      },
    });
    expect(summarizationRequests).toHaveLength(0);
    const assistant = after.messages.find((m) => m.role === MessageRole.ASSISTANT);
    expect(assistant?.metadata?.commandName).toBe('compact');
    expect(assistant?.metadata?.i18n).toEqual({ key: 'command.compact_unavailable' });
  });

  it('template/skill/bundle → metadata.command = {name,kind,args} (LLM-путь, без commandPrompt)', async () => {
    const { after, msg } = await run('/plan x', {
      commandRuntime: {
        list: async () => ({ commands: [], diagnostics: [] }),
        resolve: async (input) =>
          input.startsWith('/plan')
            ? { status: 'template', name: 'plan', args: 'x', kind: 'template', prompt: 'RENDERED PROMPT' }
            : undefined,
      },
    });
    const storedUser = after.messages.find((m) => m.id === msg.id)!;
    expect(storedUser.content).toBe('RENDERED PROMPT');
    expect(storedUser.metadata?.command).toEqual({ name: 'plan', kind: 'template', args: 'x' });
    expect(storedUser.metadata?.commandPrompt).toBeUndefined();
    expect(
      after.messages.some((m) => m.role === MessageRole.ASSISTANT && m.metadata?.command === true),
    ).toBe(false);
  });

  it('prompt (/init, builtin) → prompt инжектится в user-сообщение, локального ответа нет', async () => {
    const { after, msg, chunks, events } = await run('/init фокус', {
      commandRuntime: {
        list: async () => ({ commands: [], diagnostics: [] }),
        resolve: async (input) =>
          input.startsWith('/init')
            ? { status: 'prompt', name: 'init', args: 'фокус', kind: 'builtin', prompt: 'INIT PROMPT фокус' }
            : undefined,
      },
    });
    const storedUser = after.messages.find((m) => m.id === msg.id)!;
    expect(storedUser.content).toBe('INIT PROMPT фокус');
    expect(storedUser.metadata?.command).toEqual({ name: 'init', kind: 'builtin', args: 'фокус' });
    // Локальной команды нет: ephemeral assistant-ответ не создаётся.
    // P2: терминальная ошибка LLM теперь персистится assistant-сообщением
    // (metadata.status === 'error') — это запись сбоя, а не ответ команды.
    expect(
      after.messages.some((m) => m.role === MessageRole.ASSISTANT && m.metadata?.status !== 'error'),
    ).toBe(false);
    // Локального шага нет (LLM-путь не дошёл до шага — провайдер не настроен).
    expect(chunks.some((c) => c.event === 'step.finished')).toBe(false);
    expect(events.some((e) => e.type === 'command.invoked' && e.data.command === 'init')).toBe(true);
  });

  it('обычный текст не перехватывается командами', async () => {
    const { events } = await run('привет', {
      commandRuntime: { list: async () => ({ commands: [], diagnostics: [] }), resolve: async () => undefined },
    });
    expect(events.some((e) => e.type === 'command.invoked')).toBe(false);
  });

  it('inline shell: allow → исполняет, публикует command.inline_shell', async () => {
    const { after, msg, events } = await run('/run', {
      commandRuntime: {
        list: async () => ({ commands: [], diagnostics: [] }),
        resolve: async (input, opts) => {
          if (!input.startsWith('/run')) return undefined;
          const r = await opts?.runShell?.('echo INLINE_OK');
          return { status: 'template', name: 'run', args: '', kind: 'template', prompt: r?.output ?? '' };
        },
      },
    });
    const stored = after.messages.find((m) => m.id === msg.id)!;
    expect(stored.content).toContain('INLINE_OK');
    expect(
      events.some((e) => e.type === 'command.inline_shell' && e.data.exitCode === 0 && e.data.denied !== true),
    ).toBe(true);
  });

  it('inline shell: deny → отказ без исполнения, аудит denied', async () => {
    const { after, msg, events } = await run('/run', {
      permissionConfig: { rules: { execute_shell: 'deny' }, askTimeoutMs: 30_000 },
      commandRuntime: {
        list: async () => ({ commands: [], diagnostics: [] }),
        resolve: async (input, opts) => {
          if (!input.startsWith('/run')) return undefined;
          const r = await opts?.runShell?.('echo hi');
          return { status: 'template', name: 'run', args: '', kind: 'template', prompt: r?.output ?? '' };
        },
      },
    });
    const stored = after.messages.find((m) => m.id === msg.id)!;
    expect(stored.content).toContain('denied');
    expect(events.some((e) => e.type === 'command.inline_shell' && e.data.denied === true)).toBe(true);
    // deny не порождает запись об исполнении (нет exitCode).
    expect(events.some((e) => e.type === 'command.inline_shell' && 'exitCode' in e.data)).toBe(false);
  });

  it('inline shell: ask → отказ без интерактива (denied)', async () => {
    const { after, msg, events } = await run('/run', {
      permissionConfig: { rules: { execute_shell: 'ask' }, askTimeoutMs: 30_000 },
      commandRuntime: {
        list: async () => ({ commands: [], diagnostics: [] }),
        resolve: async (input, opts) => {
          if (!input.startsWith('/run')) return undefined;
          const r = await opts?.runShell?.('echo hi');
          return { status: 'template', name: 'run', args: '', kind: 'template', prompt: r?.output ?? '' };
        },
      },
    });
    const stored = after.messages.find((m) => m.id === msg.id)!;
    expect(stored.content).toContain('denied');
    expect(events.some((e) => e.type === 'command.inline_shell' && e.data.denied === true)).toBe(true);
  });
});
