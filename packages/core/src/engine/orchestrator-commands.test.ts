/**
 * ADR-046 §7/§8.2: ранний резолвинг `/`-команд в оркестраторе — локальный ответ
 * без LLM, событие `command.invoked`, эфемерные сообщения.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import type { BusEvent, CommandRuntime, CommandResolveResult, PermissionConfig } from '@itphx/synth-shared';
import type { ContextBuilder } from './context/builder.js';
import type { ContextConfig } from './context/config.js';
import { generateId, MessageRole, nowISO, makeTextPart, type Message } from '@itphx/synth-shared';

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

async function run(content: string, opts?: { commandRuntime?: CommandRuntime; permissionConfig?: PermissionConfig }) {
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
    contextConfig: {} as ContextConfig,
    providerLoader: () => null,
    defaultWorkingDir: tmpDir,
    commandRuntime,
    permissionConfig: opts?.permissionConfig,
  });

  const session = await sessionManager.createSession({ engine: 'synth' });
  const msg = makeUserMessage(content);
  await sessionManager.addMessage(session.id, msg);
  const fresh = (await sessionManager.getSession(session.id))!;
  const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
  const result = await orchestrator.createProcessMessage()(
    fresh, msg, new AbortController().signal,
    (event, data) => chunks.push({ event, data }),
  );
  const after = (await sessionManager.getSession(session.id))!;
  return { result, chunks, after, events, msg };
}

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe('ChatOrchestrator — slash-команды (ADR-046 §7)', () => {
  it('/help → локальный ответ без LLM, command.invoked, ephemeral-сообщения', async () => {
    const { result, chunks, after, events, msg } = await run('/help');
    expect(result).toEqual({});
    expect(chunks.some((c) => c.event === 'stream.chunk' && c.data.content === 'HELP TEXT')).toBe(true);
    const done = chunks.find((c) => c.event === 'stream.done');
    expect(done?.data.content).toBe('HELP TEXT');
    expect(typeof done?.data.stream_id).toBe('string');
    // UI создаёт оптимистичное сообщение из stream.done — команда должна быть
    // помечена и здесь, иначе она отрисуется как ответ агента.
    expect(done?.data.metadata).toMatchObject({ command: true, commandName: 'help', commandArgs: '' });
    expect(chunks.some((c) => c.event === 'text' || c.event === 'done')).toBe(false);
    expect(events.some((e) => e.type === 'command.invoked' && e.data.command === 'help')).toBe(true);

    const assistant = after.messages.find((m) => m.role === MessageRole.ASSISTANT);
    // ADR-046 §7.1: stream.done несёт index/id сохранённого ответа — UI не
    // вычисляет index fallback'ом и не сталкивается с user-командой.
    const assistantIndex = after.messages.findIndex((m) => m.role === MessageRole.ASSISTANT);
    expect(done?.data.message_index).toBe(assistantIndex);
    expect(typeof done?.data.message_index).toBe('number');
    expect(done?.data.message_id).toBe(assistant?.id);
    expect(typeof done?.data.message_id).toBe('string');
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
    // ADR-046 §7.1: нейтральный system-блок в UI — признак команды + имя/аргументы.
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
    expect(chunks.some((c) => c.event === 'stream.done')).toBe(false);
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
