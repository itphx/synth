import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { SynthConfig } from '@itphx/synth-shared';
import { resolveDefaultWorkspace, resolveWorkspacesRoot } from '@itphx/synth-shared';
import {
  FileStore, SessionManager, EventBus,
  ContextConfig, ContextBuilder, ContextOptimizer, ChatOrchestrator,
  createToolRegistry, createAgentRegistry, SecretPatternStore,
} from '../index.js';
import { JsonStore } from '../storage/json-store.js';
import type { ProviderConfig, ModelConfig, SummarizationConfig } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';
import { MessageRole, nowISO, generateId, makeTextPart } from '@itphx/synth-shared';

export interface SingleChatOptions {
  message: string;
  model?: string;
  provider?: string;
  agent?: string;
  dataDir: string;
  config: SynthConfig;
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

  const fileStore = new FileStore({ dataDir });
  const sessionManager = new SessionManager(fileStore);
  const providerStore = new JsonStore<ProviderConfig>({ dataDir, subdir: 'providers' });
  const modelStore = new JsonStore<ModelConfig>({ dataDir, subdir: 'models' });

  const providerCache = new Map<string, ProviderConfig>();
  (await providerStore.list()).forEach((p) => providerCache.set(p.name, p));
  const modelCache = new Map<string, ModelConfig>();
  (await modelStore.list()).forEach((m) => modelCache.set(m.id, m));

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
  const contextConfig = new ContextConfig({ userDataDir: `${dataDir}/context` });
  const contextBuilder = new ContextBuilder(contextConfig, {
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
        };
      }
    }
    return null;
  };

  const toolRegistry = createToolRegistry();
  const agentRegistry = createAgentRegistry(toolRegistry, join(dataDir, 'agents'));

  // AD-036: хранилище кастомных regex-паттернов детекции секретов (override ?? дефолт)
  const patternStore = new SecretPatternStore({ dataDir });

  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder,
    providerLoader,
    contextOptimizer,
    modelPriceLoader,
    dataDir,
    toolRegistry,
    agentRegistry,
    defaultWorkingDir,
    workspacesRoot,
    permissionConfig: options.config.permission,
    defaultPlanMode: options.config.session?.planMode,
    securityConfig: options.config.security,
    gatewayConfig: options.config.llmGateway,
    gatewayPatternStore: patternStore,
  });

  // Создаём временную сессию
  const session = await sessionManager.createSession({
    title: undefined,
    engine: 'synth',
    settings: {
      provider: providerName,
      model: modelName,
      agentRole: options.agent || 'developer',
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
