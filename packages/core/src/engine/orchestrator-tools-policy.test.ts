/**
 * ADR-071 §2.3 (Фаза 3): политика включения инструментов — `consistency` /
 * `available` / `auto`, per-session override, фильтрация тулов и отсутствие
 * `unavailable`-подсказок в режиме `available`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { ContextFileRepository } from '../storage/ports/context-file-repository.js';
import type { McpManager } from './mcp/index.js';
import { createToolRegistry } from './tools/index.js';
import { createAgentRegistry } from './agents/index.js';
import type { ExecRequest, ExecResult, ExecutionPort } from '../execution/ports/index.js';
import { stubContextFiles } from '../test-helpers/storage-stubs.js';
import {
  generateId,
  MessageRole,
  nowISO,
  makeTextPart,
  ToolCapability,
  type Message,
  type Session,
  type SessionMode,
  type ToolDefinition,
  type ToolsPolicy,
  type McpServerToolSettings,
} from '@itphx/synth-shared';

const UNAVAILABLE_MARKER = '[НЕДОСТУПНЫЕ ТУЛЫ]';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

/** Стаб `ContextFileRepository` (реализация — ContextConfig): mode_change с unavailable-секцией. */
function makeContextConfig(): ContextFileRepository {
  return stubContextFiles({
    getModePrompt: () => '[MODE]',
    getPlanModePrompt: () => '[PLAN MODE]',
    getModePolicy: () => '[MODE POLICY]',
    getPlanGuide: () => '[PLAN GUIDE]',
  });
}

function makeUserMessage(content = 'Привет'): Message {
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

/** Мок-провайдер: запоминает `tools`, переданные в последний chatAsync. */
class ToolCaptureProvider extends BaseProvider {
  static lastTools: Array<Record<string, unknown>> | undefined;

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'ok', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: unknown,
    tools?: Array<Record<string, unknown>>,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    ToolCaptureProvider.lastTools = tools;
    yield { content: 'ok', isFinal: true, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: this.model };
  }

  getProviderName(): string {
    return 'toolcapture';
  }
}

/** Локальный провайдер (type=ollama) — для проверки `auto`. */
class LocalCaptureProvider extends ToolCaptureProvider {
  getProviderName(): string {
    return 'localcapture';
  }
}

/** Мок McpManager: лениво регистрирует MCP-тулы активных серверов. */
function makeMockMcpManager(): McpManager {
  const tools: Record<string, string[]> = { srvA: ['search'], srvB: ['fetch'] };
  const connected = new Set<string>();
  const manager = {
    getConfig() {
      return Object.fromEntries(
        Object.keys(tools).map((name) => [name, { type: 'sse', url: `http://${name}/mcp` }]),
      );
    },
    async refreshExecutorServers() {
      // ADR-077 (шаг B2): состав исполнителя обновляется до расчёта скоупа.
    },
    async ensureToolsLoaded(serverNames: string[], registry: { register(tool: ToolDefinition): void }) {
      for (const server of serverNames) {
        connected.add(server);
        for (const name of tools[server] ?? []) {
          const def: ToolDefinition = {
            name: `${server}_${name}`,
            description: `[MCP:${server}] ${name}`,
            parameters: z.object({}).passthrough(),
            capabilities: [ToolCapability.MCP],
            source: 'mcp',
            mcpServer: server,
            execute: async () => ({ content: 'mcp-result' }),
          };
          registry.register(def);
        }
      }
    },
    getServerStatus(name: string) {
      return connected.has(name) ? 'connected' : 'disconnected';
    },
    getServerOrigin() {
      return 'instance';
    },
    getServerTrust() {
      return 'builtin';
    },
    isDefaultServer() {
      return false;
    },
    isServerSystemEnabled() {
      return true;
    },
    getServerTools(name: string) {
      if (!connected.has(name)) return null;
      return (tools[name] ?? []).map((tool) => ({
        name: tool,
        description: `${tool} tool`,
        inputSchema: { type: 'object' },
      }));
    },
    getServerDescription() {
      return undefined;
    },
    getServerInstructions() {
      return undefined;
    },
  };
  return manager as unknown as McpManager;
}

/** Порт-заглушка: доступность программ задаётся тестом (ADR-077, шаг A). */
class DepsPort implements ExecutionPort {
  constructor(readonly available: Record<string, boolean>) {}

  async execute(_req: ExecRequest): Promise<ExecResult> {
    throw new Error('порт-заглушка не выполняет команды');
  }

  async probe(bin: string): Promise<boolean> {
    return this.available[bin] ?? true;
  }
}

