/**
 * Резолвинг роли агента: алиасы прежнего набора и фоллбек на роль по умолчанию.
 *
 * В инстансах с историей у сессий может остаться `settings.agentRole` с id роли
 * прежнего набора (`pm`/`developer`/`qa`/`analyst`/`auditor`). Для них работает
 * алиас на актуальную роль (`pm` → `leader`): промпт, capabilities и лимиты
 * берутся у целевого агента, предупреждения нет. Действительно неизвестная роль
 * (нет ни в реестре, ни в алиасах) по-прежнему даёт фоллбек `DEFAULT_AGENT_ID`:
 * ход не падает, промпт не пустой, ограничения роли не исчезают (иначе
 * неизвестная роль = «агент без ограничений» — fail-open), в лог уходит
 * предупреждение. Метка роли в сессии при этом сохраняется: она историческая
 * (attribution, аналитика, `promptStates`).
 *
 * Проверяется через реальный `ContextBuilder`/`ContextConfig`: именно он читает
 * `prompts/roles/<CONTEXT_FILE>` для блока `role`.
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
import { createAgentRegistry, DEFAULT_AGENT_ID, LEGACY_AGENT_ROLE_ALIASES } from './agents/index.js';
import { ContextConfig } from './context/config.js';
import { ContextBuilder } from './context/builder.js';
import { ProviderFactory, BaseProvider, resolveSystemPromptText } from '../providers/base.js';
import type { LLMMessage, CancellationToken, SystemPromptInput } from '../providers/base.js';
import type { Message, ProviderConfig } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';

function makeUserMessage(content = 'привет'): Message {
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

/** Мок-провайдер: запоминает системный промпт и отвечает текстом. */
class RoleFallbackProvider extends BaseProvider {
  static lastSystemPrompt: string | undefined;
  static calls = 0;

