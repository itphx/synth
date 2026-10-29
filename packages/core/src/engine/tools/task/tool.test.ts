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
import { MessageRole, ToolCapability, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message, Session, SessionSettings, ToolContext, RouterConfig } from '@itphx/synth-shared';
import type { BaseProvider } from '../../../providers/base.js';
import type { AgentRegistry } from '../../agents/registry.js';
import type { ModelRouter } from '../../router/router.js';
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
import { stubContextFiles } from '../../../test-helpers/storage-stubs.js';
import { LLM_MAX_ATTEMPTS, LLM_RETRY_DELAYS_MS } from '../../llm-error.js';
import type { TaskExtra } from './types.js';

function makeAgentRegistry(
  subagents: string[] = ['explore'],
  agentTemperature?: number,
  agentOverrides: Record<string, unknown> = {},
): AgentRegistry {
  return {
    get: (id: string) => (subagents.includes(id)
      ? {
          id,
          agentMode: ['subagent'],
          maxSteps: 1,
          ...(agentTemperature !== undefined ? { temperature: agentTemperature } : {}),
          ...agentOverrides,
        }
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
      get: () => ({ id: 'main', agentMode: ['primary'] }),
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
        contextConfig: stubContextFiles({ systemPromptsDir: promptsDir }),
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

    const [, systemPrompt] = chatAsync.mock.calls[0] as unknown as [unknown, string | undefined];
    expect(systemPrompt ?? '').not.toContain('SECRET RULES');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Поведение как в opencode: стандартный префикс prompt нового саб-агента,
// отсутствие префикса у продолжений, режимы контекста (ADR-026).
// ─────────────────────────────────────────────────────────────────────────────

// ADR-026: служебный блок саб-агента — теперь **системный** (SUBAGENT.{ru,en}.md),
// а не префикс user-сообщения. В тестах — заглушка порта файлов контекста.
const SUBAGENT_NOTICE_RU = '[SUBAGENT]\n\nТы — сабагент, запущенный другой сессией.';
const SUBAGENT_NOTICE_EN = '[SUBAGENT]\n\nYou are a subagent spawned by another session.';
const LEGACY_PREFIX = 'You are a subagent spawned by another session.';

function makeSubagentContextConfig() {
  return stubContextFiles({
    getSubagentNotice: (language?: string) => (language === 'en' ? SUBAGENT_NOTICE_EN : SUBAGENT_NOTICE_RU),
  });
}

describe('task/tool.ts — системный блок саб-агента и режимы контекста (ADR-026)', () => {
  let dir: string;
  let sessionManager: SessionManager;
  let parent: Session;

  function textMsg(content: string, role: MessageRole = MessageRole.USER): Message {
    return {
      id: generateId(),
      role,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(content)],
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-task-prefix-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: dir }));
    parent = await sessionManager.createSession({ title: 'P' });
    // 5 сообщений: `last_n` с границей 2 копирует историю до контрольной точки.
    for (let i = 0; i < 5; i++) {
      await sessionManager.addMessage(
        parent.id,
        textMsg(`msg ${i}`, i % 2 === 0 ? MessageRole.USER : MessageRole.ASSISTANT),
      );
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('новый дочерний прогон: [SUBAGENT] в system prompt, user-сообщение — без префикса', async () => {
    const { provider, chatAsync } = makeProvider('ok');
    const result = await taskTool.execute(
      { description: 'd', prompt: 'do the work', subagent_type: 'explore', context_mode: 'none' },
      makeCtx({
        provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        contextConfig: makeSubagentContextConfig(),
        // Язык родителя → английский вариант системного блока.
        parentSessionSettings: { language: 'en' } as SessionSettings,
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    const [messages, systemPrompt] = chatAsync.mock.calls[0] as unknown as [
      Array<{ role: string; content: string }>,
      string,
    ];
    expect(messages).toHaveLength(1);
    // user-сообщение — исходный prompt, служебного блока в нём нет
    expect(messages[0]!.content).toBe('do the work');
    expect(messages[0]!.content).not.toContain(LEGACY_PREFIX);
    // системный блок — в system prompt (второй аргумент chatAsync)
    expect(systemPrompt).toContain('[SUBAGENT]');
    expect(systemPrompt).toContain('subagent spawned');

    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    const userMessages = child.messages.filter((m) => m.role === MessageRole.USER);
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.content).toBe('do the work');
    // В сохранённой истории служебного блока нет вообще
    expect(child.messages.every((m) => !m.content.includes('[SUBAGENT]'))).toBe(true);
  });

  it('продолжение task_id: системный блок [SUBAGENT] не добавляется', async () => {
    const { provider, chatAsync } = makeProvider('resumed');
    const child = await sessionManager.createSession({
      title: 'C',
      parentId: parent.id,
      sessionOrigin: 'subagent',
      settings: { agentRole: 'explore' },
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'continue', subagent_type: 'explore', task_id: child.id },
      makeCtx({
        provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        contextConfig: makeSubagentContextConfig(),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    const [messages, systemPrompt] = chatAsync.mock.calls[0] as unknown as [
      Array<{ content: string }>,
      string,
    ];
    expect(systemPrompt ?? '').not.toContain('[SUBAGENT]');
    expect(messages.every((m) => !m.content.startsWith(LEGACY_PREFIX))).toBe(true);

    const saved = (await sessionManager.getSession(child.id))!;
    expect(saved.messages.every((m) => !m.content.startsWith(LEGACY_PREFIX))).toBe(true);
  });

  it('summary: сжатие уходит в [PARENT SUMMARY], в истории ребёнка нет SUMMARY', async () => {
    const { provider, chatAsync } = makeProvider('ok');
    const summarize = vi.fn(async () => textMsg('compressed history', MessageRole.SUMMARY));

    const result = await taskTool.execute(
      { description: 'd', prompt: 'do the work', subagent_type: 'explore', context_mode: 'summary' },
      makeCtx({
        provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        contextConfig: makeSubagentContextConfig(),
        contextOptimizer: { summarize } as never,
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(summarize).toHaveBeenCalledTimes(1);

    const [, systemPrompt] = chatAsync.mock.calls[0] as unknown as [Array<{ content: string }>, string];
    expect(systemPrompt).toContain('[PARENT SUMMARY]');
    expect(systemPrompt).toContain('compressed history');
    expect(systemPrompt).toContain('[SUBAGENT]');

    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.messages.filter((m) => m.role === MessageRole.SUMMARY)).toHaveLength(0);
    // Унаследованные сообщения отключены, user-промпт нового прогона — без служебного блока.
    const own = child.messages.filter((m) => !m.disabled && m.role === MessageRole.USER);
    expect(own).toHaveLength(1);
    expect(own[0]!.content).toBe('do the work');
  });

  it.each(['inherit', 'last_n'] as const)(
    '%s: история родителя копируется (без отключённых), [SUBAGENT] — в system prompt',
    async (mode) => {
      const { provider, chatAsync } = makeProvider('ok');
      const result = await taskTool.execute(
        {
          description: 'd',
          prompt: 'do the work',
          subagent_type: 'explore',
          context_mode: mode,
          ...(mode === 'last_n' ? { context_count: 2 } : {}),
        },
        makeCtx({
          provider,
          agentRegistry: makeAgentRegistry(),
          sessionManager,
          sessionId: parent.id,
          contextConfig: makeSubagentContextConfig(),
        }, parent.id),
      );

      expect(result.isError).toBeFalsy();
      const [messages, systemPrompt] = chatAsync.mock.calls[0] as unknown as [
        Array<{ role: string; content: string }>,
        string,
      ];
      const history = messages.slice(0, -1).map((m) => m.content);
      // inherit — вся история (5), last_n(2) — до контрольной точки (4).
      expect(history).toEqual(
        mode === 'inherit'
          ? ['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4']
          : ['msg 0', 'msg 1', 'msg 2', 'msg 3'],
      );
      // Последнее user-сообщение — исходный prompt без префикса.
      expect(messages.at(-1)!.content).toBe('do the work');
      expect(systemPrompt).toContain('[SUBAGENT]');
    },
  );
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
      limits: {
        maxSubagentsPerSession: 0,
        maxProcessesPerSession: 0,
        maxRunsPerSession: 0,
        ...(limits ?? {}),
      },
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

  it('фон недоступен — дочерняя сессия не создаётся, session.created не публикуется', async () => {
    const { provider, chatAsync } = makeProvider();
    const { service } = makeBackgroundService();
    const eventBus = new EventBus();
    const created: string[] = [];
    eventBus.subscribe(parent.id, (e) => {
      if (e.type === 'session.created') created.push(e.type);
    });

    const sessionsBefore = await sessionManager.listSessions(undefined, { light: true });

    // 1. Фон выключен инстансом (`backgroundEnabled: false`).
    const disabled = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', background: true },
      makeCtx({
        provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        eventBus,
        backgroundService: service,
        backgroundEnabled: false,
      }, parent.id),
    );

    expect(disabled.isError).toBe(true);
    expect(disabled.content).toContain('Background subagents are disabled');
    expect(disabled.metadata!.i18n).toMatchObject({ key: 'task.background_disabled' });

    // 2. Сервиса фоновых прогонов нет вовсе.
    const noService = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', background: true },
      makeCtx({
        provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        eventBus,
      }, parent.id),
    );

    expect(noService.isError).toBe(true);
    expect(noService.content).toContain('Background subagents are disabled');
    expect(noService.metadata!.i18n).toMatchObject({ key: 'task.background_disabled' });

    // Дочерней сессии не появилось — «пустого» ребёнка не осталось.
    const sessionsAfter = await sessionManager.listSessions(undefined, { light: true });
    expect(sessionsAfter).toHaveLength(sessionsBefore.length);
    expect(sessionsAfter.map((s) => s.id)).toEqual(sessionsBefore.map((s) => s.id));
    expect(created).toHaveLength(0);
    // Прогон не запускался — LLM не звали.
    expect(chatAsync).not.toHaveBeenCalled();
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

  it('продолжение через task_id: температура агента (клон провайдера родителя)', async () => {
    const parentProv = makeTempAwareProvider('parent-prov', 'parent-model');
    const child = await sessionManager.createSession({
      title: 'C',
      parentId: parent.id,
      sessionOrigin: 'subagent',
      settings: { agentRole: 'explore', temperature: 0.6 },
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', task_id: child.id },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(['explore'], 0.15),
        sessionManager,
        sessionId: parent.id,
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    // Прогон — на клоне с температурой агента, оригинал не мутирован.
    expect(parentProv.created.at(-1)!.temperature).toBe(0.15);
    expect(parentProv.created.at(-1)!.chatAsync).toHaveBeenCalledTimes(1);
    expect(parentProv.provider.temperature).toBeUndefined();
  });

  it('продолжение через task_id: у агента температуры нет → температура дочерней сессии', async () => {
    const parentProv = makeTempAwareProvider('parent-prov', 'parent-model');
    const child = await sessionManager.createSession({
      title: 'C',
      parentId: parent.id,
      sessionOrigin: 'subagent',
      settings: { agentRole: 'explore', temperature: 0.6 },
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', task_id: child.id },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(['explore']),
        sessionManager,
        sessionId: parent.id,
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(parentProv.created.at(-1)!.temperature).toBe(0.6);
    // Stored-сессия не перезаписана прогоном.
    const stored = (await sessionManager.getSession(child.id))!;
    expect(stored.settings.temperature).toBe(0.6);
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

// ─────────────────────────────────────────────────────────────────────────────
// Выбор модели/провайдера саб-агента (ADR-034 Фаза 4).
//
// Явные `task({model, provider})` и дефолт `router.subagent.{model,provider}`
// должны определять провайдера **прогона**, а не только настройки дочерней
// сессии. Роутер (`modelRouter.route`) при явном выборе не зовётся.
// ─────────────────────────────────────────────────────────────────────────────

/** Провайдер с именем/моделью — чтобы отличить прогон по разным моделям. */
function makeNamedProvider(name: string, model: string, content = 'ok') {
  const chatAsync = vi.fn(() => (async function* () {
    yield { isFinal: true, content, toolCalls: [] };
  })());
  const provider = { model, name, chatAsync } as unknown as BaseProvider;
  return { provider, chatAsync };
}

/** Мок `ModelRouter`: `route()` + `getProvider()` (ADR-034). */
function makeModelRouterMock(over: {
  decision?: { providerName: string; modelName: string; strategy?: string; reason?: string };
  providerFor?: (decision: { providerName: string; modelName: string }) => BaseProvider | null;
}) {
  const route = vi.fn(async () => ({
    providerName: over.decision?.providerName ?? 'routed-prov',
    modelName: over.decision?.modelName ?? 'routed-model',
    reason: over.decision?.reason ?? 'routed',
    strategy: over.decision?.strategy ?? 'content',
  }));
  const getProvider = vi.fn((decision: { providerName: string; modelName: string }) =>
    (over.providerFor ? over.providerFor(decision) : null));
  return { route, getProvider, router: { route, getProvider } as unknown as ModelRouter };
}

/** RouterConfig-мок (секция `content` нужна для блока ROUTING в промпте). */
function makeRouterConfig(over: Partial<RouterConfig> = {}): RouterConfig {
  return {
    enabled: true,
    strategy: 'auto',
    content: {
      coding: { provider: '', model: '' },
      chat: { provider: '', model: '' },
      research: { provider: '', model: '' },
    },
    escalation: {
      enabled: false,
      fallbackProvider: '',
      fallbackModel: '',
      maxRetries: 1,
      checks: ['min_length'],
      minLength: 10,
    },
    cost: {
      enabled: false,
      cheapProvider: '',
      cheapModel: '',
      expensiveProvider: '',
      expensiveModel: '',
      maxCheapTokens: 500,
    },
    subagent: { enabled: true, model: '', provider: '' },
    ...over,
  } as RouterConfig;
}

describe('task/tool.ts — выбор модели/провайдера саб-агента (ADR-034 Фаза 4)', () => {
  let dir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-task-model-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: dir }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const parentSettings = {
    provider: 'parent-prov',
    model: 'parent-model',
    routingEnabled: true,
  } as unknown as SessionSettings;

  it('явные model+provider: route() не вызывается, getProvider получает эту пару, прогон идёт на ней', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const explicitProv = makeNamedProvider('explicit-prov', 'explicit-model');
    const { route, getProvider, router } = makeModelRouterMock({
      providerFor: (d) => (d.providerName === 'explicit-prov' ? explicitProv.provider : null),
    });

    const result = await taskTool.execute(
      {
        description: 'd',
        prompt: 'go',
        subagent_type: 'explore',
        model: 'explicit-model',
        provider: 'explicit-prov',
      },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig(),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    // Роутер не звали — пара задана явно.
    expect(route).not.toHaveBeenCalled();
    // Второй аргумент — температура прогона (агента/сессии); у теста её нет.
    expect(getProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerName: 'explicit-prov',
      modelName: 'explicit-model',
    }), undefined);
    // Прогон идёт на явно выбранном провайдере, а не на родительском.
    expect(explicitProv.chatAsync).toHaveBeenCalledTimes(1);
    expect(parentProv.chatAsync).not.toHaveBeenCalled();
    expect(result.metadata!.routing_strategy).toBe('explicit');
    expect(result.metadata!.routing_provider).toBe('explicit-prov');
    expect(result.metadata!.routing_model).toBe('explicit-model');

    // Настройки дочерней сессии = фактическая модель прогона.
    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.provider).toBe('explicit-prov');
    expect(child.settings.model).toBe('explicit-model');
  });

  it('составной model без provider: provider/model разбирается в пару (имя модели может содержать /)', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const routeraiProv = makeNamedProvider('routerai', 'google/gemini-3.1-flash-lite');
    const { getProvider, router } = makeModelRouterMock({
      providerFor: (d) => (d.providerName === 'routerai' ? routeraiProv.provider : null),
    });

    const result = await taskTool.execute(
      {
        description: 'd',
        prompt: 'go',
        subagent_type: 'explore',
        model: 'routerai/google/gemini-3.1-flash-lite',
      },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig(),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(getProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerName: 'routerai',
      modelName: 'google/gemini-3.1-flash-lite',
    }), undefined);
    expect(routeraiProv.chatAsync).toHaveBeenCalledTimes(1);
    expect(parentProv.chatAsync).not.toHaveBeenCalled();
    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.provider).toBe('routerai');
    expect(child.settings.model).toBe('google/gemini-3.1-flash-lite');
  });

  it('каталог моделей: неизвестная/отключённая пара → task.model_not_in_catalog со списком и list_models', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const { route, getProvider, router } = makeModelRouterMock({ providerFor: () => null });
    const sessionsBefore = await sessionManager.listSessions(undefined, { light: true });

    const result = await taskTool.execute(
      {
        description: 'd',
        prompt: 'go',
        subagent_type: 'explore',
        // Составной id: провайдер + несуществующая модель.
        model: 'routerai/missing-model',
      },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig(),
        listModels: async () => ([
          { id: 'm1', provider: 'routerai', name: 'known-model', enabled: true },
          { id: 'm2', provider: 'other', name: 'disabled-model', enabled: false },
        ]),
      }, parent.id),
    );

    expect(result.isError).toBe(true);
    expect(result.metadata!.i18n).toMatchObject({ key: 'task.model_not_in_catalog' });
    expect(result.content).toContain('routerai/missing-model');
    // Перечень доступных пар (отключённая модель не предлагается).
    expect(result.content).toContain('routerai/known-model');
    expect(result.content).not.toContain('other/disabled-model');
    // Отсылка к каталогу.
    expect(result.content).toContain('list_models');
    // До пула провайдеров и до прогона дело не дошло.
    expect(getProvider).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(parentProv.chatAsync).not.toHaveBeenCalled();
    const sessionsAfter = await sessionManager.listSessions(undefined, { light: true });
    expect(sessionsAfter).toHaveLength(sessionsBefore.length);
  });

  it('каталог моделей: валидная пара проходит, отключённая модель — отказ', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const routeraiProv = makeNamedProvider('routerai', 'google/gemini-3.1-flash-lite');
    const catalog = [
      { id: 'm1', provider: 'routerai', name: 'google/gemini-3.1-flash-lite', enabled: true },
      { id: 'm2', provider: 'routerai', name: 'off-model', enabled: false },
    ];
    const { router } = makeModelRouterMock({
      providerFor: (d) => (d.providerName === 'routerai' ? routeraiProv.provider : null),
    });

    const ok = await taskTool.execute(
      {
        description: 'd',
        prompt: 'go',
        subagent_type: 'explore',
        model: 'routerai/google/gemini-3.1-flash-lite',
      },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig(),
        listModels: async () => catalog,
      }, parent.id),
    );
    expect(ok.isError).toBeFalsy();
    expect(routeraiProv.chatAsync).toHaveBeenCalledTimes(1);

    const off = await taskTool.execute(
      {
        description: 'd',
        prompt: 'go',
        subagent_type: 'explore',
        model: 'routerai/off-model',
      },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig(),
        listModels: async () => catalog,
      }, parent.id),
    );
    expect(off.isError).toBe(true);
    expect(off.metadata!.i18n).toMatchObject({ key: 'task.model_not_in_catalog' });
    expect(off.content).toContain('routerai/off-model');
  });

  it('только model (без provider): пара = провайдер родителя + заданная модель', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const explicitProv = makeNamedProvider('parent-prov', 'only-model');
    const { route, getProvider, router } = makeModelRouterMock({
      providerFor: (d) => (d.modelName === 'only-model' ? explicitProv.provider : null),
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', model: 'only-model' },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig(),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(route).not.toHaveBeenCalled();
    expect(getProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerName: 'parent-prov',
      modelName: 'only-model',
    }), undefined);
    expect(explicitProv.chatAsync).toHaveBeenCalledTimes(1);
    expect(result.metadata!.routing_strategy).toBe('explicit');

    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.provider).toBe('parent-prov');
    expect(child.settings.model).toBe('only-model');
  });

  it('router.subagent.model/provider без явных параметров: используется конфиг-пара, route() не вызывается', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const cfgProv = makeNamedProvider('cfg-prov', 'cfg-model');
    const { route, getProvider, router } = makeModelRouterMock({
      providerFor: (d) => (d.providerName === 'cfg-prov' ? cfgProv.provider : null),
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore' },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig({
          subagent: { enabled: true, model: 'cfg-model', provider: 'cfg-prov' },
        }),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(route).not.toHaveBeenCalled();
    expect(getProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerName: 'cfg-prov',
      modelName: 'cfg-model',
    }), undefined);
    expect(cfgProv.chatAsync).toHaveBeenCalledTimes(1);
    expect(parentProv.chatAsync).not.toHaveBeenCalled();
    expect(result.metadata!.routing_strategy).toBe('subagent-config');

    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.provider).toBe('cfg-prov');
    expect(child.settings.model).toBe('cfg-model');
  });

  it('router.subagent.enabled=false: конфиг-пара игнорируется, роутер ведёт себя как обычно', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const { route, getProvider, router } = makeModelRouterMock({
      decision: { providerName: 'parent-prov', modelName: 'parent-model', strategy: 'default' },
      providerFor: () => parentProv.provider,
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore' },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig({
          subagent: { enabled: false, model: 'cfg-model', provider: 'cfg-prov' },
        }),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    // Конфиг-пара выключена — роутер решает, как и без неё.
    expect(route).toHaveBeenCalledTimes(1);
    expect(getProvider).not.toHaveBeenCalledWith(expect.objectContaining({
      providerName: 'cfg-prov',
      modelName: 'cfg-model',
    }));
    expect(parentProv.chatAsync).toHaveBeenCalledTimes(1);
  });

  it('routing_strategy=none: route() не вызывается, провайдер — родительский', async () => {    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const { route, getProvider, router } = makeModelRouterMock({
      providerFor: () => parentProv.provider,
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', routing_strategy: 'none' },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig(),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(route).not.toHaveBeenCalled();
    expect(getProvider).not.toHaveBeenCalled();
    expect(parentProv.chatAsync).toHaveBeenCalledTimes(1);
    expect(result.metadata!.routing_strategy).toBeUndefined();

    // Роутинг у ребёнка выключен.
    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.routingEnabled).toBe(false);
  });

  it('getProvider вернул null при явной паре → отказ task.model_unavailable (без тихого отката)', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const { route, getProvider, router } = makeModelRouterMock({ providerFor: () => null });

    const sessionsBefore = await sessionManager.listSessions(undefined, { light: true });

    const result = await taskTool.execute(
      {
        description: 'd',
        prompt: 'go',
        subagent_type: 'explore',
        model: 'missing-model',
        provider: 'missing-prov',
      },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig(),
      }, parent.id),
    );

    expect(result.isError).toBe(true);
    expect(result.metadata!.i18n).toMatchObject({ key: 'task.model_unavailable' });
    expect(result.content).toContain('missing-prov');
    expect(result.content).toContain('missing-model');
    expect(route).not.toHaveBeenCalled();
    expect(getProvider).toHaveBeenCalled();
    // Прогон не пошёл на родительском провайдере.
    expect(parentProv.chatAsync).not.toHaveBeenCalled();
    // Дочерней сессии не создано.
    const sessionsAfter = await sessionManager.listSessions(undefined, { light: true });
    expect(sessionsAfter).toHaveLength(sessionsBefore.length);
  });

  it('регрессия: блок ROUTING в промпте — только при своём выборе модели, не при родительской паре', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const prompts: string[] = [];
    const makeProv = (name: string, model: string) => ({
      model,
      name,
      chatAsync: vi.fn((_m: unknown, systemPrompt?: string) => (async function* () {
        prompts.push(systemPrompt || '');
        yield { isFinal: true, content: 'OK', toolCalls: [] };
      })()),
    });
    const explicitProv = makeProv('explicit-prov', 'explicit-model');
    const { router } = makeModelRouterMock({
      providerFor: (d) => (d.providerName === 'explicit-prov' ? explicitProv as unknown as BaseProvider : null),
    });

    const capture = async (params: Record<string, unknown>): Promise<string> => {
      prompts.length = 0;
      await taskTool.execute(
        { description: 'd', prompt: 'go', subagent_type: 'explore', ...params },
        makeCtx({
          provider: makeProv('parent-prov', 'parent-model') as unknown as BaseProvider,
          agentRegistry: makeAgentRegistry(),
          sessionManager,
          sessionId: parent.id,
          // Роутинг у родителя выключен (дефолт сессии).
          parentSessionSettings: {
            provider: 'parent-prov',
            model: 'parent-model',
            routingEnabled: false,
          } as unknown as SessionSettings,
          modelRouter: router,
          routerConfig: makeRouterConfig(),
        }, parent.id),
      );
      return prompts[0] ?? '';
    };

    // Родительская пара — блока роутинга в промпте нет (как и раньше).
    expect(await capture({})).not.toContain('[ROUTING]');
    // Свой выбор модели — блок роутинга объясняет доступные провайдеры.
    expect(await capture({ model: 'explicit-model', provider: 'explicit-prov' })).toContain('[ROUTING]');
  });

  it('регрессия: без явных параметров и без router.subagent — прежнее поведение (route() зовётся)', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const routedProv = makeNamedProvider('routed-prov', 'routed-model');
    const { route, getProvider, router } = makeModelRouterMock({
      decision: { providerName: 'routed-prov', modelName: 'routed-model', strategy: 'content' },
      providerFor: (d) => (d.providerName === 'routed-prov' ? routedProv.provider : null),
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore' },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig(),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(route).toHaveBeenCalledTimes(1);
    expect(getProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerName: 'routed-prov',
      modelName: 'routed-model',
    }), undefined);
    expect(routedProv.chatAsync).toHaveBeenCalledTimes(1);
    expect(parentProv.chatAsync).not.toHaveBeenCalled();
    expect(result.metadata!.routing_strategy).toBe('content');

    // Настройки ребёнка совпадают с фактической моделью прогона.
    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.provider).toBe('routed-prov');
    expect(child.settings.model).toBe('routed-model');
  });

  /**
   * Провайдер с `withTemperature`/`withSampling` (как у `BaseProvider`):
   * клоны фиксируются по порядку, оригинал не мутируется.
   */
  function makeSamplingAwareProvider(name: string, model: string) {
    const created: Array<{
      temperature?: number;
      topP?: number;
      topK?: number;
      chatAsync: ReturnType<typeof vi.fn>;
    }> = [];
    const make = (temperature?: number, topP?: number, topK?: number): BaseProvider => {
      const chatAsync = vi.fn(() => (async function* () {
        yield { isFinal: true, content: 'ok', toolCalls: [] };
      })());
      const provider = {
        name,
        model,
        temperature,
        topP,
        topK,
        chatAsync,
        withTemperature: (next: number | undefined) => make(next, topP, topK),
        withSampling: (p: number | undefined, k: number | undefined) => make(temperature, p, k),
      } as unknown as BaseProvider;
      created.push({ temperature, topP, topK, chatAsync });
      return provider;
    };
    return { provider: make(), created };
  }

  it('provider/model агента: пара из AgentDefinition, sampling уходит в getProvider, ребёнок видит пару', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const agentProv = makeNamedProvider('agent-prov', 'agent-model');
    const { route, getProvider, router } = makeModelRouterMock({
      providerFor: (d) => (d.providerName === 'agent-prov' ? agentProv.provider : null),
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore' },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(['explore'], undefined, {
          provider: 'agent-prov',
          model: 'agent-model',
          topP: 0.8,
          topK: 40,
        }),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        // Пара агента выше дефолта инстанса для саб-агентов.
        routerConfig: makeRouterConfig({
          subagent: { enabled: true, model: 'cfg-model', provider: 'cfg-prov' },
        }),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(route).not.toHaveBeenCalled();
    const call = getProvider.mock.calls[0] as unknown[];
    expect(call[0]).toMatchObject({ providerName: 'agent-prov', modelName: 'agent-model' });
    // topP/topK агента — 6-й и 7-й аргументы пула.
    expect(call[5]).toBe(0.8);
    expect(call[6]).toBe(40);
    expect(agentProv.chatAsync).toHaveBeenCalledTimes(1);
    expect(parentProv.chatAsync).not.toHaveBeenCalled();
    expect(result.metadata!.routing_strategy).toBe('agent');

    // Ребёнок видит фактическую пару прогона.
    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.provider).toBe('agent-prov');
    expect(child.settings.model).toBe('agent-model');
  });

  it('только model агента: провайдер — родительский, модель — агента', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const agentProv = makeNamedProvider('parent-prov', 'agent-model');
    const { getProvider, router } = makeModelRouterMock({
      providerFor: (d) => (d.providerName === 'parent-prov' && d.modelName === 'agent-model'
        ? agentProv.provider
        : null),
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore' },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(['explore'], undefined, { model: 'agent-model' }),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig(),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(getProvider.mock.calls[0]![0]).toMatchObject({
      providerName: 'parent-prov',
      modelName: 'agent-model',
    });
    expect(agentProv.chatAsync).toHaveBeenCalledTimes(1);
    expect(parentProv.chatAsync).not.toHaveBeenCalled();
    expect(result.metadata!.routing_strategy).toBe('agent');

    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.provider).toBe('parent-prov');
    expect(child.settings.model).toBe('agent-model');
  });

  it('явные params.model/provider приоритетнее пары агента', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const explicitProv = makeNamedProvider('explicit-prov', 'explicit-model');
    const { getProvider, router } = makeModelRouterMock({
      providerFor: (d) => (d.providerName === 'explicit-prov' ? explicitProv.provider : null),
    });

    const result = await taskTool.execute(
      {
        description: 'd',
        prompt: 'go',
        subagent_type: 'explore',
        model: 'explicit-model',
        provider: 'explicit-prov',
      },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(['explore'], undefined, {
          provider: 'agent-prov',
          model: 'agent-model',
        }),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig(),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(getProvider.mock.calls[0]![0]).toMatchObject({
      providerName: 'explicit-prov',
      modelName: 'explicit-model',
    });
    expect(explicitProv.chatAsync).toHaveBeenCalledTimes(1);
    expect(result.metadata!.routing_strategy).toBe('explicit');
    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.provider).toBe('explicit-prov');
    expect(child.settings.model).toBe('explicit-model');
  });

  it('пара агента совпадает с родительской: базовый провайдер (температура/sampling), пул не зовём', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeSamplingAwareProvider('parent-prov', 'parent-model');
    const { route, getProvider, router } = makeModelRouterMock({
      providerFor: () => { throw new Error('пул не должен вызываться для родительской пары'); },
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore' },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(['explore'], 0.15, {
          provider: 'parent-prov',
          model: 'parent-model',
          topP: 0.8,
          topK: 40,
        }),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings,
        modelRouter: router,
        routerConfig: makeRouterConfig(),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(getProvider).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    const runProvider = parentProv.created.at(-1)!;
    expect(runProvider.temperature).toBe(0.15);
    expect(runProvider.topP).toBe(0.8);
    expect(runProvider.topK).toBe(40);
    expect(runProvider.chatAsync).toHaveBeenCalledTimes(1);
    // Оригинал не мутирован.
    expect(parentProv.created[0]!.temperature).toBeUndefined();
    expect(parentProv.created[0]!.topP).toBeUndefined();
  });

  it('task_id: продолжение идёт на паре агента (settings ребёнка) через пул', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeNamedProvider('parent-prov', 'parent-model');
    const agentProv = makeNamedProvider('agent-prov', 'agent-model');
    const child = await sessionManager.createSession({
      title: 'C',
      parentId: parent.id,
      sessionOrigin: 'subagent',
      settings: { agentRole: 'explore', provider: 'agent-prov', model: 'agent-model' },
    });
    const { getProvider, router } = makeModelRouterMock({
      providerFor: (d) => (d.providerName === 'agent-prov' ? agentProv.provider : null),
    });

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', task_id: child.id },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(['explore'], undefined, { topP: 0.8, topK: 40 }),
        sessionManager,
        sessionId: parent.id,
        modelRouter: router,
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    const call = getProvider.mock.calls[0] as unknown[];
    expect(call[0]).toMatchObject({ providerName: 'agent-prov', modelName: 'agent-model' });
    expect(call[5]).toBe(0.8);
    expect(call[6]).toBe(40);
    expect(agentProv.chatAsync).toHaveBeenCalledTimes(1);
    expect(parentProv.chatAsync).not.toHaveBeenCalled();
    // Stored-сессия ребёнка не переписана прогоном.
    const stored = (await sessionManager.getSession(child.id))!;
    expect(stored.settings.provider).toBe('agent-prov');
    expect(stored.settings.model).toBe('agent-model');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Температура саб-агента: `agent.temperature` → `session.settings.temperature`
// родителя → дефолт модели. Одна и та же величина должна дойти и до провайдера
// прогона, и до настроек дочерней сессии (провайдеры кэшируются в пуле —
// мутировать их нельзя, только клонировать через `withTemperature`).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Провайдер с `withTemperature` (как у `BaseProvider`): клон получает новую
 * температуру, оригинал не мутируется. `created` — экземпляры по порядку:
 * последний — тот, на котором шёл прогон.
 */
function makeTempAwareProvider(name: string, model: string) {
  const created: Array<{ temperature?: number; chatAsync: ReturnType<typeof vi.fn> }> = [];
  const make = (temperature?: number): BaseProvider => {
    const chatAsync = vi.fn(() => (async function* () {
      yield { isFinal: true, content: 'ok', toolCalls: [] };
    })());
    const provider = {
      name,
      model,
      temperature,
      chatAsync,
      withTemperature: (next: number | undefined) => make(next),
    } as unknown as BaseProvider;
    created.push({ temperature, chatAsync });
    return provider;
  };
  return { provider: make(), created };
}

describe('task/tool.ts — температура саб-агента', () => {
  let dir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-task-temp-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: dir }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const parentSettings = (temperature?: number) => ({
    provider: 'parent-prov',
    model: 'parent-model',
    routingEnabled: false,
    ...(temperature !== undefined ? { temperature } : {}),
  }) as unknown as SessionSettings;

  it('температура агента приоритетнее сессии: провайдер прогона — клон, настройки ребёнка совпадают', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeTempAwareProvider('parent-prov', 'parent-model');

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore' },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(['explore'], 0.2),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings(0.7),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    // Прогон идёт на клоне с температурой агента, оригинал не мутирован.
    expect(parentProv.created).toHaveLength(2);
    expect(parentProv.created.at(-1)!.temperature).toBe(0.2);
    expect(parentProv.created.at(-1)!.chatAsync).toHaveBeenCalledTimes(1);
    expect(parentProv.provider.temperature).toBeUndefined();

    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.temperature).toBe(0.2);
  });

  it('у агента температуры нет → берётся температура родительской сессии', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeTempAwareProvider('parent-prov', 'parent-model');

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore' },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(['explore']),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings(0.45),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    expect(parentProv.created.at(-1)!.temperature).toBe(0.45);

    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.temperature).toBe(0.45);
  });

  it('ни у агента, ни у сессии температуры нет → провайдер не клонируется, в настройках ребёнка temperature нет', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeTempAwareProvider('parent-prov', 'parent-model');

    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore' },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(['explore']),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings(),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    // Клона нет — используется родительский провайдер как есть.
    expect(parentProv.created).toHaveLength(1);
    expect(parentProv.provider.chatAsync).toHaveBeenCalledTimes(1);

    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.temperature).toBeUndefined();
  });

  it('явная модель: температура агента уходит в пул провайдеров роутера', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const parentProv = makeTempAwareProvider('parent-prov', 'parent-model');
    const explicitProv = makeNamedProvider('explicit-prov', 'explicit-model');
    const { getProvider, router } = makeModelRouterMock({
      providerFor: (d) => (d.providerName === 'explicit-prov' ? explicitProv.provider : null),
    });

    const result = await taskTool.execute(
      {
        description: 'd',
        prompt: 'go',
        subagent_type: 'explore',
        model: 'explicit-model',
        provider: 'explicit-prov',
      },
      makeCtx({
        provider: parentProv.provider,
        agentRegistry: makeAgentRegistry(['explore'], 0.35),
        sessionManager,
        sessionId: parent.id,
        parentSessionSettings: parentSettings(0.7),
        modelRouter: router,
        routerConfig: makeRouterConfig(),
      }, parent.id),
    );

    expect(result.isError).toBeFalsy();
    // Температура — второй аргумент `ModelRouter.getProvider` (её кладёт в
    // cacheKey пул, иначе агенты делили бы один экземпляр провайдера).
    expect(getProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerName: 'explicit-prov',
      modelName: 'explicit-model',
    }), 0.35);
    expect(explicitProv.chatAsync).toHaveBeenCalledTimes(1);

    const child = (await sessionManager.getSession(result.metadata!.child_session_id as string))!;
    expect(child.settings.temperature).toBe(0.35);
  });
});
