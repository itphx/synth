/**
 * ADR-126 §5: пользовательский запуск скрипта проекта по `!name args` в
 * оркестраторе — скрипт стартует **до LLM**, ответ локальный.
 *
 * Проверяем: резолвинг только первого токена сообщения, гейты (режим плана,
 * внешний канал, отсутствие сервиса), права/доверие и то, что ход LLM не
 * стартует (ответ — локальный, `ephemeral`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import type { BusEvent, PermissionConfig, Project, ScriptDetail } from '@itphx/synth-shared';
import type { ContextBuilder } from './context/builder.js';
import { generateId, MessageRole, nowISO, makeTextPart, type Message } from '@itphx/synth-shared';
import type { ScriptService } from './scripts/service.js';
import { stubContextFiles } from '../test-helpers/storage-stubs.js';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [],
  } as unknown as ContextBuilder;
}

function makeUserMessage(content: string, metadata?: Record<string, unknown>): Message {
  return {
    id: generateId(), role: MessageRole.USER, seq: 0, origin: 'local',
    parts: [makeTextPart(content)], content, createdAt: nowISO(),
    disabled: false, pinned: false, hidden: false, author: 'user',
    metadata: { stream_id: generateId(), ...(metadata ?? {}) },
  };
}

/** Декларация скрипта (ADR-126 §5) для заглушки `ScriptService.get`. */
function makeDetail(overrides?: Partial<ScriptDetail>): ScriptDetail {
  return {
    name: 'dev',
    description: 'dev desc',
    origin: 'project',
    available: true,
    trusted: true,
    background: true,
    run: './scripts/dev.sh',
    shell: false,
    args: true,
    file: '.synth/scripts/dev.md',
    body: 'body',
    ...overrides,
  };
}

interface ScriptStub {
  get: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

/** Заглушка `ScriptService`: только `get`/`run` (остальное не используется). */
function makeScriptService(opts?: {
  detail?: ScriptDetail | null;
  runResult?: { run_id: string; process_id: string; log_path: string; status: 'running' };
}): ScriptStub {
  return {
    get: vi.fn(async () => (opts?.detail === undefined ? makeDetail() : opts.detail)),
    run: vi.fn(async () => opts?.runResult ?? {
      run_id: 'bgr_test',
      process_id: 'proc_test',
      log_path: 'processes/bgr_test.log',
      status: 'running' as const,
    }),
  };
}

let tmpDir: string;
/** Корень проекта (workspace) — периметр сессии вне worktree (ADR-114). */
let projectDir: string;
/** Каталог worktree сессии — рабочий каталог хода. */
let worktreeDir: string;

async function run(
  content: string,
  opts?: {
    scriptService?: ScriptStub | null;
    permissionConfig?: PermissionConfig;
    messageMetadata?: Record<string, unknown>;
    sessionMode?: 'plan' | 'act' | 'yolo';
  },
) {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-script-'));
  projectDir = join(tmpDir, 'project');
  worktreeDir = join(tmpDir, 'worktree');
  await mkdir(projectDir, { recursive: true });
  await mkdir(worktreeDir, { recursive: true });

  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const eventBus = new EventBus();
  const events: BusEvent[] = [];
  eventBus.subscribeAll((e) => events.push(e));

  const scriptService = opts?.scriptService === undefined
    ? makeScriptService()
    : opts.scriptService;

  // Проект сессии: workspace задаёт корень периметра (ADR-075/ADR-114).
  const project = {
    id: 'proj_test',
    name: 'Проект',
    workspace: projectDir,
  } as unknown as Project;

  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    contextConfig: stubContextFiles(),
    providerLoader: () => null,
    defaultWorkingDir: tmpDir,
    workspacesRoot: tmpDir,
    projectStore: { load: async () => project },
    commandRuntime: {
      list: async () => ({ commands: [], diagnostics: [] }),
      resolve: async () => undefined,
    },
    ...(scriptService
      ? { scriptService: scriptService as unknown as ScriptService }
      : {}),
    ...(opts?.permissionConfig ? { permissionConfig: opts.permissionConfig } : {}),
  });

  const session = await sessionManager.createSession({
    settings: { provider: 'mock', model: 'mock-model' } as never,
  });
  // Сессия привязана к worktree (ADR-114): рабочий каталог — каталог
  // worktree, корень проекта добавляется в периметр (`allowedRoots`).
  session.projectId = project.id;
  session.worktree = {
    worktreeId: 'wt_test',
    projectId: project.id,
    directory: worktreeDir,
    branch: 'feature/test',
  };
  if (opts?.sessionMode) {
    // Режим сессии (`session.mode`) — свойство принципала хода (ADR-106 Ф4).
    session.mode = opts.sessionMode;
  }
  await sessionManager.updateSession(session);
  const msg = makeUserMessage(content, opts?.messageMetadata);
  await sessionManager.addMessage(session.id, msg);
  const fresh = (await sessionManager.getSession(session.id))!;
  const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
  await orchestrator.createProcessMessage()(
    fresh, msg, new AbortController().signal,
    (event, data) => chunks.push({ event, data }),
  );
  const after = (await sessionManager.getSession(session.id))!;
  return { after, events, msg, chunks, scriptService };
}