  async chat(messages: LLMMessage[], systemPrompt?: SystemPromptInput): Promise<import('@itphx/synth-shared').LLMResponse> {
    RoleFallbackProvider.calls++;
    RoleFallbackProvider.lastSystemPrompt = resolveSystemPromptText(systemPrompt);
    void messages;
    return {
      content: 'ответ',
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  async *chatAsync(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    RoleFallbackProvider.calls++;
    RoleFallbackProvider.lastSystemPrompt = resolveSystemPromptText(systemPrompt);
    void messages;
    yield {
      content: 'ответ',
      isFinal: true,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'rolefallback';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  tmpDir: string;
}

async function makeHarness(agentRole: string): Promise<Harness & { sessionId: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-role-fallback-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  // ADR-075: file/shell-тулы доступны только при заданном workspace проекта —
  // иначе недоступность тула объяснялась бы `workspace`, а не ролью.
  const project = projectStore.create('RoleFallback', 'u1', { workspace: tmpDir });
  await projectStore.save(project);
  const contextConfig = new ContextConfig({ userDataDir: join(tmpDir, 'context') });
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus: new EventBus(),
    contextBuilder: new ContextBuilder(contextConfig),
    providerLoader: (name: string) =>
      ({
        name,
        type: 'rolefallback',
        baseUrl: '',
        apiKey: '',
        defaultModel: 'm',
      }) as unknown as ProviderConfig,
    toolRegistry: createToolRegistry(),
    agentRegistry: createAgentRegistry(),
    permissionConfig: { rules: {}, askTimeoutMs: 1000 },
    projectStore,
    defaultWorkingDir: tmpDir,
    contextConfig,
  });
  const session = await sessionManager.createSession({
    title: 'RoleFallback',
    projectId: project.id,
    settings: { provider: 'rolefallback', model: 'm', agentRole },
  });
  return { orchestrator, sessionManager, tmpDir, sessionId: session.id };
}

async function runTurn(h: Harness & { sessionId: string }): Promise<void> {
  const message = makeUserMessage();
  await h.sessionManager.addMessage(h.sessionId, message);
  const session = (await h.sessionManager.getSession(h.sessionId))!;
  await h.orchestrator.createProcessMessage()(
    session,
    message,
    new AbortController().signal,
    () => {},
  );
}

describe('ChatOrchestrator: устаревшая роль агента (алиас прежнего набора)', () => {
  let h: Harness & { sessionId: string };

  beforeEach(async () => {
    ProviderFactory.register('rolefallback', RoleFallbackProvider);
    RoleFallbackProvider.calls = 0;
    RoleFallbackProvider.lastSystemPrompt = undefined;
    // `pm` — роль прежнего набора; набор заменён, но `settings.agentRole` у
    // старых сессий хранит прежнюю метку.
    h = await makeHarness('pm');
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('rolefallback');
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('pm → leader: промпт целевой роли, метка в сессии остаётся pm', async () => {
    await runTurn(h);

    expect(RoleFallbackProvider.calls).toBe(1);
    const prompt = RoleFallbackProvider.lastSystemPrompt ?? '';
    expect(prompt).toContain('[ROLE: LEADER]');
    expect(prompt).not.toContain('[ROLE: PM]');

    // Метка историческая — не переписывается (attribution/аналитика).
    const stored = (await h.sessionManager.getSession(h.sessionId))!;
    expect(stored.settings.agentRole).toBe('pm');
  });

  it('pm → leader: ограничения берутся у leader (shell недоступен, чтение — да)', async () => {
    const stored = (await h.sessionManager.getSession(h.sessionId))!;
    const info = await h.orchestrator.getPromptInfo(stored);
    const shell = info.toolsDetail.find((t) => t.name === 'execute_shell')!;
    expect(shell.available).toBe(false);
    expect(shell.reason).toBe('role');
    expect(info.toolsDetail.find((t) => t.name === 'read_file')!.available).toBe(true);
  });

  it('история с меткой pm остаётся «своей»: без атрибуции [pm]: и без смены роли', () => {
    const past: Message = {
      id: generateId(),
      role: MessageRole.ASSISTANT,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart('старый ответ')],
      content: 'старый ответ',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      author: 'pm',
      agentRole: 'pm',
    };

    // Активный агент — leader (алиас pm): прошлый ход принадлежит ему же.
    const own = ChatOrchestrator._sessionMessagesToLlm([past], 'leader');
    expect(own[0]!.role).toBe('assistant');
    expect(own[0]!.content).toBe('старый ответ');

    // Контроль: действительно чужая роль остаётся атрибутированной.
    const foreign = ChatOrchestrator._sessionMessagesToLlm([past], 'fixer');
    expect(foreign[0]!.role).toBe('user');
    expect(foreign[0]!.content).toBe('[pm]: старый ответ');
  });
});

describe('ChatOrchestrator: неизвестная роль агента → фоллбек на DEFAULT_AGENT_ID', () => {
  let h: Harness & { sessionId: string };

  beforeEach(async () => {
    ProviderFactory.register('rolefallback', RoleFallbackProvider);
    RoleFallbackProvider.calls = 0;
    RoleFallbackProvider.lastSystemPrompt = undefined;
    // Роль, которой нет ни в реестре, ни среди алиасов прежнего набора.
    h = await makeHarness('legacy-unknown');
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('rolefallback');
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('ход не падает, промпт берётся у assistant, а не пустой', async () => {
    await runTurn(h);

    expect(RoleFallbackProvider.calls).toBe(1);
    const prompt = RoleFallbackProvider.lastSystemPrompt ?? '';
    expect(prompt).toContain('[ROLE: ASSISTANT]');
    expect(prompt).not.toContain('[ROLE: LEGACY-UNKNOWN]');

    const stored = (await h.sessionManager.getSession(h.sessionId))!;
    const lastAssistant = [...stored.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT);
    expect(lastAssistant?.content).toBe('ответ');
  });

  it('метка роли в сессии сохраняется (attribution/аналитика/история)', async () => {
    await runTurn(h);
    const stored = (await h.sessionManager.getSession(h.sessionId))!;
    expect(stored.settings.agentRole).toBe('legacy-unknown');
  });

  it('ограничения роли берутся у assistant: execute_shell недоступен по роли', async () => {
    const stored = (await h.sessionManager.getSession(h.sessionId))!;
    const info = await h.orchestrator.getPromptInfo(stored);
    const shell = info.toolsDetail.find((t) => t.name === 'execute_shell')!;
    expect(shell.available).toBe(false);
    expect(shell.reason).toBe('role');
    // assistant умеет читать файлы — тул остаётся доступным
    expect(info.toolsDetail.find((t) => t.name === 'read_file')!.available).toBe(true);
  });

  it('известная роль не затронута фоллбеком: fixer получает свой промпт и shell', async () => {
    await rm(h.tmpDir, { recursive: true, force: true });
    h = await makeHarness('fixer');
    await runTurn(h);

    const prompt = RoleFallbackProvider.lastSystemPrompt ?? '';
    expect(prompt).toContain('[ROLE: FIXER]');

    const stored = (await h.sessionManager.getSession(h.sessionId))!;
    const info = await h.orchestrator.getPromptInfo(stored);
    const shell = info.toolsDetail.find((t) => t.name === 'execute_shell')!;
    expect(shell.available).toBe(true);
  });

  it('роль по умолчанию известна реестру (фоллбеку есть куда падать)', () => {
    const registry = createAgentRegistry();
    expect(DEFAULT_AGENT_ID).toBe('assistant');
    expect(registry.get(DEFAULT_AGENT_ID)).toBeDefined();
  });

  it('каждый алиас прежнего набора ведёт на существующего агента', () => {
    const registry = createAgentRegistry();
    for (const [legacy, target] of Object.entries(LEGACY_AGENT_ROLE_ALIASES)) {
      expect(registry.get(target), `${legacy} → ${target}`).toBeDefined();
    }
  });
});
