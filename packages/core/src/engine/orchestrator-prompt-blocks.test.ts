/**
 * ADR-090: оркестратор прокидывает **общий** реестр
 * блоков промпта в `SystemPromptComposer` (`OrchestratorOptions.promptBlocks`).
 *
 * Инвариант, который здесь зафиксирован: реестр у композера — тот же экземпляр,
 * в который регистрирует вклады фасад плагинов (`PluginRuntime`/`PluginHost`).
 * Иначе плагинный блок не попадал бы в промпт сессии (композер создавал бы
 * второй, пустой реестр).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PromptBlockProvider, Session } from '@itphx/synth-shared';

import { PromptBlockRegistry } from './context/prompt-block-registry.js';
import type { ComposerContext, ComposerSessionLike } from './context/composer.js';
import type { ContextBuilder } from './context/builder.js';
import { ChatOrchestrator } from './orchestrator.js';
import { createToolRegistry } from './tools/index.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { stubContextFiles } from '../test-helpers/storage-stubs.js';

/** Минимальный контекст-билдер: базовый stable-блок роли. */
function makeCtxBuilder(): ContextBuilder {
  return {
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'ROLE' },
    ],
  } as unknown as ContextBuilder;
}

function makeSession(): Session {
  return {
    id: 's1',
    mode: 'act',
    messages: [],
    settings: { language: 'ru', agentRole: 'assistant' },
  } as unknown as Session;
}

/** Провайдер блока — как у плагина (`plugin.<name>.<slot>`, тир `context`). */
function pluginProvider(content = 'PLUGIN-TIP'): PromptBlockProvider {
  return {
    key: 'plugin.demo.tip',
    tier: 'context',
    order: 10,
    load: () => content,
  };
}

function makeComposeCtx(session: ComposerSessionLike): ComposerContext {
  return {
    session,
    workingDir: '/tmp/workspace',
    language: 'ru',
    routingEnabled: false,
    gatewayEnabled: false,
  };
}

describe('ChatOrchestrator: общий реестр блоков промпта (promptBlocks)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-prompt-blocks-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator(
    promptBlocks?: PromptBlockRegistry,
    extra: { promptBlockMaxChars?: number } = {},
  ): ChatOrchestrator {
    return new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: () => null,
      contextConfig: stubContextFiles(),
      defaultWorkingDir: tmpDir,
      toolRegistry: createToolRegistry(),
      ...(promptBlocks ? { promptBlocks } : {}),
      ...extra,
    });
  }

  it('переданный реестр — тот же экземпляр у композера (второй не создаётся)', () => {
    const registry = new PromptBlockRegistry();
    const orchestrator = makeOrchestrator(registry);

    expect(orchestrator.getComposer().promptBlocks).toBe(registry);
  });

  it('провайдер, зарегистрированный в реестре, попадает в системный промпт', async () => {
    const registry = new PromptBlockRegistry();
    registry.register(pluginProvider(), { provenance: 'plugin:demo' });
    const orchestrator = makeOrchestrator(registry);

    const composed = await orchestrator.getComposer().compose(makeComposeCtx(makeSession()));

    expect(composed.system).toContain('PLUGIN-TIP');
    expect(composed.blocks.some((block) => block.key === 'plugin.demo.tip')).toBe(true);
    expect(
      composed.blocks.find((block) => block.key === 'plugin.demo.tip')?.provenance,
    ).toBe('plugin:demo');
  });

  it('бюджет блока из опций доходит до композера, setPromptBlockMaxChars меняет его на лету', async () => {
    const registry = new PromptBlockRegistry();
    const long = 'M'.repeat(600);
    registry.register(pluginProvider(long));
    const orchestrator = makeOrchestrator(registry, { promptBlockMaxChars: 120 });

    const entry = async () => {
      const info = await orchestrator.getPromptInfo(makeSession());
      return info.manifest.entries.find((item) => item.key === 'plugin.demo.tip');
    };

    // Конфиг `plugins.promptBlockMaxChars` реально доходит до композера: блок
    // обрезан по бюджету (а не по дефолту 4 000).
    const tight = await entry();
    expect(tight).toBeDefined();
    expect(tight!.status).toBe('truncated');
    expect(tight!.chars).toBeLessThan(600);

    // Живое изменение бюджета (runtime-настройка) — без пересборки оркестратора.
    orchestrator.setPromptBlockMaxChars(4000);
    const wide = await entry();
    expect(wide!.chars).toBe(600);
  });

  it('без опции promptBlocks блоки плагинов в промпт не попадают (прежнее поведение)', async () => {
    const registry = new PromptBlockRegistry();
    registry.register(pluginProvider());
    // Оркестратор собран без реестра — композер работает со своим пустым.
    const orchestrator = makeOrchestrator();

    const composed = await orchestrator.getComposer().compose(makeComposeCtx(makeSession()));

    expect(composed.system).not.toContain('PLUGIN-TIP');
    expect(composed.blocks.some((block) => block.key === 'plugin.demo.tip')).toBe(false);
    expect(orchestrator.getComposer().promptBlocks).not.toBe(registry);
  });
});
