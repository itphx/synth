/**
 * PROP-090 §«Точки расширения» (Ф3в): контрактный suite расширений — прогон на
 * in-memory реализации (ядро: `PluginHost` + общий `ToolRegistry`, реестры
 * `PromptBlockRegistry`/`LlmFilterRegistry`, `SystemPromptComposer`,
 * `GatewayProvider`, `PermissionEvaluator`).
 *
 * Тот же suite обязан проходить и на будущей `out-of-process` реализации
 * (Ф4): харнесс собирает вызывающая сторона, suite работает только через его
 * операции.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ToolCapability,
  pluginsConfigSchema,
  type LLMChunk,
  type LLMGatewayConfig,
  type LLMResponse,
  type PackManifest,
  type PermissionDecision,
  type PermissionRule,
  type PromptManifest,
  type Session,
  type ToolCapability as ToolCapabilityType,
} from '@itphx/synth-shared';

import { MemoryPluginAuditRepository } from '../../storage/memory/plugin-audit.js';
import { PluginHost } from './plugin-host.js';
import type {
  PluginActivationDescriptor,
  PluginActivationResult,
  PluginDeactivationResult,
  PluginFacade,
} from './activation.js';
import { PromptBlockRegistry } from '../context/prompt-block-registry.js';
import { SystemPromptComposer, type ComposerContext } from '../context/composer.js';
import { ContextBuilder } from '../context/builder.js';
import { ContextConfig } from '../context/config.js';
import { AuditLogger, GatewayProvider, LlmFilterRegistry, RateLimiter } from '../gateway/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { PermissionEvaluator } from '../permission/evaluator.js';
import { BaseProvider, type CancellationToken, type LLMMessage } from '../../providers/base.js';
import { describePluginContract, type PluginContractHarness } from './contract/plugin-contract.js';
import {
  PLUGIN_FIXTURE_SET,
  PLUGIN_CONTRACT_FIXTURES,
  type PluginContractFixtureName,
} from './contract/fixtures.js';

/** Мок-провайдер: считает вызовы `chat` (проверка «дошло ли до провайдера»). */
class CountingProvider extends BaseProvider {
  calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<LLMResponse> {
    this.calls += 1;
    return {
      content: 'ответ модели',
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    this.calls += 1;
    yield { content: 'ответ модели', isFinal: true, model: this.model };
  }

  async embed(_text: string): Promise<number[]> {
    return [0.1, 0.2];
  }

  getProviderName(): string {
    return 'counting';
  }
}

/** Сообщение пользователя для вызова gateway. */
function llmMessage(content: string): LLMMessage {
  return {
    id: 'm1',
    role: 'user',
    content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: 'b1',
  };
}

/** Контекст композера (сессия без проекта). */
function composerCtx(maxChars?: number): ComposerContext {
  const session = {
    id: 's1',
    messages: [],
    settings: { language: 'ru', agentRole: 'assistant', showInterview: false },
  } as unknown as Session;
  return {
    session,
    workingDir: '/ws',
    language: 'ru',
    routingEnabled: false,
    gatewayEnabled: false,
    ...(maxChars !== undefined ? { promptBlockMaxChars: maxChars } : {}),
  };
}

/**
 * Харнесс на in-memory реализации ядра.
 *
 * Эталонный набор встроенных тулов минимален (`read_file`): suite проверяет,
 * что плагин **не подменил** builtin.
 */
async function makeHarness(): Promise<PluginContractHarness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'synth-plugin-contract-'));
  const auditDir = await mkdtemp(join(tmpdir(), 'synth-plugin-contract-audit-'));
  await mkdir(join(dataDir, 'roles'), { recursive: true });
  await mkdir(join(dataDir, 'user'), { recursive: true });
  await writeFile(join(dataDir, 'roles', 'ASSISTANT.md'), 'ROLE-MARKER', 'utf-8');

  const warnings: string[] = [];
  const tools = new ToolRegistry();
  tools.register({
    name: 'read_file',
    description: 'встроенное чтение файла',
    parameters: z.object({ file_path: z.string() }),
    capabilities: [ToolCapability.FILE_READ],
    execute: async () => ({ content: 'builtin' }),
  });
  const promptBlocks = new PromptBlockRegistry();
  const llmFilters = new LlmFilterRegistry();
  const provider = new CountingProvider({ url: 'http://mock', apiKey: 'k', model: 'm' });

  /** Загрузчик: имя плагина (`manifest.name`) → фикстура набора. */
  const byPlugin = new Map(
    Object.values(PLUGIN_FIXTURE_SET).map((fixture) => [fixture.name, fixture] as const),
  );
  const loader = async (descriptor: PluginActivationDescriptor) => {
    const fixture = byPlugin.get(descriptor.name);
    if (!fixture) throw new Error(`фикстура «${descriptor.name}» не найдена`);
    return {
      apply: (facade: PluginFacade) => fixture.apply(facade),
    };
  };

  const host = new PluginHost({
    audit: new MemoryPluginAuditRepository(),
    // trust-floor `community`: набор включает недоверенную фикстуру.
    config: { ...pluginsConfigSchema.parse({}), executionEnabled: true, trustFloor: 'community' },
    hostVersion: '0.11.0',
    logger: { warn: (message: string) => warnings.push(message) },
    tools,
    promptBlocks,
    llmFilters,
    loader,
  });

  const composer = new SystemPromptComposer({
    contextBuilder: new ContextBuilder(new ContextConfig({ userDataDir: dataDir })),
    promptBlocks,
  });

  const gatewayConfig: LLMGatewayConfig = {
    enabled: true,
    inputMode: 'obfuscate',
    logPayloads: false,
    payloadLogPath: '',
    rateLimit: { userPerMinute: 100, providerPerMinute: 100 },
    audit: { enabled: true, logPath: '' },
  };
  const gateway = new GatewayProvider(provider, gatewayConfig, {
    getMap: async () => ({}),
    saveMap: async () => undefined,
    getAudit: () => new AuditLogger(join(auditDir, 'gateway-audit.jsonl')),
    getRateLimiter: () => new RateLimiter(100, 100),
    sessionId: 's1',
    userId: 'u1',
    filters: llmFilters,
  });

  /** Дескриптор установки по фикстуре (файлы — тривиальный бандл). */
  function descriptorFor(fixtureName: PluginContractFixtureName): PluginActivationDescriptor {
    const fixture = PLUGIN_FIXTURE_SET[fixtureName];
    return {
      name: fixture.name,
      version: fixture.version,
      manifest: fixture.manifest as PackManifest,
      trustLevel: fixture.trustLevel,
      installKind: 'deploy',
      files: { 'dist/index.js': 'export const ok = 1;' },
    };
  }

  return {
    host,
    tools,
    promptBlocks,
    llmFilters,
    warnings,
    reference: {
      plugin: PLUGIN_FIXTURE_SET.reference.name,
      blockKey: 'plugin.contract.recall',
      emptyBlockKey: 'plugin.contract.empty',
      requestFilterId: 'plugin:contract-plugin:request',
      responseFilterId: 'plugin:contract-plugin:response',
      toolName: 'memory_search',
      fullToolName: 'plugin_contract_plugin_memory_search',
      longContent: 'M'.repeat(600),
    },
    activate: (fixtureName: PluginContractFixtureName): Promise<PluginActivationResult> =>
      host.activate(descriptorFor(fixtureName), { actor: 'test' }),
    deactivate: (plugin?: string): Promise<PluginDeactivationResult> =>
      host.deactivate(plugin ?? PLUGIN_FIXTURE_SET.reference.name, { actor: 'test' }),
    manifest: (opts?: { maxChars?: number }): Promise<PromptManifest> =>
      composer.manifest(composerCtx(opts?.maxChars)),
    composeSystem: (opts?: { maxChars?: number }): Promise<string> =>
      composer.compose(composerCtx(opts?.maxChars)).then((composed) => composed.system),
    runPreRequest: async () => {
      const before = provider.calls;
      await gateway.chat([llmMessage('привет')]);
      return { providerCalls: provider.calls - before };
    },
    checkPermission: (
      toolName: string,
      rules: Record<string, PermissionRule> = {},
    ): PermissionDecision => {
      const tool = tools.get(toolName);
      const evaluator = new PermissionEvaluator({ rules, askTimeoutMs: 30_000 });
      return evaluator.check({
        toolName,
        params: {},
        workingDir: '/ws',
        ...(tool ? { capabilities: tool.capabilities as ToolCapabilityType[] } : {}),
        ...(tool?.source ? { toolSource: tool.source } : {}),
      });
    },
    dispose: async () => {
      await rm(dataDir, { recursive: true, force: true });
      await rm(auditDir, { recursive: true, force: true });
    },
  };
}

describePluginContract('PluginHost + in-memory реестры', makeHarness);

/** Набор фикстур должен быть полным: эталон + по одному нарушению. */
describe('фикстуры контрактного suite расширений', () => {
  it('каждая фикстура — самостоятельный плагин', () => {
    const names = PLUGIN_CONTRACT_FIXTURES.map((name) => PLUGIN_FIXTURE_SET[name].name);
    expect(new Set(names).size).toBe(names.length);
  });
});
