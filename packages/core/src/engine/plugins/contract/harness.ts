/**
 * PROP-090 §«Точки расширения» / Ф4б-3: сборка харнесса контрактного suite.
 *
 * Suite (`plugin-contract.ts`) работает только через операции
 * `PluginContractHarness` и не знает, откуда берутся хост и реестры. Здесь —
 * **общая** часть для обоих транспортов: реестры (`ToolRegistry`,
 * `PromptBlockRegistry`, `LlmFilterRegistry`), композер, gateway,
 * permission-слой и `PluginHost` с активацией фикстур.
 *
 * Отличие транспортов ровно одно — шаг `import`:
 * - `inline` — загрузчик отдаёт модуль фикстуры (`fixture.apply(facade)`);
 * - `remote` (`out-of-process`) — хост получает `loaders.remote`, а дескриптор
 *   несёт `remote: { url, token }` уже запущенного процесса-заглушки.
 *
 * Реестры, композер, gateway и permission-слой — **те же** в обоих случаях:
 * удалённые вклады проходят через тот же фасад, поэтому проверки suite
 * (namespace, источник `plugin`, `provides`, dispose-дисциплина) означают одно
 * и то же для любой реализации.
 */
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

import { MemoryPluginAuditRepository } from '../../../storage/memory/plugin-audit.js';
import { PluginHost } from '../plugin-host.js';
import type {
  PluginActivationDescriptor,
  PluginActivationResult,
  PluginDeactivationResult,
  PluginLoader,
  PluginModule,
} from '../activation.js';
import { PromptBlockRegistry } from '../../context/prompt-block-registry.js';
import { SystemPromptComposer, type ComposerContext } from '../../context/composer.js';
import { ContextBuilder } from '../../context/builder.js';
import { ContextConfig } from '../../context/config.js';
import { AuditLogger, GatewayProvider, LlmFilterRegistry, RateLimiter } from '../../gateway/index.js';
import { ToolRegistry } from '../../tools/registry.js';
import { PermissionEvaluator } from '../../permission/evaluator.js';
import { BaseProvider, type CancellationToken, type LLMMessage } from '../../../providers/base.js';
import { DEFAULT_PLUGIN_CONTRACT_REFERENCE } from './plugin-contract.js';
import type {
  PluginContractHarness,
  PluginContractTransport,
} from './plugin-contract.js';
import {
  PLUGIN_FIXTURE_SET,
  type PluginContractFixtureName,
  type PluginFixture,
} from './fixtures.js';

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

/** Параметры сборки харнесса. */
export interface PluginContractHarnessOptions {
  /** Транспорт исполнения (влияет только на шаг `import`). */
  transport: PluginContractTransport;
  /** Загрузчик `inline` (для `transport: 'inline'`). */
  loader?: PluginLoader;
  /** Каналы загрузчиков (`loaders.remote` для `transport: 'remote'`). */
  loaders?: { inline?: PluginLoader; remote?: PluginLoader };
  /**
   * Дополнительные поля дескриптора активации (для `remote` — адрес и токен
   * процесса). Может быть асинхронной: тест поднимает сервер лениво, по
   * фикстуре.
   */
  descriptorExtra?: (
    fixture: PluginContractFixtureName,
  ) => Partial<PluginActivationDescriptor> | Promise<Partial<PluginActivationDescriptor>>;
  /** Освободить ресурсы транспорта (процессы/серверы) при `dispose()`. */
  cleanup?: () => Promise<void>;
}

/** Загрузчик фикстур (in-memory): имя плагина → модуль фикстуры. */
export function createFixtureLoader(): PluginLoader {
  const byPlugin = new Map<string, PluginFixture>(
    Object.values(PLUGIN_FIXTURE_SET).map((fixture) => [fixture.name, fixture] as const),
  );
  return async (descriptor: PluginActivationDescriptor): Promise<PluginModule> => {
    const fixture = byPlugin.get(descriptor.name);
    if (!fixture) throw new Error(`фикстура «${descriptor.name}» не найдена`);
    return {
      apply: (facade) => fixture.apply(facade),
    };
  };
}

/**
 * Собрать харнесс контрактного suite.
 *
 * Эталонный набор встроенных тулов минимален (`read_file`): suite проверяет,
 * что плагин **не подменил** builtin.
 */
export async function createContractHarness(
  options: PluginContractHarnessOptions,
): Promise<PluginContractHarness> {
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

  const host = new PluginHost({
    audit: new MemoryPluginAuditRepository(),
    // trust-floor `community`: набор включает недоверенную фикстуру.
    config: { ...pluginsConfigSchema.parse({}), executionEnabled: true, trustFloor: 'community' },
    hostVersion: '0.11.0',
    logger: { warn: (message: string) => warnings.push(message) },
    tools,
    promptBlocks,
    llmFilters,
    ...(options.loader ? { loader: options.loader } : {}),
    ...(options.loaders ? { loaders: options.loaders } : {}),
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
  async function descriptorFor(
    fixtureName: PluginContractFixtureName,
  ): Promise<PluginActivationDescriptor> {
    const fixture = PLUGIN_FIXTURE_SET[fixtureName];
    const extra = options.descriptorExtra ? await options.descriptorExtra(fixtureName) : {};
    return {
      name: fixture.name,
      version: fixture.version,
      manifest: fixture.manifest as PackManifest,
      trustLevel: fixture.trustLevel,
      installKind: 'deploy',
      files: { 'dist/index.js': 'export const ok = 1;' },
      ...extra,
    };
  }

  return {
    transport: options.transport,
    host,
    tools,
    promptBlocks,
    llmFilters,
    warnings,
    reference: DEFAULT_PLUGIN_CONTRACT_REFERENCE,
    activate: async (fixtureName: PluginContractFixtureName): Promise<PluginActivationResult> =>
      host.activate(await descriptorFor(fixtureName), { actor: 'test' }),
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
      await options.cleanup?.();
      await rm(dataDir, { recursive: true, force: true });
      await rm(auditDir, { recursive: true, force: true });
    },
  };
}
