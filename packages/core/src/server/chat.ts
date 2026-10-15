import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { SynthConfig, InstructionsConfig } from '@itphx/synth-shared';
import { resolveDefaultWorkspace, resolveWorkspacesRoot, resolveStorageBackend } from '@itphx/synth-shared';
import {
  SessionManager, EventBus,
  ContextBuilder, ContextOptimizer, ChatOrchestrator,
  createToolRegistry, createAgentRegistry,
  detectRuntimeDeps,
  createStorageContext,
} from '../index.js';
import type { ProviderConfig, ModelConfig, SummarizationConfig } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';
import { MessageRole, nowISO, generateId, makeTextPart } from '@itphx/synth-shared';
import { mergeSecurityConfig } from '../storage/runtime-settings.js';
import { DEFAULT_AGENT_ID } from '../engine/agents/index.js';
import { SkillService } from '../engine/skills/service.js';
import { CommandService, isLocalCommandStatus } from '../engine/commands/service.js';

export interface SingleChatOptions {
  message: string;
  model?: string;
  provider?: string;
  agent?: string;
  dataDir: string;
  config: SynthConfig;
  /** ADR-069 §9.2: override проектных инструкций (CLI `--ignore-rules`/`--safe-mode`). */
  instructionsConfig?: InstructionsConfig;
}

