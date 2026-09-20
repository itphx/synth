/**
 * AD-071 §2.1 (Фаза 1): per-session скоуп MCP-инструментов и разделение слоёв
 * `tools` (встроенные, stable) / `mcp.tools` (MCP, volatile) в манифесте.
 *
 * Проверяем, что две сессии с разными активными наборами MCP-серверов не
 * влияют друг на друга (кросс-сессионная утечка устранена), а исполнение
 * встроенных тулов продолжает работать.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { McpManager } from './mcp/index.js';
import { createToolRegistry } from './tools/index.js';
import { createAgentRegistry } from './agents/index.js';
import {
  generateId,
  MessageRole,
  nowISO,
  makeTextPart,
  ToolCapability,
  type Message,
  type Session,
  type ToolDefinition,
} from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
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

/** Мок McpManager: лениво регистрирует MCP-тулы активных серверов. */
function makeMockMcpManager(): McpManager {
  const tools: Record<string, string[]> = { srvA: ['search'], srvB: ['fetch'] };
  return {
    async ensureToolsLoaded(serverNames: string[], registry: { register(tool: ToolDefinition): void }) {
      for (const server of serverNames) {
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
  } as unknown as McpManager;
}

describe('ChatOrchestrator — per-session MCP scope (AD-071 §2.1)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let orchestrator: ChatOrchestrator;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-mcp-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    ToolCaptureProvider.lastTools = undefined;
    ProviderFactory.register('toolcapture', ToolCaptureProvider);

    const toolRegistry = createToolRegistry();
    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) =>
        ({
          name,
          type: 'toolcapture',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
      toolRegistry,
      agentRegistry: createAgentRegistry(toolRegistry),
      mcpManager: makeMockMcpManager(),
    });
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('toolcapture');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createSession(mcpServers: string[]): Promise<Session> {
    return sessionManager.createSession({
      title: 'MCP scope',
      settings: {
        provider: 'toolcapture',
        model: 'm',
        agentRole: 'developer',
        mcpServers,
      },
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

  it('две сессии с разными наборами не влияют друг на друга', async () => {
    const sessionA = await createSession(['srvA']);
    const sessionB = await createSession(['srvB']);

    await runTurn(sessionA.id);
    expect(toolNames()).toContain('srvA_search');
    expect(toolNames()).not.toContain('srvB_fetch');
    expect(toolNames()).toContain('read_file'); // встроенные всегда

    await runTurn(sessionB.id);
    expect(toolNames()).toContain('srvB_fetch');
    expect(toolNames()).not.toContain('srvA_search');

    // Возврат к A: набор A не «затёрт» сессией B.
    await runTurn(sessionA.id);
    expect(toolNames()).toContain('srvA_search');
    expect(toolNames()).not.toContain('srvB_fetch');
  });

  it('порядок в tools: встроенные раньше MCP', async () => {
    const session = await createSession(['srvA']);
    await runTurn(session.id);

    const names = toolNames();
    const iBuiltin = names.indexOf('read_file');
    const iMcp = names.indexOf('srvA_search');
    expect(iBuiltin).toBeGreaterThanOrEqual(0);
    expect(iMcp).toBeGreaterThan(iBuiltin);
  });

  it('getPromptInfo: манифест содержит tools (stable) и mcp.tools (volatile) сессии', async () => {
    const session = await createSession(['srvA']);
    await runTurn(session.id);

    const info = await orchestrator.getPromptInfo(session);

    const toolsEntry = info.manifest.entries.find((e) => e.key === 'tools');
    const mcpEntry = info.manifest.entries.find((e) => e.key === 'mcp.tools');
    expect(toolsEntry).toBeDefined();
    expect(toolsEntry!.tier).toBe('stable');
    expect(toolsEntry!.source).toBe('tools');

    expect(mcpEntry).toBeDefined();
    expect(mcpEntry!.tier).toBe('volatile');
    expect(mcpEntry!.source).toBe('mcp.tools');
    expect(mcpEntry!.chars).toBeGreaterThan(0);

    // MCP не входит в stable-префикс: staticPrefixChars не больше totalChars.
    expect(info.manifest.staticPrefixChars).toBeLessThan(info.manifest.totalChars);
  });

  it('сессия без активных MCP-серверов не видит MCP-тулы', async () => {
    const session = await createSession([]);
    await runTurn(session.id);
    expect(toolNames()).toContain('read_file');
    expect(toolNames()).not.toContain('srvA_search');
    expect(toolNames()).not.toContain('srvB_fetch');
  });
});