describe('ChatOrchestrator — tools.policy (ADR-071 §2.3)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let projectId: string;
  let orchestrator: ChatOrchestrator;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-policy-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    // ADR-075: file/shell/git-тулы доступны только при заданном workspace проекта.
    const project = projectStore.create('Policy', 'u1', { workspace: tmpDir });
    await projectStore.save(project);
    projectId = project.id;
    ToolCaptureProvider.lastTools = undefined;
    ProviderFactory.register('toolcapture', ToolCaptureProvider);
    ProviderFactory.register('ollama', LocalCaptureProvider);

    orchestrator = makeOrchestrator();
  });

  /** Сборка оркестратора; `executionPort` — источник доступности программ (ADR-077). */
  function makeOrchestrator(opts: { executionPort?: ExecutionPort } = {}): ChatOrchestrator {
    const toolRegistry = createToolRegistry();
    return new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      contextConfig: makeContextConfig(),
      providerLoader: (name: string) =>
        ({
          name,
          type: name === 'local' ? 'ollama' : 'toolcapture',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
      projectStore,
      toolRegistry,
      agentRegistry: createAgentRegistry(toolRegistry),
      mcpManager: makeMockMcpManager(),
      ...(opts.executionPort ? { executionPort: opts.executionPort } : {}),
    });
  }

  afterEach(async () => {
    ProviderFactory['_providers'].delete('toolcapture');
    ProviderFactory['_providers'].delete('ollama');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createSession(opts: {
    provider?: string;
    mode?: SessionMode;
    mcpServers?: string[];
    toolsPolicy?: ToolsPolicy;
    mcpPolicy?: ToolsPolicy;
    mcpToolSettings?: Record<string, McpServerToolSettings>;
  } = {}): Promise<Session> {
    return sessionManager.createSession({
      title: 'tools policy',
      projectId,
      settings: {
        provider: opts.provider ?? 'cloud',
        model: 'm',
        agentRole: 'developer',
        mcpServers: opts.mcpServers ?? [],
        toolsPolicy: opts.toolsPolicy,
        mcpPolicy: opts.mcpPolicy,
        mcpToolSettings: opts.mcpToolSettings,
      },
    }).then(async (session) => {
      if (opts.mode) {
        session.mode = opts.mode;
        await sessionManager.saveSession(session);
      }
      return session;
    });
  }

  async function runTurn(sessionId: string): Promise<Session> {
    const msg = makeUserMessage();
    await sessionManager.addMessage(sessionId, msg);
    const fresh = (await sessionManager.getSession(sessionId))!;
    await orchestrator.createProcessMessage()(fresh, msg, new AbortController().signal, () => {});
    return (await sessionManager.getSession(sessionId))!;
  }

  function toolNames(): string[] {
    return (ToolCaptureProvider.lastTools ?? []).map(
      (t) => (t.function as { name: string }).name,
    );
  }

  function hasUnavailableHint(session: Session): boolean {
    return session.messages.some((m) => m.content.includes(UNAVAILABLE_MARKER));
  }

  it('consistency: все встроенные тулы (plan-блокированные тоже) + подсказки unavailable', async () => {
    const session = await createSession({ mode: 'plan' });
    await runTurn(session.id);

    const names = toolNames();
    expect(names).toContain('read_file');
    expect(names).toContain('write_file'); // план блокирует, но в consistency тул в запросе

    const after = (await sessionManager.getSession(session.id))!;
    expect(hasUnavailableHint(after)).toBe(true);

    const info = await orchestrator.getPromptInfo(after);
    expect(info.manifest.toolsPolicy).toBe('consistency');
    expect(info.manifest.entries.find((e) => e.key === 'tools')!.tier).toBe('stable');
    expect(info.manifest.entries.find((e) => e.key === 'tools.guide')).toBeUndefined();
  });

  it('available: только доступные тулы, нет подсказок unavailable, tools context + tools.guide', async () => {
    const session = await createSession({ mode: 'plan' });
    orchestrator.setToolsPolicy('available');
    await runTurn(session.id);

    const names = toolNames();
    expect(names).toContain('read_file');
    expect(names).not.toContain('write_file'); // plan-рестрикция скрывает тул

    const after = (await sessionManager.getSession(session.id))!;
    expect(hasUnavailableHint(after)).toBe(false);

    const info = await orchestrator.getPromptInfo(after);
    expect(info.manifest.toolsPolicy).toBe('available');
    expect(info.manifest.entries.find((e) => e.key === 'tools')!.tier).toBe('context');
    expect(info.manifest.entries.find((e) => e.key === 'tools.guide')).toBeDefined();
  });

  it('mcp available: MCP-тулы фильтруются по mcpToolSettings (plan/act)', async () => {
    const session = await createSession({
      mode: 'plan',
      mcpServers: ['srvA', 'srvB'],
      toolsPolicy: 'consistency',
      mcpPolicy: 'available',
      mcpToolSettings: { srvA: { default: { plan: false, act: true } } },
    });
    await runTurn(session.id);

    const names = toolNames();
    expect(names).not.toContain('srvA_search'); // выключен в plan
    expect(names).toContain('srvB_fetch'); // default-доступен
  });

  it('разделение политик: tools=available не фильтрует MCP (mcp=consistency)', async () => {
    const session = await createSession({
      mode: 'plan',
      mcpServers: ['srvA'],
      toolsPolicy: 'available',
      mcpPolicy: 'consistency',
      mcpToolSettings: { srvA: { default: { plan: false, act: true } } },
    });
    await runTurn(session.id);

    const names = toolNames();
    // Встроенные сужены политикой.
    expect(names).not.toContain('write_file');
    // MCP не сужен (consistency) — тул на месте, несмотря на plan=false.
    expect(names).toContain('srvA_search');

    const after = (await sessionManager.getSession(session.id))!;
    const info = await orchestrator.getPromptInfo(after);
    expect(info.manifest.toolsPolicy).toBe('available');
    expect(info.manifest.mcpPolicy).toBe('consistency');
  });

  it('разделение политик: mcp=available не фильтрует встроенные (tools=consistency)', async () => {
    const session = await createSession({
      mode: 'plan',
      mcpServers: ['srvA'],
      toolsPolicy: 'consistency',
      mcpPolicy: 'available',
      mcpToolSettings: { srvA: { default: { plan: false, act: true } } },
    });
    await runTurn(session.id);

    const names = toolNames();
    // Встроенные не сужены (consistency): plan-блокированный write_file в запросе.
    expect(names).toContain('write_file');
    // MCP сужен политикой.
    expect(names).not.toContain('srvA_search');

    const after = (await sessionManager.getSession(session.id))!;
    const info = await orchestrator.getPromptInfo(after);
    expect(info.manifest.toolsPolicy).toBe('consistency');
    expect(info.manifest.mcpPolicy).toBe('available');
  });

  it('дефолт auto: облачный провайдер → обе политики consistency', async () => {
    const session = await createSession({ mode: 'plan', mcpServers: ['srvA'] });
    await runTurn(session.id);

    const after = (await sessionManager.getSession(session.id))!;
    const info = await orchestrator.getPromptInfo(after);
    expect(info.manifest.toolsPolicy).toBe('consistency');
    expect(info.manifest.mcpPolicy).toBe('consistency');
  });

  it('дефолт auto: локальный провайдер (ollama) → обе политики available', async () => {
    const session = await createSession({ provider: 'local', mode: 'plan', mcpServers: ['srvA'] });
    await runTurn(session.id);

    const after = (await sessionManager.getSession(session.id))!;
    const info = await orchestrator.getPromptInfo(after);
    expect(info.manifest.toolsPolicy).toBe('available');
    expect(info.manifest.mcpPolicy).toBe('available');
  });

  it('mcp=available добавляет tools.guide и volatile mcp.servers', async () => {
    const session = await createSession({
      mcpServers: ['srvA'],
      toolsPolicy: 'consistency',
      mcpPolicy: 'available',
    });
    await runTurn(session.id);

    const after = (await sessionManager.getSession(session.id))!;
    const info = await orchestrator.getPromptInfo(after);
    expect(info.manifest.entries.find((e) => e.key === 'tools.guide')).toBeDefined();
    expect(info.manifest.entries.find((e) => e.key === 'mcp.servers')!.tier).toBe('volatile');
  });

  it('available: plan-approve (act) возвращает write-тулы', async () => {
    const session = await createSession({ mode: 'act', toolsPolicy: 'available' });
    await runTurn(session.id);
    expect(toolNames()).toContain('write_file');
  });

  it('auto: локальный провайдер (ollama) → available', async () => {
    const session = await createSession({ provider: 'local', mode: 'plan', toolsPolicy: 'auto' });
    await runTurn(session.id);

    const names = toolNames();
    expect(names).not.toContain('write_file');
    const after = (await sessionManager.getSession(session.id))!;
    const info = await orchestrator.getPromptInfo(after);
    expect(info.manifest.toolsPolicy).toBe('available');
  });

  it('auto: облачный провайдер → consistency', async () => {
    const session = await createSession({ provider: 'cloud', mode: 'plan', toolsPolicy: 'auto' });
    await runTurn(session.id);

    expect(toolNames()).toContain('write_file');
    const after = (await sessionManager.getSession(session.id))!;
    const info = await orchestrator.getPromptInfo(after);
    expect(info.manifest.toolsPolicy).toBe('consistency');
  });

  it('per-session override перекрывает глобальную: global consistency → session available', async () => {
    orchestrator.setToolsPolicy('consistency');
    const session = await createSession({ mode: 'plan', toolsPolicy: 'available' });
    await runTurn(session.id);

    expect(toolNames()).not.toContain('write_file');
    const after = (await sessionManager.getSession(session.id))!;
    expect(hasUnavailableHint(after)).toBe(false);
    expect((await orchestrator.getPromptInfo(after)).manifest.toolsPolicy).toBe('available');
  });

  it('per-session override перекрывает глобальную: global available → session consistency', async () => {
    orchestrator.setToolsPolicy('available');
    const session = await createSession({ mode: 'plan', toolsPolicy: 'consistency' });
    await runTurn(session.id);

    expect(toolNames()).toContain('write_file');
    const after = (await sessionManager.getSession(session.id))!;
    expect(hasUnavailableHint(after)).toBe(true);
    expect((await orchestrator.getPromptInfo(after)).manifest.toolsPolicy).toBe('consistency');
  });

  it('available: статический префикс не включает изменчивый tools (staticPrefixChars < totalChars)', async () => {
    const session = await createSession({ mcpServers: ['srvA'], toolsPolicy: 'available' });
    await runTurn(session.id);

    const info = await orchestrator.getPromptInfo(session);
    expect(info.manifest.entries.find((e) => e.key === 'tools')!.tier).toBe('context');
    expect(info.manifest.staticPrefixChars).toBeLessThan(info.manifest.totalChars);
  });

  it('available + отсутствие git: git-тулы отфильтрованы, toolsDetail reason=dependency', async () => {
    // Доступность берётся из порта исполнения (ADR-077): снимок перечитывается
    // в начале хода, поэтому задаём её портом, а не `setRuntimeDeps`.
    orchestrator = makeOrchestrator({ executionPort: new DepsPort({ git: false, rg: true, sh: true }) });
    orchestrator.setToolsPolicy('available');
    const session = await createSession({ mode: 'act' });
    await runTurn(session.id);

    const names = toolNames();
    expect(names).toContain('read_file');
    expect(names).not.toContain('git_status');
    expect(names).not.toContain('git_diff');
    expect(names).not.toContain('git_commit');

    const after = (await sessionManager.getSession(session.id))!;
    const info = await orchestrator.getPromptInfo(after);
    const git = info.toolsDetail.find((t) => t.name === 'git_status');
    expect(git).toBeDefined();
    expect(git!.available).toBe(false);
    expect(git!.reason).toBe('dependency');

    const read = info.toolsDetail.find((t) => t.name === 'read_file');
    expect(read!.available).toBe(true);
    expect(read!.reason).toBeUndefined();
  });

  it('available + отсутствие rg: grep_files отфильтрован, toolsDetail reason=dependency', async () => {
    orchestrator = makeOrchestrator({ executionPort: new DepsPort({ git: true, rg: false, sh: true }) });
    orchestrator.setToolsPolicy('available');
    const session = await createSession({ mode: 'act' });
    await runTurn(session.id);

    expect(toolNames()).not.toContain('grep_files');

    const after = (await sessionManager.getSession(session.id))!;
    const info = await orchestrator.getPromptInfo(after);
    const grep = info.toolsDetail.find((t) => t.name === 'grep_files');
    expect(grep!.available).toBe(false);
    expect(grep!.reason).toBe('dependency');
  });

  /**
   * ADR-077: снимок доступности — живой. Ложный negative, снятый на старте
   * (раскатка: control plane поднялся раньше исполнителя), не должен залипать
   * до перезапуска процесса — ход перечитывает снимок.
   */
  it('снимок доступности перечитывается ходом: ложный negative старта не залипает', async () => {
    const port = new DepsPort({ git: true, rg: true, sh: false });
    orchestrator = makeOrchestrator({ executionPort: port });
    orchestrator.setToolsPolicy('available');
    // Детерминированный сдвиг TTL кэша детекта: подменяем только Date.
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = new Date('2026-01-01T00:00:00Z');
    vi.setSystemTime(startedAt);
    try {
      const session = await createSession({ mode: 'act' });
      await runTurn(session.id);
      expect(toolNames()).not.toContain('execute_shell');

      // Исполнитель поднялся: проба теперь видит `sh`, TTL детекта истёк.
      port.available.sh = true;
      vi.setSystemTime(new Date(startedAt.getTime() + 61_000));
      await runTurn(session.id);

      expect(toolNames()).toContain('execute_shell');
      // Деталь недоступности снята вместе с ложным negative.
      const after = (await sessionManager.getSession(session.id))!;
      const info = await orchestrator.getPromptInfo(after);
      expect(info.toolsDetail.find((t) => t.name === 'execute_shell')!.available).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
