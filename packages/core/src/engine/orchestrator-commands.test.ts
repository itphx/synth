/**
 * AD-046 §7/§8.2: ранний резолвинг `/`-команд в оркестраторе — локальный ответ
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
import type { BusEvent, CommandRuntime, CommandResolveResult } from '@itphx/synth-shared';
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

async function run(content: string, opts?: { commandRuntime?: CommandRuntime }) {
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

describe('ChatOrchestrator — slash-команды (AD-046 §7)', () => {
  it('/help → локальный ответ без LLM, command.invoked, ephemeral-сообщения', async () => {
    const { result, chunks, after, events, msg } = await run('/help');
    expect(result).toEqual({});
    expect(chunks.some((c) => c.event === 'stream.chunk' && c.data.content === 'HELP TEXT')).toBe(true);
    const done = chunks.find((c) => c.event === 'stream.done');
    expect(done?.data.content).toBe('HELP TEXT');
    expect(typeof done?.data.stream_id).toBe('string');
    expect(chunks.some((c) => c.event === 'text' || c.event === 'done')).toBe(false);
    expect(events.some((e) => e.type === 'command.invoked' && e.data.command === 'help')).toBe(true);

    const assistant = after.messages.find((m) => m.role === MessageRole.ASSISTANT);
    expect(assistant?.content).toBe('HELP TEXT');
    expect(assistant?.ephemeral).toBe(true);
    const storedUser = after.messages.find((m) => m.id === msg.id);
    expect(storedUser?.ephemeral).toBe(true);
  });

  it('обычный текст не перехватывается командами', async () => {
    const { events } = await run('привет', {
      commandRuntime: { list: async () => ({ commands: [], diagnostics: [] }), resolve: async () => undefined },
    });
    expect(events.some((e) => e.type === 'command.invoked')).toBe(false);
  });
});
