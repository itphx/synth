/**
 * ADR-090: слой плагинных тулов в манифесте промпта.
 *
 * Плагинные тулы уходят в запрос к модели (слой `plugin` в `selectForSession`),
 * но до фикса не отражались в манифесте: оценка токенов промпта их не видела.
 * Проверяем, что манифест содержит отдельную запись `plugin.tools` (volatile,
 * вне кэшируемого stable-префикса) — сразу после слоя `tools`.
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
import { createToolRegistry } from './tools/index.js';
import { createAgentRegistry } from './agents/index.js';
import type { ContextBuilder } from './context/builder.js';
import type { ToolRegistry } from './tools/registry.js';
import { ToolCapability, type ToolDefinition } from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

/** Плагинный тул (ADR-090): локальное имя, capability `search`. */
function pluginToolDef(localName: string): ToolDefinition {
  return {
    name: localName,
    description: `Plugin tool ${localName}`,
    parameters: z.object({}).passthrough(),
    capabilities: [ToolCapability.SEARCH],
    source: 'plugin',
    execute: async () => ({ content: 'plugin-result' }),
  } as unknown as ToolDefinition;
}

describe('ChatOrchestrator — слой plugin.tools в манифесте (ADR-090)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-plugin-tools-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator(toolRegistry: ToolRegistry): ChatOrchestrator {
    return new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: () => null,
      defaultWorkingDir: tmpDir,
      toolRegistry,
      agentRegistry: createAgentRegistry(toolRegistry),
    });
  }

  async function createSession(): Promise<import('@itphx/synth-shared').Session> {
    return sessionManager.createSession({
      title: 'Plugin tools',
      settings: { provider: 'toolcapture', model: 'm', agentRole: 'developer' },
    });
  }

  it('плагинные тулы дают запись plugin.tools (volatile, chars > 0) сразу после tools', async () => {
    const toolRegistry = createToolRegistry();
    const registration = toolRegistry.registerPlugin(pluginToolDef('memory_search'), 'demo');
    expect(registration.ok).toBe(true);

    const orchestrator = makeOrchestrator(toolRegistry);
    const session = await createSession();

    const info = await orchestrator.getPromptInfo(session);

    const entry = info.manifest.entries.find((e) => e.key === 'plugin.tools');
    expect(entry).toBeDefined();
    expect(entry!.tier).toBe('volatile');
    expect(entry!.status).toBe('loaded');
    expect(entry!.chars).toBeGreaterThan(0);
    expect(entry!.estTokens).toBeGreaterThan(0);
    expect(entry!.source).toBe('plugin.tools');

    // Порядок слоёв: tools → plugin.tools (до MCP-региона).
    const iTools = info.manifest.entries.findIndex((e) => e.key === 'tools');
    const iPluginTools = info.manifest.entries.findIndex((e) => e.key === 'plugin.tools');
    expect(iTools).toBeGreaterThanOrEqual(0);
    expect(iPluginTools).toBe(iTools + 1);

    // Плагинные тулы вне кэшируемого stable-префикса.
    const stableOnly = info.manifest.entries
      .filter((e) => e.tier === 'stable' && e.status !== 'empty')
      .reduce((sum, e) => sum + e.chars, 0);
    expect(info.manifest.staticPrefixChars).toBe(stableOnly);
  });

  it('без плагинных тулов записи plugin.tools нет', async () => {
    const toolRegistry = createToolRegistry();
    const orchestrator = makeOrchestrator(toolRegistry);
    const session = await createSession();

    const info = await orchestrator.getPromptInfo(session);

    expect(info.manifest.entries.find((e) => e.key === 'plugin.tools')).toBeUndefined();
  });
});