export async function runSingleChat(options: SingleChatOptions): Promise<void> {
  const dataDir = options.dataDir;

  const defaultWorkingDir = resolveDefaultWorkspace(options.config, {
    ...process.env,
    SYNTH_DATA_DIR: options.dataDir,
  });
  await mkdir(defaultWorkingDir, { recursive: true });

  const workspacesRoot = resolveWorkspacesRoot(options.config, {
    ...process.env,
    SYNTH_DATA_DIR: options.dataDir,
  });

  // PROP-032 (W2.4): единый контекст хранения (дефолт `file`, поведение прежнее).
  const storage = createStorageContext(resolveStorageBackend(options.config, process.env), {
    dataDir,
    env: process.env,
    bundlesPath: options.config.commands?.bundlesPath,
  });
  const sessionManager = new SessionManager(storage.sessions);
  const providerStore = storage.providers;
  const modelStore = storage.models;
  const providerCache = new Map<string, ProviderConfig>();
  (await providerStore.list()).forEach((p) => providerCache.set(p.name, p));
  const modelCache = new Map<string, ModelConfig>();
  (await modelStore.list()).forEach((m) => modelCache.set(m.id, m));

  // ADR-046: сервис скиллов + slash-команд (резолвинг в core до LLM).
  const skillService = new SkillService({
    dataDir,
    configPaths: options.config.skills?.paths,
    urls: options.config.skills?.urls,
    trustedProjectDirs: options.config.skills?.trustedProjectDirs,
    toolsets: options.config.skills?.toolsets,
  });
  const bundleStore = storage.skillBundles;
  const commandService = new CommandService({
    config: {
      dataDir,
      commandsPaths: options.config.commands?.paths ?? [],
      bundlesPath: options.config.commands?.bundlesPath ?? 'skill-bundles',
      conflict: options.config.commands?.conflict ?? { mode: 'bundle-wins', namespacePrefix: false },
      maxArgumentsLength: options.config.commands?.maxArgumentsLength ?? 10_000,
      maxRenderedBytes: options.config.commands?.maxRenderedBytes ?? 200_000,
      toolsets: options.config.skills?.toolsets ?? {},
      trustedProjectDirs: options.config.skills?.trustedProjectDirs,
      inlineShell: options.config.skills?.inlineShell ?? false,
    },
    skillRuntime: skillService,
    skillSource: skillService,
    bundleStore,
  });

  // ADR-046 §9.4: локальные `/`-команды (help/skills/commands/summary) не
  // поднимают LLM и не требуют настроенного провайдера. `/summary` НЕ
  // короткозамыкается здесь: оркестратор запускает реальную суммаризацию
  // (как в SSE-пути), поэтому управление уходит в обычный поток.
  const trimmedMessage = options.message.trimStart();
  if (trimmedMessage.startsWith('/')) {
    const resolved = await commandService.resolve(trimmedMessage, {
      projectWorkspace: defaultWorkingDir,
      permissionConfig: options.config.permission,
    });
    const localOnly = resolved && isLocalCommandStatus(resolved.status);
    if (localOnly && resolved) {
      console.log(resolved.output ?? '');
      return;
    }
  }

  const providerName = options.provider || options.config.llm.defaultProvider;
  const modelName = options.model || options.config.llm.defaultModel;

  if (!providerName || !modelName) {
    console.error('Ошибка: не указан провайдер и/или модель.');
    console.error('Укажите через --provider и --model или настройте конфигурацию.');
    process.exit(1);
  }

  const providerConfig = providerCache.get(providerName);
  if (!providerConfig) {
    console.error(`Ошибка: провайдер "${providerName}" не найден.`);
    console.error('Настройте провайдера через: synth config provider add');
    process.exit(1);
  }

  const eventBus = new EventBus();
  const contextConfig = storage.contextFiles;
  const profilesStore = storage.profiles;
  const contextBuilder = new ContextBuilder(contextConfig, {
    profilesStore,
    projectDataDir: `${dataDir}/projects`,
    defaultLanguage: 'ru',
  });

  const providerLoader = (name: string): ProviderConfig | null => providerCache.get(name) ?? null;

  // Загрузчик сохранённого контекстного окна модели (ModelConfig.contextWindow)
  const modelWindowLoader = (modelName: string): number => {
    for (const m of modelCache.values()) {
      if (m.name === modelName || m.id === modelName) {
        return m.contextWindow && m.contextWindow > 0 ? m.contextWindow : 0;
      }
    }
    return 0;
  };

  const summarizationConfig: SummarizationConfig = {
    provider: providerName,
    model: modelName,
    temperature: 0.3,
    promptFile: 'SUMMARIZER',
  };
  const contextOptimizer = new ContextOptimizer(contextConfig, providerLoader, summarizationConfig, modelWindowLoader);

  const modelPriceLoader = (mn: string) => {
    for (const m of modelCache.values()) {
      if (m.name === mn || m.id === mn) {
        return {
          inputPrice: m.inputPrice,
          outputPrice: m.outputPrice,
          cacheReadPrice: m.cacheReadPrice,
          cacheWritePrice: m.cacheWritePrice,
          // Валюта: модель → провайдер → USD (обратная совместимость).
          currency: m.currency ?? providerCache.get(m.provider)?.currency ?? 'USD',
        };
      }
    }
    return null;
  };

  const toolRegistry = createToolRegistry();
  const agentRegistry = createAgentRegistry(toolRegistry, join(dataDir, 'agents'));

  // ADR-036: хранилище кастомных regex-паттернов детекции секретов (override ?? дефолт)
  const patternStore = storage.secretPatterns;

  // Защищённые пути: runtime-настройка protectedPaths.enabled приоритетнее config.yaml.
  // RuntimeSettingsStore читает {dataDir}/settings.json — если файла нет, возвращает {}.
  const settingsStore = storage.settings;
  const runtimeSecurity = await settingsStore.getSecuritySettings();
  const effectiveSecurityConfig = mergeSecurityConfig(options.config.security, runtimeSecurity);

  // ADR-046: сервис скиллов + slash-команд (резолвинг в core до LLM).
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder,
    contextConfig,
    profilesStore,
    providerLoader,
    contextOptimizer,
    modelPriceLoader,
    dataDir,
    toolRegistry,
    agentRegistry,
    // PROP-032 (W2.4): порты хранилищ (SSH-ключи, словари) — из контекста, без фоллбэков.
    sshKeyStore: storage.sshKeys,
    dictionaryStore: storage.dictionaries,
    defaultWorkingDir,
    workspacesRoot,
    permissionConfig: options.config.permission,
    defaultPlanMode: options.config.session?.planMode,
    securityConfig: effectiveSecurityConfig,
    gatewayConfig: options.config.llmGateway,
    gatewayPatternStore: patternStore,
    // ADR-084: decision-слой микро-каскада (config.decision).
    decisionConfig: options.config.decision,
    skillRuntime: skillService,
    commandRuntime: commandService,
    // ADR-069 Фаза 1: проектные инструкции (merged chain AGENTS.md).
    instructionsConfig: options.instructionsConfig ?? options.config.instructions,
    // ADR-069 Фаза 2a: project-trust гейт инструкций (config.skills.trustedProjectDirs).
    instructionsTrustedProjectDirs: options.config.skills?.trustedProjectDirs,
    // ADR-070 §2.9.1: зависимости окружения (git/rg/sh) — детекция при старте.
    runtimeDeps: await detectRuntimeDeps(),
  });

  // ADR-089: CLI-чат поднимает менеджер сам, вне `createStandaloneApp`, поэтому
  // funnel `RequestSessionService` в области видимости недоступен. Это временная
  // сессия одного сообщения (удаляется в finally) — materialization, не request.
  const session = await sessionManager.createSession({
    title: undefined,
    settings: {
      provider: providerName,
      model: modelName,
      // Эффективный дефолт: runtime-настройка («Агенты») ?? DEFAULT_AGENT_ID.
      agentRole: options.agent || ((await settingsStore.getDefaultAgent()) ?? DEFAULT_AGENT_ID),
    },
  });
  session.userId = 'local';
  session.ownerId = 'local';
  await sessionManager.updateSession(session);

  const message: Message = {
    id: generateId(),
    role: MessageRole.USER,
    seq: session.messages.length + 1,
    origin: 'local',
    parts: [makeTextPart(options.message)],
    content: options.message,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    source: 'cli',
    metadata: { stream_id: generateId() },
  };

  session.messages.push(message);
  await sessionManager.updateSession(session);

  const processMessage = orchestrator.createProcessMessage();
  const abortController = new AbortController();

  try {
    const result = await processMessage(
      session,
      message,
      abortController.signal,
      (event: string, data: Record<string, unknown>) => {
        if (event === 'stream.chunk' && data.content) {
          process.stdout.write(String(data.content));
        }
      },
    );

    if (result.error) {
      console.error('\nОшибка:', result.error);
      process.exit(1);
    }
  } catch (err) {
    console.error('\nОшибка:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    // Удаляем временную сессию
    await sessionManager.deleteSession(session.id).catch(() => {});
  }

  console.log(); // завершающий перевод строки
}