/** Локальный ответ оркестратора (assistant-сообщение с признаком команды). */
function localReply(messages: Message[]): Message | undefined {
  return messages.find((m) => m.role === MessageRole.ASSISTANT && m.metadata?.command === true);
}

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe('ChatOrchestrator — `!`-скрипты (ADR-126 §5)', () => {
  it('`!dev` → скрипт запущен до LLM, локальный ответ с логом', async () => {
    const { after, scriptService, msg } = await run('!dev');

    expect(scriptService!.run).toHaveBeenCalledTimes(1);
    const input = scriptService!.run.mock.calls[0]![0] as {
      name: string; args: string; origin: string; sessionId: string;
      workingDir: string; allowedRoots?: string[]; projectWorkspace?: string;
    };
    expect(input.name).toBe('dev');
    expect(input.args).toBe('');
    expect(input.origin).toBe('user');
    expect(input.sessionId).toBeTruthy();
    // Рабочий каталог — каталог worktree сессии; периметр — корень проекта.
    expect(input.workingDir).toBe(worktreeDir);
    expect(input.projectWorkspace).toBe(worktreeDir);
    expect(input.allowedRoots).toEqual([projectDir]);

    // Локальный ответ в ленте: имя скрипта и путь лога.
    const reply = localReply(after.messages);
    expect(reply).toBeDefined();
    expect(reply!.content).toContain('dev');
    expect(reply!.content).toContain('processes/bgr_test.log');
    expect(reply!.metadata?.script).toBe('dev');
    expect(reply!.metadata?.commandName).toBe('!dev');
    expect(reply!.ephemeral).toBe(true);
    expect(reply!.model).toBe('command');

    // Ход LLM не стартовал: реплика пользователя — эфемерная команда.
    const stored = after.messages.find((m) => m.id === msg.id)!;
    expect(stored.content).toBe('!dev');
    expect(stored.ephemeral).toBe(true);
    expect(stored.metadata?.commandPrompt).toBe(true);
  });

  it('аргументы уходят строкой (`!dev --fast`)', async () => {
    const { scriptService } = await run('!dev --fast');
    expect(scriptService!.run).toHaveBeenCalledTimes(1);
    const input = scriptService!.run.mock.calls[0]![0] as { args: string };
    expect(input.args).toBe('--fast');
  });

  it('неизвестный скрипт → локальный ответ «не объявлен», run не вызван', async () => {
    const scriptService = makeScriptService({ detail: null });
    const { after } = await run('!unknown', { scriptService });

    expect(scriptService.run).not.toHaveBeenCalled();
    const reply = localReply(after.messages);
    expect(reply).toBeDefined();
    expect(reply!.content).toContain('unknown');
  });

  it('недоверенный каталог → «недоступен», run не вызван', async () => {
    const scriptService = makeScriptService({
      detail: makeDetail({ trusted: false, available: false, unavailableReason: 'trusted' }),
    });
    const { after } = await run('!dev', { scriptService });

    expect(scriptService.run).not.toHaveBeenCalled();
    const reply = localReply(after.messages);
    expect(reply).toBeDefined();
    expect(reply!.content).toContain('dev');
  });

  it('правило `permission.rules.script = deny` → «запрещён», run не вызван', async () => {
    const scriptService = makeScriptService();
    const { after } = await run('!dev', {
      scriptService,
      permissionConfig: { rules: { script: 'deny' }, askTimeoutMs: 30_000 },
    });

    expect(scriptService.run).not.toHaveBeenCalled();
    const reply = localReply(after.messages);
    expect(reply).toBeDefined();
    expect(reply!.content).toContain('dev');
  });

  it('режим плана → «запрещено в плане», run не вызван', async () => {
    const scriptService = makeScriptService();
    const { after } = await run('!dev', { scriptService, sessionMode: 'plan' });

    expect(scriptService.run).not.toHaveBeenCalled();
    const reply = localReply(after.messages);
    expect(reply).toBeDefined();
    expect(reply!.content.length).toBeGreaterThan(0);
  });

  it('сообщение из внешнего канала → отказ, run не вызван', async () => {
    const scriptService = makeScriptService();
    const { after } = await run('!dev', {
      scriptService,
      messageMetadata: { principal_id: 'tg:123' },
    });

    expect(scriptService.run).not.toHaveBeenCalled();
    const reply = localReply(after.messages);
    expect(reply).toBeDefined();
  });

  it('`!` в середине текста — обычный путь (скрипт не запускается)', async () => {
    const scriptService = makeScriptService();
    const { after, msg } = await run('сделай !dev', { scriptService });

    expect(scriptService.run).not.toHaveBeenCalled();
    expect(localReply(after.messages)).toBeUndefined();
    const stored = after.messages.find((m) => m.id === msg.id)!;
    expect(stored.content).toBe('сделай !dev');
  });

  it('нет `scriptService` → «недоступно в этой сборке»', async () => {
    const { after } = await run('!dev', { scriptService: null });
    const reply = localReply(after.messages);
    expect(reply).toBeDefined();
    expect(reply!.content.length).toBeGreaterThan(0);
  });
});
