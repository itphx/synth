/**
 * Тесты фасада `task.ts` (ADR-095, шаг 5) и определения тула `task/tool.ts`:
 * публичный API фасада и делегирование в вынесенные модули.
 *
 * Изолированно: фейковый провайдер, tmp-каталог для промптов; без сети и LLM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCapability } from '@itphx/synth-shared';
import type { Message, Session, ToolContext } from '@itphx/synth-shared';
import type { BaseProvider } from '../../../providers/base.js';
import type { AgentRegistry } from '../../agents/registry.js';
import { FileStore } from '../../../storage/file-store.js';
import { SessionManager } from '../../../sessions/manager.js';
import { MemoryBackgroundRunRepository } from '../../../storage/memory/background-runs.js';
import { EventBus } from '../../../events/bus.js';
import { BackgroundRunService } from '../../background/service.js';
import type { BackgroundRunLimits } from '../../background/types.js';
import { deriveSubagentPermission } from '../../permission/derive.js';
import { PermissionEvaluator } from '../../permission/evaluator.js';
import * as facade from '../task.js';
import { taskTool } from './tool.js';
import { runSubagent, SUBAGENT_MAX_ATTEMPTS, SUBAGENT_RETRY_DELAYS_MS } from './run-cycle.js';
import {
  buildSubagentUnavailableToolsSection,
  messageToLLMMessage,
  resolveSubagentPrompt,
} from './prompt.js';
import { publishMessageAdded } from './child-session.js';
import { LLM_MAX_ATTEMPTS, LLM_RETRY_DELAYS_MS } from '../../llm-error.js';
import type { TaskExtra } from './types.js';

function makeAgentRegistry(subagents: string[] = ['explore']): AgentRegistry {
  return {
    get: (id: string) => (subagents.includes(id)
      ? { id, agentMode: ['subagent'], subagentPrompt: 'You are a test subagent.', maxSteps: 1 }
      : undefined),
    getSubagents: () => subagents.map((id) => ({ id })),
    getToolsForAgent: () => [],
  } as unknown as AgentRegistry;
}

function makeProvider(content = 'mock response') {
  const chatAsync = vi.fn(() => (async function* () {
    yield { isFinal: true, content, toolCalls: [] };
  })());
  return {
    provider: { model: 'test-model', name: 'test-provider', chatAsync } as unknown as BaseProvider,
    chatAsync,
  };
}

function makeCtx(extra: Partial<TaskExtra>, sessionId = 'parent-1'): ToolContext {
  return {
    sessionId,
    messageId: 'm1',
    abortSignal: new AbortController().signal,
    workingDir: '/tmp',
    extra: extra as unknown as Record<string, unknown>,
  };
}

describe('task.ts — фасад сохраняет публичный контракт (ADR-095, шаг 5)', () => {
  it('реэкспортирует те же функции/константы, что и модули (импортёры task-resume/index не ломаются)', () => {
    expect(facade.taskTool).toBe(taskTool);
    expect(facade.runSubagent).toBe(runSubagent);
    expect(facade.buildSubagentUnavailableToolsSection).toBe(buildSubagentUnavailableToolsSection);
    expect(facade.messageToLLMMessage).toBe(messageToLLMMessage);
    expect(facade.resolveSubagentPrompt).toBe(resolveSubagentPrompt);
    expect(facade.publishMessageAdded).toBe(publishMessageAdded);
  });

  it('SUBAGENT_MAX_ATTEMPTS / SUBAGENT_RETRY_DELAYS_MS остаются единой LLM-политикой', () => {
    expect(facade.SUBAGENT_MAX_ATTEMPTS).toBe(LLM_MAX_ATTEMPTS);
    expect(facade.SUBAGENT_RETRY_DELAYS_MS).toEqual(LLM_RETRY_DELAYS_MS);
    expect(SUBAGENT_MAX_ATTEMPTS).toBe(3);
    expect(SUBAGENT_RETRY_DELAYS_MS).toEqual([5000, 15000, 30000]);
  });
});

describe('task/tool.ts — определение и ранние отказы', () => {
  it('определение тула: имя, capability TASK, параметры-схема', () => {
    expect(taskTool.name).toBe('task');
    expect(taskTool.capabilities).toContain(ToolCapability.TASK);
    expect(taskTool.parameters.safeParse({ description: 'd', prompt: 'p', subagent_type: 'explore' }).success).toBe(true);
  });

  it('невалидные аргументы → isError с tool.args_error', async () => {
    const result = await taskTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'explore', context_mode: 'bad' },
      makeCtx({}),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('task');
    expect(result.metadata!.i18n).toBeDefined();
  });

  it('нет provider/agentRegistry → task.deps_unavailable', async () => {
    const result = await taskTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      makeCtx({}),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('provider or agent registry unavailable');
  });

  it('неизвестный subagent_type → task.subagent_not_found со списком доступных', async () => {
    const { provider } = makeProvider();
    const result = await taskTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'nope' },
      makeCtx({ provider, agentRegistry: makeAgentRegistry(['explore']) }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"nope"');
    expect(result.content).toContain('explore');
  });

  it('агент без класса subagent → task.subagent_not_allowed', async () => {
    const { provider } = makeProvider();
    const registry = {
      get: () => ({ id: 'main', agentMode: ['primary'], subagentPrompt: '' }),
      getSubagents: () => [],
      getToolsForAgent: () => [],
    } as unknown as AgentRegistry;
    const result = await taskTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'main' },
      makeCtx({ provider, agentRegistry: registry }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('cannot be used as a subagent');
  });
});

describe('task/tool.ts — делегирование в prompt.ts', () => {
  let promptsDir: string;

  beforeEach(async () => {
    promptsDir = await mkdtemp(join(tmpdir(), 'synth-task-tool-'));
    await mkdir(join(promptsDir, 'subagents'), { recursive: true });
    await writeFile(join(promptsDir, 'subagents', 'explore.ru.md'), 'SUBAGENT ROLE PROMPT');
  });

  afterEach(async () => {
    await rm(promptsDir, { recursive: true, force: true });
  });

  it('системный промпт резолвится через prompt.resolveSubagentPrompt и идёт 2-м аргументом chatAsync', async () => {
    const { provider, chatAsync } = makeProvider('ok');
    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', context_mode: 'none' },
      makeCtx({
        provider,
        agentRegistry: makeAgentRegistry(),
        contextConfig: { systemPromptsDir: promptsDir } as never,
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(chatAsync).toHaveBeenCalledTimes(1);
    const [messages, systemPrompt] = chatAsync.mock.calls[0] as unknown as [Array<{ role: string }>, string];
    expect(systemPrompt).toContain('SUBAGENT ROLE PROMPT');
    // ADR-070 §1.5: system-сообщения в messages нет — только user-промпт.
    expect(messages.map((m) => m.role)).toEqual(['user']);
  });

  it('skip_context_files=true: проектные инструкции не добавляются в промпт', async () => {
    const { provider, chatAsync } = makeProvider('ok');
    await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', skip_context_files: true },
      makeCtx({
        provider,
        agentRegistry: makeAgentRegistry(),
        projectInstructions: '[PROJECT INSTRUCTIONS]\nSECRET RULES',
      }),
    );

    const [, systemPrompt] = chatAsync.mock.calls[0] as unknown as [unknown, string];
    expect(systemPrompt).not.toContain('SECRET RULES');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Фоновые саб-агенты (PROP-096) — тул `task` с `background: true` и
// продолжение ребёнка через `task_id`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Провайдер с «воротами»: LLM-вызов висит, пока тест не отпустит его.
 * Нужен, чтобы доказать, что фоновый запуск **не блокирует** родительский ход:
 * тул возвращается, пока прогон ещё идёт.
 */
function gatedProvider() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const chatAsync = vi.fn(() => (async function* () {
    await gate;
    yield { isFinal: true, content: 'background done', toolCalls: [] };
  })());
  const provider = { model: 'test-model', name: 'test-provider', chatAsync } as unknown as BaseProvider;
  return { provider, chatAsync, release: () => release() };
}

describe('task/tool.ts — фоновый саб-агент (PROP-096)', () => {
  let bgDir: string;
  let sessionManager: SessionManager;
  let parent: Session;

  beforeEach(async () => {
    bgDir = await mkdtemp(join(tmpdir(), 'synth-task-background-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: bgDir }));
    parent = await sessionManager.createSession({ title: 'P' });
  });

  afterEach(async () => {
    // maxRetries: фоновый прогон может дописывать файлы сессии уже после
    // теста — удаляем каталог с повторами (ENOTEMPTY).
    await rm(bgDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** Реальный сервис реестра фоновых прогонов на memory-порте. */
  function makeBackgroundService(limits?: Partial<BackgroundRunLimits>) {
    const repository = new MemoryBackgroundRunRepository();
    const eventBus = new EventBus();
    const notifications: Message[] = [];
    let counter = 0;
    const service = new BackgroundRunService({
      repository,
      eventBus,
      limits: { maxSubagentsPerSession: 0, maxRunsPerSession: 0, ...(limits ?? {}) },
      generateId: () => `id-${++counter}`,
      onNotifyParent: (_sessionId: string, message: Message) => {
        notifications.push(message);
      },
    });
    return { repository, eventBus, service, notifications };
  }

  it('background=true: тул возвращается сразу, прогон идёт в фоне (status=running)', async () => {
    const { provider, chatAsync, release } = gatedProvider();
    const { service, notifications } = makeBackgroundService();
    const registerCancelToken = vi.fn();
    const unregisterCancelToken = vi.fn();

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', background: true },
      makeCtx({
        provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        backgroundService: service,
        backgroundEnabled: true,
        registerCancelToken,
        unregisterCancelToken,
      }, parent.id),
    );

    // Родительский ход не заблокирован: ответ есть, а LLM-вызов ещё висит.
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('running in the background');
    expect(result.metadata!.status).toBe('running');
    expect(result.metadata!.background_run_id).toMatch(/^bgr_/);
    expect(result.metadata!.child_session_id).toBeTruthy();

    // Фоновый прогон стартовал, но ещё не завершён (провайдер на «воротах»).
    await vi.waitFor(() => expect(chatAsync).toHaveBeenCalledTimes(1));

    // В реестре — запись `running`.
    const runs = await service.list({ sessionId: parent.id, status: 'running' });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.childSessionId).toBe(result.metadata!.child_session_id);

    // Cancel-токен фонового прогона зарегистрирован в оркестраторе.
    expect(registerCancelToken).toHaveBeenCalledTimes(1);

    // Отпускаем прогон — он завершается, родитель получает уведомление.
    release();
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    const record = await service.get(result.metadata!.background_run_id as string);
    expect(record?.status).toBe('completed');
    expect(record?.summary).toContain('background done');
    expect(notifications[0]!.metadata?.type).toBe('background_run_result');
    expect(unregisterCancelToken).toHaveBeenCalledTimes(1);
  });

  it('background=false (по умолчанию) — прежний синхронный путь, реестр пуст', async () => {
    const { provider, chatAsync } = makeProvider('sync answer');
    const { service } = makeBackgroundService();

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', background: false },
      makeCtx({
        provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        backgroundService: service,
        backgroundEnabled: true,
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<task_result>');
    expect(result.content).toContain('sync answer');
    expect(chatAsync).toHaveBeenCalledTimes(1);
    // Фоновых прогонов не заводилось.
    expect(result.metadata!.status).toBeUndefined();
    expect(result.metadata!.background_run_id).toBeUndefined();
    expect(await service.list()).toHaveLength(0);
  });

  it('backgroundEnabled=false — отказ task.background_disabled, реестр пуст', async () => {
    const { provider } = makeProvider();
    const { service } = makeBackgroundService();

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', background: true },
      makeCtx({
        provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        backgroundService: service,
        backgroundEnabled: false,
      }, parent.id),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Background subagents are disabled');
    expect(result.metadata!.i18n).toMatchObject({ key: 'task.background_disabled' });
    expect(await service.list()).toHaveLength(0);
  });

  it('превышен лимит фоновых саб-агентов сессии — отказ task.background_limit', async () => {
    const { provider, release } = gatedProvider();
    const { service, notifications } = makeBackgroundService({ maxSubagentsPerSession: 1 });
    const extra = {
      provider,
      agentRegistry: makeAgentRegistry(),
      sessionManager,
      sessionId: parent.id,
      backgroundService: service,
      backgroundEnabled: true,
    };

    const first = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', background: true },
      makeCtx(extra, parent.id),
    );
    expect(first.isError).toBeFalsy();

    const second = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', background: true },
      makeCtx(extra, parent.id),
    );
    expect(second.isError).toBe(true);
    expect(second.content).toContain('limit for this session');
    expect(second.metadata!.background_run_limit).toBe('subagents');
    expect(second.metadata!.i18n).toMatchObject({ key: 'task.background_limit' });

    // В реестре — только первый (успешный) прогон.
    expect(await service.list({ sessionId: parent.id })).toHaveLength(1);

    // Дожидаемся завершения фонового прогона (иначе он пишет в каталог после теста).
    release();
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
  });
});

describe('task/tool.ts — продолжение ребёнка через task_id', () => {
  let bgDir: string;
  let sessionManager: SessionManager;
  let parent: Session;

  beforeEach(async () => {
    bgDir = await mkdtemp(join(tmpdir(), 'synth-task-resume-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: bgDir }));
    parent = await sessionManager.createSession({ title: 'P' });
  });

  afterEach(async () => {
    await rm(bgDir, { recursive: true, force: true });
  });

  it('чужой ребёнок → task.resume_foreign_child', async () => {
    const { provider, chatAsync } = makeProvider();
    const foreign = await sessionManager.createSession({
      title: 'C',
      parentId: 'another-parent',
      sessionOrigin: 'subagent',
      settings: { agentRole: 'explore' },
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', task_id: foreign.id },
      makeCtx({ provider, agentRegistry: makeAgentRegistry(), sessionManager, sessionId: parent.id }, parent.id),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('is not a subagent session of the current session');
    expect(result.metadata!.i18n).toMatchObject({ key: 'task.resume_foreign_child' });
    expect(chatAsync).not.toHaveBeenCalled();
  });

  it('занятый ребёнок (currentStream) → task.resume_child_busy', async () => {
    const { provider, chatAsync } = makeProvider();
    const child = await sessionManager.createSession({
      title: 'C',
      parentId: parent.id,
      sessionOrigin: 'subagent',
      settings: { agentRole: 'explore' },
    });
    child.currentStream = {
      streamId: 'st-1',
      message: 'идёт',
      agentRole: 'explore',
      startedAt: new Date().toISOString(),
      cancelled: false,
    };
    await sessionManager.saveSession(child);

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', task_id: child.id },
      makeCtx({ provider, agentRegistry: makeAgentRegistry(), sessionManager, sessionId: parent.id }, parent.id),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('is busy or already running');
    expect(result.metadata!.i18n).toMatchObject({ key: 'task.resume_child_busy' });
    expect(chatAsync).not.toHaveBeenCalled();
  });

  it('свой свободный ребёнок — цикл саб-агента запускается (runSubagent)', async () => {
    const { provider, chatAsync } = makeProvider('resumed answer');
    const child = await sessionManager.createSession({
      title: 'C',
      parentId: parent.id,
      sessionOrigin: 'subagent',
      settings: { agentRole: 'explore' },
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', task_id: child.id },
      makeCtx({ provider, agentRegistry: makeAgentRegistry(), sessionManager, sessionId: parent.id }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<task_result>');
    expect(result.content).toContain('resumed answer');
    expect(chatAsync).toHaveBeenCalledTimes(1);

    // В историю ребёнка добавлен маркер продолжения и ответ саб-агента.
    const saved = (await sessionManager.getSession(child.id))!;
    expect(saved.messages.some((m) => m.metadata?.resume === true)).toBe(true);
    expect(saved.messages.some((m) => m.content.includes('resumed answer'))).toBe(true);
  });

  it('несуществующий task_id → task.resume_session_not_found', async () => {
    const { provider } = makeProvider();
    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', task_id: 'no-such-session' },
      makeCtx({ provider, agentRegistry: makeAgentRegistry(), sessionManager, sessionId: parent.id }, parent.id),
    );

    expect(result.isError).toBe(true);
    expect(result.metadata!.i18n).toMatchObject({ key: 'task.resume_session_not_found' });
  });
});

describe('task/tool.ts — саб-агент не может запускать фоновых детей', () => {
  it('deriveSubagentPermission даёт rules.task=deny — вызов task (в т.ч. background) запрещён', () => {
    const derived = deriveSubagentPermission({ rules: { '*': 'allow' }, askTimeoutMs: 30_000 });
    expect(derived.rules.task).toBe('deny');

    const decision = new PermissionEvaluator(derived).check({
      toolName: 'task',
      params: { description: 'd', prompt: 'p', subagent_type: 'explore', background: true },
      workingDir: '/tmp',
      capabilities: [ToolCapability.TASK],
    });
    expect(decision.action).toBe('deny');
  });
});
