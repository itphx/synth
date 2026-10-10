import { createServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Readable } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, extname, isAbsolute, normalize, resolve } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { ProviderConfig, ModelConfig, AgentDefinition, Message, PermissionConfig, PlanMode, McpServerConfig, SecurityConfig, LLMGatewayConfig, ToolsPolicy, ToolsDisabledConfig, McpNetworkPolicy, SkillsConfig, CommandsConfig, InstructionsConfig, WorkspaceOutsideRootPolicy, SynthConfig } from '@itphx/synth-shared';
import {
  FileStore, SessionManager, EventBus, QueueProcessorManager,
  ContextConfig, ContextBuilder, ContextOptimizer, ChatOrchestrator,
  enqueueUserMessage, createToolRegistry, createAgentRegistry, McpManager,
  SecretPatternStore, ProtectedPathsStore, DictionaryStore, DEFAULT_AGENT_ID,
  detectRuntimeDeps, HookBus, startEphemeralSweeper,
  EventBindingStore, EventApiKeyStore, EventJournalStore, EventRouter, RequestSessionService, EventIngress, eventToMessage,
  RouteRuleStore, ProjectRuleProvider,
  ScheduleStore, SchedulerRuleProvider, SchedulerService, JobStore,
  MemoryDedupStore, FileDedupStore, AlwaysLeader, FileLeader,
  createEventRoutes, createSchedulerRoutes,
  startEventJournalPruner,
} from '../index.js';
import type { SummarizationConfig } from '@itphx/synth-shared';
import { nowISO, ensureDataDir, MessageRole, generateStreamId, makeTextPart, DEFAULT_LLM_GATEWAY_RATE_LIMIT } from '@itphx/synth-shared';
import { createLocalAuth } from '../auth/local.js';
import { ensureProfile, listProfiles, getLastProfile } from '../profiles.js';
import { RemoteConnection } from '../remote/connection.js';
import type { RemoteUser } from '../remote/types.js';
import { RemoteError } from '../remote/types.js';
import { loadCredentials, clearCredentials } from '../remote/credentials.js';
import { revokeRefreshToken } from '../remote/device-flow.js';
import { RemoteEventBridge } from '../remote/event-bridge.js';
import { isRemoteRef, toLocalId } from '../remote/aggregate.js';
import { ConnectionWatcher } from './connection-watcher.js';
import { setRemoteTokenProvider, removeRemoteTokenProvider } from '../providers/remote.js';
import { JsonStore } from '../storage/json-store.js';
import { syncProvidersFromEnv } from '../providers/sync-from-env.js';
import { FileProfileStore } from '../storage/profile-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { SSHKeyStore } from '../storage/ssh-key-store.js';
import { RuntimeSettingsStore, mergeLlmGatewayConfig, mergeSecurityConfig, mergeMcpNetworkPolicy, mergeEventsConfig } from '../storage/runtime-settings.js';
import { migrateSessionScopeSnapshots } from '../storage/migrations.js';
import { createHealthRoutes } from './routes/health.js';
import { createHybridRoutes } from './routes/hybrid.js';
import { createAuthRoutes } from './routes/auth.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createProjectRoutes } from './routes/projects.js';
import { createProjectTransferRoutes } from './routes/project-transfer.js';
import { createProviderRoutes } from './routes/providers.js';
import { createModelRoutes } from './routes/models.js';
import { createAgentRoutes } from './routes/agents.js';
import { createFsRoutes } from './routes/fs.js';
import { resolveProjectWorkspace } from './fs-workspace.js';
import { createGitRoutes } from './routes/git.js';
import { createSshKeyRoutes, createAgentSshKeyRoutes } from './routes/ssh-keys.js';
import { createQueueRoutes } from './routes/queue.js';
import { createUpdateRoutes } from './routes/updates.js';
import { createMessageRoutes } from './routes/messages.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createDictionaryRoutes } from './routes/dictionaries.js';
import { createMcpRoutes } from './routes/mcp.js';
import { createSkillRoutes } from './routes/skills.js';
import { createContextRoutes } from './routes/context.js';
import { ProjectInstructionsResolver, createInstructionsInfoResolver } from '../engine/context/instructions.js';
import { SkillService } from '../engine/skills/service.js';
import { resolveProjectSkillSeed } from '../engine/skills/seed.js';
import { createCommandRoutes } from './routes/commands.js';
import { createSkillBundleRoutes } from './routes/skill-bundles.js';
import { createSessionSkillScopeRoutes, createProjectSkillScopeRoutes, createSkillSettingsRoutes } from './routes/skill-scope.js';
import { CommandService } from '../engine/commands/service.js';
import { SkillBundleStore } from '../storage/skill-bundle-store.js';
import { createRemoteProxyMiddleware } from './proxy.js';

export interface StandaloneConfig {
  port: number;
  dataDir: string;
  apiKey: string;
  workspacesRoot?: string;
  /** Рабочий каталог по умолчанию для сессий без проекта. Дефолт: {dataDir}/workspaces/default. */
  defaultWorkingDir?: string;
  uiDistPath?: string;
  systemPromptsDir?: string;
  /** Глобальная секция permission из config.yaml (AD-029). */
  permissionConfig?: PermissionConfig;
  /** Строгость цикла Plan→Build по умолчанию из config.yaml (AD-028). */
  defaultPlanMode?: PlanMode;
  /** Секция безопасности (защита от Indirect Prompt Injection) из config.yaml. */
  securityConfig?: SecurityConfig;
  /**
   * AD-076: мастер-ключ шифрования секретов at-rest (SSH-ключи). Задан —
   * приоритетнее env/файла; иначе `SSHKeyStore` использует `SYNTH_SECRET_KEY`
   * или файл `{dataDir}/secrets/master.key`.
   */
  secretKey?: string;
  /** LLM Gateway (AD-036) из config.yaml — глобальный тумблер и конфиг. */
  gatewayConfig?: LLMGatewayConfig;
  /** AD-070 §2.2: политика prompt-cache из config.yaml llm.cache (auto | none). */
  llmCachePolicy?: 'auto' | 'none';
  /** AD-071 §2.3: глобальная политика включения встроенных инструментов из config.yaml tools.policy. */
  toolsPolicy?: ToolsPolicy;
  /** AD-071 §2.3: глобальная политика включения MCP-инструментов из config.yaml mcp.policy. */
  mcpPolicy?: ToolsPolicy;
  /** AD-071 §2.6: instance-wide отключение инструментов из config.yaml tools.disabled. */
  toolsDisabled?: ToolsDisabledConfig;
  /**
   * AD-075: политика для абсолютного workspace вне `workspacesRoot` из
   * config.yaml/env (`confirm` | `deny`). Runtime-override — settings/workspace-policy.
   */
  workspaceOutsideRootPolicy?: WorkspaceOutsideRootPolicy;
  /** Конфигурация MCP-серверов из config.yaml mcp.servers (для probe и загрузки тулов). */
  mcpServers?: Record<string, McpServerConfig>;
  /** AD-071 §2.3.1: политика сетевого доступа HTTP MCP из config.yaml mcp.networkPolicy. */
  mcpNetworkPolicy?: McpNetworkPolicy;
  /** AD-046: конфигурация скиллов из config.yaml `skills` (paths/trustedProjectDirs/inlineShell). */
  skillsConfig?: SkillsConfig;
  /** AD-046 §7: конфигурация slash-команд из config.yaml `commands`. */
  commandsConfig?: CommandsConfig;
  /** AD-069 Фаза 1: конфигурация проектных инструкций из config.yaml `instructions`. */
  instructionsConfig?: InstructionsConfig;
  /** AD-089: конфигурация приёма внешних событий из config.yaml `events`. */
  eventsConfig?: SynthConfig['events'];
  /** AD-051 (срез) / AD-089: конфигурация планировщика из config.yaml `scheduler`. */
  schedulerConfig?: SynthConfig['scheduler'];
  /**
   * Дефолтный адрес удалённого backend (гибрид, `serve --connect`/env/конфиг).
   * Нужен для авто-логина (GET /auth/status) и POST /auth/login без поля server.
   * Сам сервер при этом стартует «холодным»: подключение происходит в рантайме.
   */
  defaultBackendUrl?: string;
  /** API-ключ к удалённому backend (`serve --token`) — машинное подключение при старте. */
  defaultToken?: string;
  /**
   * Параметры remote-аутентификации (гибрид): нужны RemoteConnection как
   * fallback OIDC issuer/client_id (дискавери с сервера имеет приоритет) и
   * путь к credentials. backendUrl больше НЕ передаётся — адрес сервера в
   * defaultBackendUrl.
   */
  remoteAuth?: {
    issuer?: string;
    clientId?: string;
    credentialsPath?: string;
  };
  /** Куда идут LLM-запросы локальных сессий: server (централизация) | local | auto. */
  remoteLlm?: 'server' | 'local' | 'auto';
  /** Таймаут запросов к удалённому backend (мс). */
  remoteTimeoutMs?: number;
  /** Путь к файлу credentials (~/.config/synth/credentials.json по умолчанию). */
  remoteCredentialsPath?: string;
  /**
   * AD-079: путь к реестру профилей серверов (`<home>/profiles.json` либо XDG).
   * Если не задан — `getProfilesPath()` (XDG-дефолт).
   */
  profilesPath?: string;
  /**
   * Гибридный режим включён (remote.enabled в config.yaml либо задан OIDC
   * fallback --oidc-issuer/--oidc-client-id), даже если адрес сервера ещё не
   * известен (вводится в UI). Позволяет /auth/status отдать oidc_enabled=true и
   * /hybrid/status — enabled=true, чтобы LoginForm показал поле «Адрес сервера».
   */
  hybridEnabled?: boolean;
}

/**
 * @deprecated Гибрид переведён на runtime-подключение через RemoteConnection
 * (поле defaultBackendUrl + методы connect* на возвращаемом app-хэндле).
 * Статические remoteClient/remoteProvider/remoteGetToken/remoteEventBridge/
 * remoteBlockLocalProviders удалены — при необходимости подключите приложение
 * через connectRemoteWithApiKey/connectRemoteFromSaved.
 */

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(uiDistPath: string) {
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const fullPath = join(uiDistPath, filePath);

    if (!existsSync(fullPath) || !fullPath.startsWith(uiDistPath)) {
      filePath = '/index.html';
      const fallbackPath = join(uiDistPath, '/index.html');
      if (!existsSync(fallbackPath)) return null;
      const content = readFileSync(fallbackPath);
      const ext = '.html';
      return new Response(content, {
        status: 200,
        headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
      });
    }

    try {
      const content = readFileSync(fullPath);
      const ext = extname(fullPath).toLowerCase();
      return new Response(content, {
        status: 200,
        headers: {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control':
            ext === '.html' || ext === '.webmanifest' || url.pathname === '/sw.js'
              ? 'no-cache'
              : 'public, max-age=3600',
        },
      });
    } catch {
      return null;
    }
  };
}

/** Описание одного remote-зеркала серверного провайдера для инъекции в кэши. */
export interface RemoteProviderSpec {
  /** Конфиг провайдера: { name: 'itphx', type: 'remote', baseUrl: backendUrl, apiKey: '', enabled: true }. */
  provider: ProviderConfig;
  /** Модели, которые сервер отдаёт для этого провайдера (смерживаются в models-роут). */
  models?: ModelConfig[];
  /** Поставщик токена (обычно RemoteConnection.getToken) — автообновление в рантайме. */
  getToken?: () => Promise<string | null>;
}

/**
 * Инъекция одного remote-зеркала в кэши (гибрид: зеркалирование серверных
 * провайдеров). Добавляет провайдера в providerCache и его модели в modelCache —
 * только in-memory, в JsonStore не пишется. Регистрирует поставщика токена для
 * RemoteProvider, создаваемых через ProviderFactory. Возвращает имя
 * remote-провайдера (для политики blockLocalProviders) или undefined.
 */
export function injectRemoteProvider(
  providerCache: Map<string, ProviderConfig>,
  modelCache: Map<string, ModelConfig>,
  remoteProvider?: RemoteProviderSpec,
): string | undefined {
  if (!remoteProvider) return undefined;

  const rp = remoteProvider.provider;
  providerCache.set(rp.name, { ...rp, enabled: rp.enabled ?? true });
  if (remoteProvider.getToken) {
    setRemoteTokenProvider(rp.name, remoteProvider.getToken);
  }
  for (const m of remoteProvider.models ?? []) {
    modelCache.set(m.id, m);
  }
  return rp.name;
}

export async function createStandaloneApp(config: StandaloneConfig) {
  const app = new Hono();
  const auth = createLocalAuth({ apiKey: config.apiKey });

  app.use(logger());
  app.use(cors({
    origin: (_origin) => _origin || '*',
    credentials: true,
  }));

  // Runtime-подключение к удалённому backend (гибрид). Connection создаётся
  // всегда: без defaultBackendUrl/credentials он остаётся disconnected, а
  // пользователь логинится в UI (POST /auth/login) в рантайме.
  const connection = new RemoteConnection({
    credentialsPath: config.remoteCredentialsPath ?? config.remoteAuth?.credentialsPath,
    timeoutMs: config.remoteTimeoutMs,
    defaultIssuer: config.remoteAuth?.issuer,
    defaultClientId: config.remoteAuth?.clientId,
  });

  // Текущее активное remote-состояние: зеркала провайдеров/модели/мост задаются
  // в applyConnected() (после успешного connect*) и сбрасываются в disconnectRemote().
  // Зеркал несколько — по одному на каждого включённого серверного провайдера.
  let activeRemoteProviderNames: Set<string> = new Set();
  let activeRemoteModels: ModelConfig[] = [];
  let activeBridge: RemoteEventBridge | undefined;
  /** Политика «все LLM — через сервер»: активна только при подключении И remoteLlm !== 'local'. */
  let blockLocalProviders = false;
  // Снапшоты локальных записей providerCache/modelCache, перекрытых зеркалами, —
  // для восстановления в disconnectRemote (иначе локальные провайдеры/модели с теми
  // же именами, что и серверные, исчезли бы из in-memory кэшей до рестарта).
  const providerMirrorSnapshot = new Map<string, ProviderConfig | null>();
  const modelMirrorSnapshot = new Map<string, ModelConfig | null>();

  // ── Фактическая живость подключения ──
  // connection.connected означает лишь «есть runtime-сессия», но не доступность
  // backend (после падения/перезапуска сервера сессия в памяти остаётся «живой»).
  // hybridLiveness обновляет ConnectionWatcher (health+auth каждые 15 с), а
  // connect*/disconnect выставляют его синхронно. /hybrid/status.connected =
  // connection.connected && hybridLiveness — реальная доступность сервера.
  let hybridLiveness = false;
  let connectionWatcher: ConnectionWatcher | null = null;

  // ── Состояние гибрида (для hybrid/status, без auth) ──
  async function getHybridState() {
    const serverConfigured = !!config.defaultBackendUrl;
    // Реестр профилей серверов (для формы входа UI): известные серверы и последний
    // использованный. AD-079: путь задаётся createStandaloneApp (`<home>/profiles.json`);
    // при отсутствии файла — пустой список/null.
    const [knownProfiles, lastProfile] = await Promise.all([
      listProfiles(config.profilesPath),
      getLastProfile(config.profilesPath),
    ]);
    return {
      // Гибрид «включён», когда настроен в конфиге (remote.enabled/--connect/
      // --oidc-issuer), известен адрес сервера или есть runtime-подключение.
      // Случай «включён, но адрес не задан» — это тоже гибрид: адрес вводит
      // пользователь в UI (LoginForm показывает поле «Адрес сервера»).
      enabled: config.hybridEnabled || serverConfigured || connection.connected,
      // connected отражает РЕАЛЬНУЮ доступность backend: сессия есть (connection)
      // И сервер подтверждён живым watcher'ом (hybridLiveness). После
      // connectRemote* applyConnected сразу ставит hybridLiveness=true — UI видит
      // connected немедленно; последующие тики watcher'а лишь подтверждают/снимают.
      connected: connection.connected && hybridLiveness,
      backendUrl: connection.backendUrl,
      user: connection.user,
      serverConfigured,
      // Вход на сервер возможен: адрес известен (--connect/env/конфиг), есть
      // OIDC issuer (--oidc-issuer/--oidc-client-id как fallback дискавери)
      // или уже есть runtime-подключение.
      serverLoginAvailable: serverConfigured || !!config.remoteAuth?.issuer || connection.connected,
      // Известные серверы (реестр профилей) и последний использованный — для
      // мульти-серверной формы входа (datalist + предзаполнение).
      knownServers: knownProfiles.map((p) => p.url),
      lastServer: lastProfile?.url ?? null,
    };
  }

  /**
   * Откат зеркал: восстановить перекрытые локальные записи из снапшотов и
   * дерегистрировать токены. Вызывается перед новым подключением (reconnect)
   * и в disconnectRemote.
   */
  function restoreRemoteMirrors(): void {
    for (const name of activeRemoteProviderNames) {
      removeRemoteTokenProvider(name);
    }
    for (const [name, prev] of providerMirrorSnapshot) {
      if (prev) providerCache.set(name, prev);
      else providerCache.delete(name);
    }
    for (const [id, prev] of modelMirrorSnapshot) {
      if (prev) modelCache.set(id, prev);
      else modelCache.delete(id);
    }
    providerMirrorSnapshot.clear();
    modelMirrorSnapshot.clear();
    activeRemoteProviderNames.clear();
    activeRemoteModels = [];
    blockLocalProviders = false;
  }

  // ── Подключение: применить состояние после успешного connect* ──
  async function applyConnected(user: RemoteUser): Promise<RemoteUser> {
    const client = connection.client;
    const backendUrl = connection.backendUrl;
    if (!client || !backendUrl) {
      throw new RemoteError('Удалённый backend не подключён', 'AUTH');
    }

    // Reconnect без disconnect: сначала откатываем предыдущие зеркала.
    restoreRemoteMirrors();

    // Зеркалирование (Задача 1): вместо одного синтетического synth-remote берём
    // с сервера полный список провайдеров и моделей. Каждый включённый серверный
    // провайдер зеркалится в providerCache под НАСТОЯЩИМ именем (itphx, ollama, …)
    // как type:'remote' → локальная сессия резолвит имя через providerLoader и
    // RemoteProvider уходит на сервер с явным provider в теле LLM Proxy.
    // Инъекция строго in-memory: в providers/*.json и models/* не пишется.
    const [rawProviders, rawModels] = await Promise.all([
      client.listProviders({ timeoutMs: 5000 }).catch(() => []),
      client.listModels({ timeoutMs: 5000 }).catch(() => []),
    ]);

    blockLocalProviders = (config.remoteLlm ?? 'server') !== 'local';

    // В remote.llm:local зеркала не должны перекрывать локальных провайдеров —
    // их имена берём из локального store (провайдеры из env тоже сохранены туда).
    const localProviderNames = new Set((await providerStore.list()).map((p) => p.name));

    const models = (rawModels ?? [])
      .map((m) => ({
        id: m.id,
        name: m.name,
        // Провайдер сохраняем как на сервере (без переписывания на synth-remote).
        provider: m.provider,
        description: m.description,
        enabled: m.enabled !== false,
        isDefault: m.isDefault === true || undefined,
        contextWindow: m.contextWindow && m.contextWindow > 0 ? m.contextWindow : undefined,
        contextSource: m.contextSource as ModelConfig['contextSource'],
        maxOutputTokens: m.maxOutputTokens,
        inputPrice: m.inputPrice,
        outputPrice: m.outputPrice,
        cacheReadPrice: m.cacheReadPrice,
        cacheWritePrice: m.cacheWritePrice,
        currency: m.currency,
      }))
      .filter((m) => m.id && m.provider);

    // Имена провайдеров, которые реально зеркалим: включённые и не служебные
    // (__*), а в remote.llm:local — ещё и не совпадающие с локальными.
    const mirrorNames = new Set<string>();
    for (const sp of rawProviders ?? []) {
      if (!sp.name || sp.name.startsWith('__')) continue;
      if (sp.enabled === false) continue;
      if (!blockLocalProviders && localProviderNames.has(sp.name)) continue;
      mirrorNames.add(sp.name);
    }

    // Модели зеркалим только тех провайдеров, что реально зеркалим: модель
    // провайдера без зеркала не резолвится оркестратором (provider_not_found).
    const modelsToMirror = models.filter((m) => mirrorNames.has(m.provider));

    // Снапшот перекрываемых записей до инъекции.
    for (const name of mirrorNames) {
      providerMirrorSnapshot.set(name, providerCache.get(name) ?? null);
    }
    for (const m of modelsToMirror) {
      if (!modelMirrorSnapshot.has(m.id)) {
        modelMirrorSnapshot.set(m.id, modelCache.get(m.id) ?? null);
      }
    }

    // Инъекция зеркал: провайдер → кэш, модели этого провайдера → modelCache,
    // токен → реестр RemoteProvider (имя зеркала = серверное имя).
    const getToken = connection.getToken;
    for (const name of mirrorNames) {
      const providerInfo = (rawProviders ?? []).find((p) => p.name === name)!;
      const spec: RemoteProviderSpec = {
        provider: {
          name,
          type: 'remote',
          baseUrl: backendUrl,
          apiKey: '',
          defaultModel: providerInfo.model || undefined,
          enabled: true,
          currency: providerInfo.currency,
        },
        models: modelsToMirror.filter((m) => m.provider === name),
        getToken: getToken ?? (async () => null),
      };
      injectRemoteProvider(providerCache, modelCache, spec);
    }
    activeRemoteProviderNames = mirrorNames;
    activeRemoteModels = modelsToMirror;

    // Мост событий backend → локальный EventBus: останавливаем старый (если был)
    // и запускаем новый для текущего клиента.
    activeBridge?.stop();
    if (getToken) {
      activeBridge = new RemoteEventBridge({ client, getToken, eventBus, backendUrl });
      activeBridge.start();
    }
    // Подключение успешно применено — статус немедленно «живой» (UI видит
    // connected сразу после логина/авто-подключения; тик watcher'а подтвердит).
    hybridLiveness = true;
    return user;
  }

  // ── Отключение: полный сброс runtime-состояния ──
  async function disconnectRemote(): Promise<void> {
    hybridLiveness = false;
    activeBridge?.stop();
    activeBridge = undefined;
    restoreRemoteMirrors();
    connection.disconnect();
  }

  // ── Публичные обёртки connect* + applyConnected ──
  async function connectRemote(serverUrl: string, username: string, password: string): Promise<RemoteUser> {
    const user = await connection.connectByPassword(serverUrl, username, password);
    return applyConnected(user);
  }

  async function connectRemoteFromSaved(backendUrl?: string): Promise<RemoteUser | null> {
    const user = await connection.connectFromSaved(backendUrl);
    if (!user) return null;
    return applyConnected(user);
  }

  async function connectRemoteWithApiKey(serverUrl: string, apiKey: string): Promise<RemoteUser> {
    const user = await connection.connectWithApiKey(serverUrl, apiKey);
    return applyConnected(user);
  }

  // ── Реестр профилей (мета-информация для UX) и выход из гибрида ──

  /**
   * Обновить мета-профиль сервера в реестре профилей (lastUsedAt/lastProfileId/
   * username) после успешного входа. Best-effort: реестр — только UX-метаданные
   * (knownServers/lastServer), ошибка записи не должна ронять логин.
   */
  async function rememberServer(serverUrl: string, username: string): Promise<void> {
    try {
      await ensureProfile(serverUrl, { username }, config.profilesPath);
    } catch {
      // best-effort: мета-реестр не критичен для входа
    }
  }

  /**
   * Полный выход из гибрида («Выйти» в UI). Локальные данные НЕ удаляются
   * (единый dataDir), мета-профиль из реестра НЕ удаляется — сервер остаётся
   * в knownServers/lastServer для формы входа. Порядок:
   *   1. best-effort revoke refresh-токена на IdP (RFC 7009): если известен
   *      backendUrl — дискавери issuer/client_id (fallback на connection.issuer /
   *      config.remoteAuth), загрузить credentials ДО удаления, отозвать refresh;
   *   2. локальное удаление credentials активного сервера («забыть токен»);
   *   3. полный сброс runtime-состояния подключения.
   * Revoke/дискавери могут не сработать (Keycloak/публичный клиент) — это ок,
   * деградация до локального удаления.
   */
  async function logoutRemote(): Promise<void> {
    const backendUrl = connection.backendUrl ?? config.defaultBackendUrl ?? null;
    const credentialsPath = config.remoteCredentialsPath ?? config.remoteAuth?.credentialsPath;

    if (backendUrl) {
      try {
        const creds = await loadCredentials(backendUrl, credentialsPath);
        if (creds?.refreshToken) {
          let issuer = connection.issuer ?? config.remoteAuth?.issuer ?? undefined;
          let clientId = config.remoteAuth?.clientId ?? undefined;
          if (!issuer || !clientId) {
            const meta = await connection.discoverOidc(backendUrl);
            issuer = meta.issuer;
            clientId = meta.clientId;
          }
          if (issuer && clientId) {
            await revokeRefreshToken(issuer, clientId, creds.refreshToken);
          }
        }
      } catch {
        // best-effort: revoke не удался — переходим к локальному удалению
      }
      try {
        await clearCredentials(backendUrl, credentialsPath);
      } catch {
        // тихо: файла может не быть
      }
    }

    await disconnectRemote().catch(() => {});
  }

  // Health — без auth
  const healthRoutes = createHealthRoutes();
  app.route('/', healthRoutes);

  // Hybrid status — без auth (как health): UI опрашивает статус подключения
  // к удалённому backend до аутентификации.
  const hybridRoutes = createHybridRoutes(getHybridState);
  app.route('/', hybridRoutes);

  // Auth routes — без auth (только spa-login проверяет ключ сам)
  app.route('/auth', createAuthRoutes(auth, {
    connection,
    connectRemote,
    connectRemoteFromSaved,
    connectRemoteWithApiKey,
    disconnectRemote,
    defaultBackendUrl: config.defaultBackendUrl,
    issuerAvailable: !!config.remoteAuth?.issuer,
    hybridEnabled: config.hybridEnabled,
    rememberServer,
    logoutRemote,
  }));


  // Всё остальное требует аутентификации
  app.use('/api/*', auth.requireAuth);
  app.use('/ws/*', auth.requireAuth);

  // Гибрид (Batch 2, T5): серверные/админ-эндпоинты (которых нет у standalone
  // или источник истины — сервер) проксируются на удалённый backend.
  // Стоит ПОСЛЕ requireAuth и ДО локальных роутов — в гибриде перехватывает
  // /api/v2/{audit,users,admin,logs,gateway,context,llm,providers,models}.
  // Middleware регистрируется ВСЕГДА; без runtime-подключения getClient() даёт
  // null → next() (запрос обрабатывают локальные роуты).
  app.use('/api/*', createRemoteProxyMiddleware(
    () => connection.client,
    () => connection.getToken?.() ?? Promise.resolve(null),
  ));

  const dataDir = config.dataDir;
  await ensureDataDir(dataDir);

  // Runtime-настройки (AD-005): workspace из {dataDir}/settings.json приоритетнее config/env
  const settingsStore = new RuntimeSettingsStore({ dataDir });
  // Агент по умолчанию (админка «Агенты»): runtime-настройка поверх DEFAULT_AGENT_ID.
  const getDefaultAgentId = async (): Promise<string> =>
    (await settingsStore.getDefaultAgent()) ?? DEFAULT_AGENT_ID;
  const runtimeWorkspace = await settingsStore.getWorkspace();
  const defaultWorkingDir = runtimeWorkspace ?? config.defaultWorkingDir ?? join(dataDir, 'workspaces', 'default');
  await mkdir(defaultWorkingDir, { recursive: true });

  // AD-036: runtime-настройка LLM Gateway (тумблер из UI) приоритетнее config.yaml
  const runtimeGateway = await settingsStore.getLlmGatewaySettings();
  const gatewayConfig = mergeLlmGatewayConfig(config.gatewayConfig, runtimeGateway);

  // Защищённые пути: runtime-настройка protectedPaths.enabled (тумблер из UI) приоритетнее config.yaml
  const runtimeSecurity = await settingsStore.getSecuritySettings();
  const effectiveSecurityConfig = mergeSecurityConfig(config.securityConfig, runtimeSecurity);

  // AD-071 §2.3: runtime-политика встроенных инструментов (админка) приоритетнее config.yaml tools.policy
  const runtimeToolsPolicy = await settingsStore.getToolsPolicy();
  const effectiveToolsPolicy: ToolsPolicy = runtimeToolsPolicy ?? config.toolsPolicy ?? 'auto';
  // AD-071 §2.3: runtime-политика MCP-инструментов (админка) приоритетнее config.yaml mcp.policy
  const runtimeMcpPolicy = await settingsStore.getMcpPolicy();
  const effectiveMcpPolicy: ToolsPolicy = runtimeMcpPolicy ?? config.mcpPolicy ?? 'auto';
  // AD-071 §2.6: runtime-отключение инструментов (админка) приоритетнее config.yaml tools.disabled
  const runtimeToolsDisabled = await settingsStore.getToolsDisabled();
  const effectiveToolsDisabled: ToolsDisabledConfig =
    runtimeToolsDisabled ?? config.toolsDisabled ?? { capabilities: [], tools: [] };
  // AD-046 §4.5: runtime-отключение скиллов (админка) — hard-gate системного уровня.
  const effectiveSkillsDisabled = (await settingsStore.getSkillsDisabled())
    ?? { categories: [], groups: [], skills: [] };

  // AD-075: политика workspace вне root. config/env — дефолт; runtime-override
  // (settings.json) применяется при старте и live через PUT /settings/workspace-policy.
  let effectiveWorkspaceOutsideRootPolicy: WorkspaceOutsideRootPolicy =
    (await settingsStore.getWorkspacePolicy()) ?? config.workspaceOutsideRootPolicy ?? 'confirm';

  // AD-036: хранилище кастомных regex-паттернов детекции секретов (override ?? дефолт)
  const patternStore = new SecretPatternStore({ dataDir });

  // Защищённые пути: store override-политики (add/remove) + миграция legacy shell-policy
  const protectedPathsStore = new ProtectedPathsStore({ dataDir });

  const fileStore = new FileStore({ dataDir });
  const projectStore = new ProjectStore({ dataDir });
  // AD-030: ядровая шина хуков — общий инстанс для SessionManager и оркестратора
  // (эмиты жизненного цикла агента). Пока обработчиков нет — поведение прежнее.
  const hooks = new HookBus();
  const sessionManager = new SessionManager(fileStore, {
    mcpSettingsProvider: () => settingsStore.getMcpSettings(),
    projectStore,
    hooks,
    // AD-071 §2.4 / AD-046 §4.5: системные дефолты для сессий без проекта.
    systemDefaultsProvider: async () => ({
      mcpDefaultOn: Object.entries(config.mcpServers ?? {})
        .filter(([, cfg]) => cfg.enabledByDefault === true)
        .map(([name]) => name),
      skillsDefaultOn: (await resolveProjectSkillSeed(
        skillService,
        await settingsStore.getSkillsDisabledForNewProjects(),
      )).enabled,
    }),
  });
  // AD-089: авто-архивация ephemeral-сессий по TTL. Таймер `unref`-ится
  // (тесты/короткоживущие процессы не держатся); остановка — на shutdown
  // через возвращаемый хэндл `stopEphemeralSweeper`.
  const stopEphemeralSweeper = startEphemeralSweeper(sessionManager);
  // AD-076: SSH-ключи агентов (шифрование at-rest мастер-ключом из dataDir/env).
  const sshKeyStore = new SSHKeyStore({ dataDir, secretKey: config.secretKey, env: process.env });
  const providerStore = new JsonStore<ProviderConfig>({ dataDir, subdir: 'providers' });
  const modelStore = new JsonStore<ModelConfig>({ dataDir, subdir: 'models' });
  const agentStore = new JsonStore<AgentDefinition>({ dataDir, subdir: 'agents' });
  const contextConfig = new ContextConfig({
    userDataDir: `${dataDir}/context`,
    systemPromptsDir: config.systemPromptsDir,
  });

  const mcpManager = new McpManager();
  mcpManager.setConfig(config.mcpServers ?? {});

  // AD-071 §2.3.1: runtime-политика сетевого доступа пользовательских HTTP MCP
  // (settings.json, админка) приоритетнее config.yaml и переживает рестарт —
  // применяем её при старте, иначе сохранённое значение терялось бы. Слияние —
  // единым helper'ом mergeMcpNetworkPolicy (тот же, что и в backend).
  const runtimeMcpNetworkPolicy = await settingsStore.getMcpNetworkPolicy();
  mcpManager.setNetworkPolicy(
    mergeMcpNetworkPolicy(config.mcpNetworkPolicy, runtimeMcpNetworkPolicy),
  );

  // Парсим провайдеров из переменных окружения
  await syncProvidersFromEnv(providerStore, modelStore);

  const eventBus = new EventBus();
  const queueManager = new QueueProcessorManager();

  const profilesStore = new FileProfileStore({ dataDir });
  const contextBuilder = new ContextBuilder(contextConfig, {
    profilesStore,
    projectDataDir: `${dataDir}/projects`,
    defaultLanguage: 'ru',
  });

  const providerCache = new Map<string, ProviderConfig>();
  (await providerStore.list()).forEach((p) => {
    providerCache.set(p.name, p);
  });

  const modelCache = new Map<string, ModelConfig>();
  (await modelStore.list()).forEach((m) => {
    modelCache.set(m.id, m);
  });

  // Гибрид: remote-провайдер/модели инъектируются в кэши в applyConnected()
  // (после успешного runtime-подключения), а не при создании приложения.

  // Загрузчик провайдеров для движка: при политике remoteLlm=server разрешены
  // ТОЛЬКО зеркала серверных провайдеров (blockLocalProviders ставится в
  // applyConnected); при remote.llm=local локальные провайдеры остаются доступны.
  const providerLoader = (name: string): ProviderConfig | null => {
    if (blockLocalProviders && activeRemoteProviderNames.size > 0 && !activeRemoteProviderNames.has(name)) return null;
    return providerCache.get(name) ?? null;
  };

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
    provider: '',
    model: '',
    temperature: 0.3,
    promptFile: 'SUMMARIZER',
  };
  const contextOptimizer = new ContextOptimizer(contextConfig, providerLoader, summarizationConfig, modelWindowLoader);
  queueManager.setContextOptimizer(contextOptimizer);

  const modelPriceLoader = (modelName: string) => {
    for (const m of modelCache.values()) {
      if (m.name === modelName || m.id === modelName) {
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

  // AD-046: сервис скиллов — discovery (instance/project/config.paths) + запись
  // instance-дерева + каталог в промпт и тул `skill`.
  const skillService = new SkillService({
    dataDir,
    configPaths: config.skillsConfig?.paths,
    urls: config.skillsConfig?.urls,
    trustedProjectDirs: config.skillsConfig?.trustedProjectDirs,
    toolsets: config.skillsConfig?.toolsets,
  });

  // AD-046 §4.2/§4.3: read-only индексация skills.urls — фоном, старт не блокируем.
  void skillService.refreshRemote().catch(() => {});

  // AD-071 §2.4 / AD-046 §4.5: разовая миграция снапшотов скоупа существующих сессий.
  await migrateSessionScopeSnapshots({
    sessionManager,
    projectStore,
    settingsStore,
    resolveSystemDefaults: async () => ({
      mcpDefaultOn: Object.entries(config.mcpServers ?? {})
        .filter(([, cfg]) => cfg.enabledByDefault === true)
        .map(([name]) => name),
      skillsDefaultOn: (await resolveProjectSkillSeed(
        skillService,
        await settingsStore.getSkillsDisabledForNewProjects(),
      )).enabled,
    }),
  }).catch(() => 0);

  // AD-046 §7: slash-команды и bundles — единый резолвинг в core (UI/CLI/гибрид).
  const bundleStore = new SkillBundleStore({
    dataDir,
    bundlesPath: config.commandsConfig?.bundlesPath,
  });
  const commandService = new CommandService({
    config: {
      dataDir,
      commandsPaths: config.commandsConfig?.paths ?? [],
      bundlesPath: config.commandsConfig?.bundlesPath ?? 'skill-bundles',
      conflict: config.commandsConfig?.conflict ?? { mode: 'bundle-wins', namespacePrefix: false },
      maxArgumentsLength: config.commandsConfig?.maxArgumentsLength ?? 10_000,
      maxRenderedBytes: config.commandsConfig?.maxRenderedBytes ?? 200_000,
      toolsets: config.skillsConfig?.toolsets ?? {},
      trustedProjectDirs: config.skillsConfig?.trustedProjectDirs,
      inlineShell: config.skillsConfig?.inlineShell ?? false,
    },
    skillRuntime: skillService,
    skillSource: skillService,
    bundleStore,
  });

  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    hooks,
    contextBuilder,
    contextConfig,
    providerLoader,
    contextOptimizer,
    modelPriceLoader,
    dataDir,
    toolRegistry,
    agentRegistry,
    projectStore,
    // Онбординг: тул `profile_update` сохраняет ответы интервью в профиль.
    profilesStore,
    // AD-076 §T6: тот же store, что у git-роутов — без дублей инстансов.
    sshKeyStore,
    defaultWorkingDir,
    workspacesRoot: config.workspacesRoot ?? join(dataDir, 'workspaces'),
    // AD-075: тулы проекта (workspace) читают live-политику вне root.
    getWorkspaceOutsideRootPolicy: async () =>
      (await settingsStore.getWorkspacePolicy()) ?? config.workspaceOutsideRootPolicy ?? 'confirm',
    permissionConfig: config.permissionConfig,
    defaultPlanMode: config.defaultPlanMode,
    securityConfig: effectiveSecurityConfig,
    gatewayConfig,
    gatewayPatternStore: patternStore,
    mcpManager,
    cachePolicy: config.llmCachePolicy,
    toolsPolicy: effectiveToolsPolicy,
    mcpPolicy: effectiveMcpPolicy,
    toolsDisabled: effectiveToolsDisabled,
    // AD-046 §4.5: системный hard-gate скиллов (runtime-настройка).
    skillsDisabled: effectiveSkillsDisabled,
    // AD-070 §2.9.1: зависимости окружения (git/rg/sh) — детекция при старте,
    // fail-open при ошибке. Пробинг идёт до сборки оркестратора, чтобы первый
    // же запрос видел корректную доступность.
    runtimeDeps: await detectRuntimeDeps(),
    // AD-071 §2.6: калибровка chars-per-token по модели (runtime-настройки).
    tokenRatioLoader: (model) => settingsStore.getTokenRatio(model),
    onTokenRatioCalibrated: (model, ratio) => settingsStore.setTokenRatio(model, ratio),
    // AD-046 §5: каталог скиллов в промпт + тул `skill`.
    skillRuntime: skillService,
    // AD-046 §7: резолвинг `/`-команд до LLM.
    commandRuntime: commandService,
    // AD-069 Фаза 1: проектные инструкции (merged chain AGENTS.md).
    instructionsConfig: config.instructionsConfig,
    // AD-069 Фаза 2a: project-trust гейт инструкций (config.skills.trustedProjectDirs).
    instructionsTrustedProjectDirs: config.skillsConfig?.trustedProjectDirs,
    // AD-089: late-bound funnel создания сессий для тула `task` (саб-агент).
    // Сам сервис создаётся ниже (после оркестратора) — геттер читает его в рантайме.
    getRequestSessionService: () => requestSessionService,
    // AD-051: late-bound резолвер активности расписания в сессии (ScheduleStore
    // создаётся ниже) — включает статический блок `Scheduler` в промпт.
    isSchedulerActive: (sid) => scheduleStore.hasEnabledTargetFor(sid),
  });

  const processMessage = orchestrator.createProcessMessage();

  // AD-089: ядро маршрутизации внешних событий и единый funnel создания сессий.
  // Funnel подключён к `POST /sessions` и тулу `task` (Этап 5); приём внешних
  // событий — на следующих этапах.
  const eventBindingStore = new EventBindingStore({ dataDir });
  // AD-089/AD-052: API-ключи привязок для аутентификации приёма событий.
  const eventApiKeyStore = new EventApiKeyStore({ dataDir });
  const eventJournal = new EventJournalStore({ dataDir });
  // AD-089: реестр правил маршрутизации (проектные/инстанс-правила).
  const routeRuleStore = new RouteRuleStore({ dataDir });
  // AD-089 (Блок 3): runtime-настройки «События» (админка) поверх config.yaml.
  // Эффективные значения — единый источник для Router/funnel/pruner/роутов;
  // live-изменяются через `onEventsChange` без рестарта.
  const runtimeEvents = await settingsStore.getEvents();
  const effectiveEvents = mergeEventsConfig(config.eventsConfig, runtimeEvents);
  let effectiveEventsSettings = effectiveEvents;
  // AD-051/AD-089: источник дедупа — in-process (default) или файловый
  // межпроцессный (config.events.dedupStore === 'file').
  const dedupStore = config.eventsConfig?.dedupStore === 'file'
    ? new FileDedupStore({ dataDir })
    : new MemoryDedupStore();
  const eventRouter = new EventRouter({
    bindingStore: eventBindingStore,
    journal: eventJournal,
    hooks,
    dedupStore,
    config: {
      allowedSources: effectiveEvents.allowedSources,
      defaultMode: effectiveEvents.defaultMode,
      defaultEphemeralTtl: effectiveEvents.ephemeralTtl,
    },
  });
  // AD-089 (Блок 2): retention-очистка журнала событий (сразу + каждые 6 ч).
  const stopEventJournalPruner = startEventJournalPruner(eventJournal, {
    getRetentionDays: () => effectiveEventsSettings.journalRetentionDays,
  });
  // AD-051 (срез) / AD-089: правило маршрутизации cron-событий по расписанию.
  const scheduleStore = new ScheduleStore({
    dataDir,
    crossProcess: config.schedulerConfig?.crossProcessLocks ?? false,
  });
  const jobStore = new JobStore({ dataDir });
  eventRouter.registerRuleProvider(
    new SchedulerRuleProvider(scheduleStore, effectiveEvents.ephemeralTtl),
  );
  // AD-089: правила маршрутизации по матчу события (после scheduler — приоритет
  // cron-правила при совпадении).
  eventRouter.registerRuleProvider(
    new ProjectRuleProvider(routeRuleStore, effectiveEvents.ephemeralTtl),
  );
  // AD-089: резолвинг `agentTemplate` (события/правила) через `AgentRegistry`:
  // неизвестный или отключённый агент → `null`.
  const resolveAgentTemplate = (template: string): string | null => {
    const agent = agentRegistry.get(template);
    return agent && agent.enabled ? agent.id : null;
  };
  const requestSessionService = new RequestSessionService({
    sessionManager,
    eventRouter,
    hooks,
    config: {
      defaultEphemeralTtl: effectiveEvents.ephemeralTtl,
      unknownAgentTemplate: effectiveEvents.unknownAgentTemplate,
    },
    resolveAgentTemplate,
    // AD-089: UI-событие после материализации внешнего события.
    publish: (type, sessionId, data) => eventBus.publish(sessionId, type, data),
    deliver: async (sessionId, event, mode) => {
      // AD-051: cron-сообщение — от системного пользователя `Scheduler`, текст
      // задания — чистый контент сообщения (описание Scheduler — в system-блоке).
      let message = eventToMessage(event);
      if (mode === 'run') {
        // Запускает процессор (постановка + старт) — как обычный user-промпт.
        // AD-036: обфускация user-сообщения ДО сохранения в историю (паритет с
        // prompt-путём — routes/sessions.ts).
        await enqueueUserMessage(
          sessionManager, eventBus, sessionId, message, queueManager, processMessage,
          (sid, msg) => orchestrator.obfuscateUserMessageForHistory(sid, msg),
        );
      } else {
        // AD-036: `defer` тоже кладёт сообщение в историю — обфусцируем до
        // постановки. Старт процессора не выполняем (только очередь владельца).
        message = await orchestrator.obfuscateUserMessageForHistory(sessionId, message);
        await sessionManager.addPendingMessage(sessionId, message);
      }
    },
  });

  // AD-089: ingress-точка приёма внешних событий (Этап 6).
  const eventIngress = new EventIngress({ requestSessionService });

  // AD-051 (срез) / AD-089: планировщик публикует cron-события через ingress.
  // `start()` гейтится конфигом; остановка — на shutdown (`stopScheduler`).
  const schedulerTickMs = (config.schedulerConfig?.tickSec ?? 60) * 1000;
  const schedulerService = new SchedulerService({
    scheduleStore,
    ingress: eventIngress,
    jobStore,
    tickMs: schedulerTickMs,
    defaultEphemeralTtl: effectiveEvents.ephemeralTtl,
    catchUp: config.schedulerConfig?.catchUp ?? 'skip',
    jobRetentionDays: config.schedulerConfig?.jobRetentionDays ?? 30,
    // AD-051/AD-089: тикер стартует только у лидера (default — AlwaysLeader).
    leader: config.schedulerConfig?.leaderElection === 'file'
      ? new FileLeader({ dataDir, tickMs: schedulerTickMs })
      : new AlwaysLeader(),
  });
  if (config.schedulerConfig?.enabled !== false) {
    void schedulerService.start().catch((err) => {
      console.warn(`[scheduler] не удалось запустить: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // API-заглушки для UI
  app.get('/api/config/themes', (c) => c.json({ themes: [] }));

  // Sessions
  app.route('/api/v2/sessions', createSessionRoutes(
    auth,
    {
      sessionManager,
      eventBus,
      queueManager,
      processMessage,
      orchestrator,
      contextOptimizer,
      projectStore,
      profilesStore,
      getRemoteClient: () => connection.client,
      requestSessionService,
    },
    { resolveDefaultAgent: getDefaultAgentId },
  ));

  // Projects
  app.route('/api/v2/projects', createProjectRoutes(auth, projectStore, () => connection.client, {
    // AD-075: автосоздание/нормализация workspace локальных проектов.
    getWorkspacesRoot: () => config.workspacesRoot ?? join(dataDir, 'workspaces'),
    getOutsideRootPolicy: () => effectiveWorkspaceOutsideRootPolicy,
    // AD-071 §2.4 / AD-046 §4.5: сид скоупа нового проекта (снимок дефолтов).
    getProjectSeeds: async () => {
      const defaultMcpServers = Object.entries(config.mcpServers ?? {})
        .filter(([, cfg]) => cfg.enabledByDefault === true)
        .map(([name]) => name);
      return {
        mcp: { enabled: [...defaultMcpServers], defaultOn: [...defaultMcpServers] },
        skills: await resolveProjectSkillSeed(
          skillService,
          await settingsStore.getSkillsDisabledForNewProjects(),
        ),
      };
    },
  }));

  // Перенос проектов между мирами (гибрид, UI publish/fork): те же пути, что у
  // project-роутов (:id/publish, :id/fork-local — без конфликта с :id). Работает
  // in-process через remote/transfer.ts, требует runtime-подключения к backend.
  app.route('/api/v2/projects', createProjectTransferRoutes(
    auth,
    projectStore,
    sessionManager,
    config.workspacesRoot ?? join(dataDir, 'workspaces'),
    defaultWorkingDir,
    () => connection.client,
  ));

  // Providers
  app.route('/api/v2/providers', createProviderRoutes(auth, providerStore, providerCache, { testEnabled: true }));

  // Models: remote-модели/провайдер читаются на каждый запрос (runtime-подключение).
  app.route('/api/v2/models', createModelRoutes(auth, modelStore, providerStore, modelCache, {
    extraModels: () => [...activeRemoteModels],
    extraProviders: () => {
      const out: ProviderConfig[] = [];
      for (const name of activeRemoteProviderNames) {
        const p = providerCache.get(name);
        if (p) out.push(p);
      }
      return out;
    },
    onlyRemoteModels: () => blockLocalProviders && activeRemoteProviderNames.size > 0,
  }));

  // Agents
  app.route('/api/v2/agents', createAgentRoutes(auth, agentStore, agentRegistry, getDefaultAgentId));

  // FS (AD-075: гарантированный корень workspace + мягкая политика путей вне root)
  // project-aware: с `project_id` база — workspace проекта (fallback на root/default).
  app.route('/api/v2/fs', createFsRoutes(
    auth,
    config.workspacesRoot ?? join(dataDir, 'workspaces'),
    () => connection.client,
    {
      getOutsideRootPolicy: () => effectiveWorkspaceOutsideRootPolicy,
      getProtectedPathsPolicy: () => protectedPathsStore.getPolicy(),
      getProjectWorkspace: (projectId) => resolveProjectWorkspace(projectId, {
        workspacesRoot: config.workspacesRoot ?? join(dataDir, 'workspaces'),
        getProject: (id) => projectStore.load(id),
        outsideRootPolicy: () => effectiveWorkspaceOutsideRootPolicy,
        strict: false,
      }),
    },
  ));

  // Git (AD-076): реестр репозиториев, clone/init/fetch/remove, SSH-ключи.
  // Core — локальный single-user режим: writeGuard не задаём (по умолчанию requireAuth).
  app.route('/api/v2/git', createGitRoutes(
    auth,
    projectStore,
    config.workspacesRoot ?? join(dataDir, 'workspaces'),
    { sshKeyStore },
  ));

  // SSH-ключи агентов (AD-076 §T5): flat CRUD + nested-роуты агента.
  // Core — локальный single-user режим: guards не задаём (дефолт requireAuth).
  app.route('/api/v2/ssh-keys', createSshKeyRoutes(auth, sshKeyStore));
  app.route('/api/v2/agents/:agentId/ssh-keys', createAgentSshKeyRoutes(auth, sshKeyStore));

  // Queue
  app.route('/api/v2/queue', createQueueRoutes(auth, sessionManager, queueManager, eventBus, processMessage, () => connection.client));

  // Updates
  app.route('/api/v2/updates', createUpdateRoutes(auth, dataDir));

  // Messages (batch operations)
  app.route('/api/v2/messages', createMessageRoutes(auth, sessionManager, () => connection.client));

  // Settings (runtime-настройки для UI, раздел «Проекты»)
  app.route('/api/v2/settings', createSettingsRoutes(auth, {
    settingsStore,
    fallbackWorkspace: defaultWorkingDir,
    // AD-075: дефолт политики workspace вне root (config/env) для GET/DELETE-сброса.
    fallbackWorkspaceOutsideRootPolicy: config.workspaceOutsideRootPolicy ?? 'confirm',
    /** AD-075: live-применение политики без рестарта (роуты проектов читают её на каждом запросе). */
    onWorkspacePolicyChange: (policy) => { effectiveWorkspaceOutsideRootPolicy = policy; },
    // Агент по умолчанию при первом развёртывании (config.yaml не задаёт — DEFAULT_AGENT_ID).
    fallbackDefaultAgent: DEFAULT_AGENT_ID,
    // AD-072 Ф2: дефолты из config.yaml (без runtime) — для GET/DELETE-сброса к умолчанию.
    fallbackLlmGateway: config.gatewayConfig ? {
      enabled: config.gatewayConfig.enabled,
      inputMode: config.gatewayConfig.inputMode,
      logPayloads: config.gatewayConfig.logPayloads,
      rateLimit: {
        userPerMinute: config.gatewayConfig.rateLimit?.userPerMinute ?? DEFAULT_LLM_GATEWAY_RATE_LIMIT.userPerMinute,
        providerPerMinute: config.gatewayConfig.rateLimit?.providerPerMinute ?? DEFAULT_LLM_GATEWAY_RATE_LIMIT.providerPerMinute,
      },
    } : undefined,
    fallbackSecurity: {
      protectedPaths: { enabled: config.securityConfig?.protectedPaths?.enabled ?? true },
      askTimeoutMs: (config.securityConfig as (SecurityConfig & { askTimeoutMs?: number }) | undefined)?.askTimeoutMs,
    },
    // AD-036: live-применение тумблера LLM Gateway из UI — без рестарта сервера.
    onLlmGatewayChange: async (runtime) => {
      const merged = mergeLlmGatewayConfig(config.gatewayConfig, runtime);
      orchestrator.setGatewayConfig(merged);
    },
    // Live-применение тумблера защищённых путей + таймаута подтверждения из UI —
    // без рестарта сервера.
    onSecurityChange: async (runtime) => {
      const merged = mergeSecurityConfig(config.securityConfig, runtime);
      orchestrator.setSecurityConfig(merged);
      if (merged?.askTimeoutMs !== undefined) {
        orchestrator.setDefaultPermissionTimeout(merged.askTimeoutMs);
      }
    },
    // AD-071 §2.3: live-применение политики встроенных инструментов из админки.
    fallbackToolsPolicy: config.toolsPolicy ?? 'auto',
    onToolsPolicyChange: async (policy) => {
      orchestrator.setToolsPolicy(policy);
    },
    // AD-071 §2.3: live-применение политики MCP-инструментов из админки.
    fallbackMcpPolicy: config.mcpPolicy ?? 'auto',
    onMcpPolicyChange: async (policy) => {
      orchestrator.setMcpPolicy(policy);
    },
    // AD-071 §2.6: live-применение instance-wide отключения инструментов.
    fallbackToolsDisabled: config.toolsDisabled ?? { capabilities: [], tools: [] },
    onToolsDisabledChange: async (disabled) => {
      orchestrator.setToolsDisabled(disabled);
    },
    knownTools: () => toolRegistry.list().map((tool) => ({
      name: tool.name,
      capabilities: [...tool.capabilities],
    })),
    // AD-071 §2.3.1: дефолт config.yaml для GET/DELETE-сброса политики.
    fallbackMcpNetworkPolicy: config.mcpNetworkPolicy,
    // AD-071 §2.3.1: live-применение политики сетевого доступа MCP из админки.
    onMcpNetworkPolicyChange: async (policy) => {
      mcpManager.setNetworkPolicy(policy);
    },
    // AD-089: дефолт config.yaml для GET/DELETE-сброса раздела «События».
    fallbackEvents: config.eventsConfig,
    // AD-089: live-применение runtime-настроек «События» — Router/funnel/pruner
    // переконфигурируются без рестарта.
    onEventsChange: (effective) => {
      effectiveEventsSettings = effective;
      eventRouter.updateConfig({
        allowedSources: effective.allowedSources,
        defaultMode: effective.defaultMode,
        defaultEphemeralTtl: effective.ephemeralTtl,
      });
      requestSessionService.updateConfig({
        defaultEphemeralTtl: effective.ephemeralTtl,
        unknownAgentTemplate: effective.unknownAgentTemplate,
      });
    },
    protectedPathsStore,
  }));

  // Словари классификации: чтение — все аутентифицированные, запись/сброс —
  // аутентификация (в standalone достаточно --api-key, локальный режим).
  // Модуль общий с backend, отличается только writeGuard.
  const dictionaryStore = new DictionaryStore(dataDir);
  app.route('/api/v2/dictionaries', createDictionaryRoutes(auth, dictionaryStore));

  // MCP (probe подключения к серверу)
  app.route('/api/v2/mcp', createMcpRoutes(auth, { mcpManager }));

  // AD-089: приём внешних событий (ingress), биндинги и журнал. `GET /` не
  // определяется — SSE-хаб на `/api/v2/events` регистрируется ниже.
  app.route('/api/v2/events', createEventRoutes(
    auth,
    {
      ingress: eventIngress,
      bindingStore: eventBindingStore,
      journal: eventJournal,
      routeRuleStore,
      apiKeyStore: eventApiKeyStore,
    },
    {
      resolveAgentTemplate,
      sessionExists: async (id) => (await sessionManager.getSession(id)) !== null,
      // AD-089/AD-052: per-key rate limit и мастер-выключатель приёма (live).
      getKeyRateLimitPerMinute: () => effectiveEventsSettings.keyRateLimitPerMinute,
      isEnabled: () => effectiveEventsSettings.enabled,
      // AD-089/AD-052: приём события по API-ключу привязки.
      resolveApiKeySecret: async (raw) => {
        const resolved = await eventApiKeyStore.resolveBySecret(raw);
        if (!resolved) return null;
        const binding = await eventBindingStore.get(resolved.credential.bindingId);
        if (!binding) return null;
        return { binding, credential: resolved.credential };
      },
      touchApiKey: (id) => eventApiKeyStore.touch(id),
    },
  ));

  // AD-051 (срез) / AD-089: CRUD расписаний и принудительный запуск.
  app.route('/api/v2/schedules', createSchedulerRoutes(
    auth,
    { scheduleStore, scheduler: schedulerService, jobStore },
  ));

  // Скиллы (AD-046 §9.1): реестр + instance CRUD + supporting-файлы + reload.
  app.route('/api/v2/skills', createSkillRoutes(auth, {
    skillService,
    resolveProjectWorkspace: async (projectId) => {
      const project = await projectStore.load(projectId);
      if (!project?.workspace) return undefined;
      const root = config.workspacesRoot ?? join(dataDir, 'workspaces');
      return isAbsolute(project.workspace) ? normalize(project.workspace) : resolve(root, project.workspace);
    },
  }));

  // AD-046 §9.1: список команд (встроенные + шаблонные + скиллы + bundles).
  app.route('/api/v2/commands', createCommandRoutes(auth, {
    commandService,
    resolveProjectWorkspace: async (projectId) => {
      const project = await projectStore.load(projectId);
      if (!project?.workspace) return undefined;
      const root = config.workspacesRoot ?? join(dataDir, 'workspaces');
      return isAbsolute(project.workspace) ? normalize(project.workspace) : resolve(root, project.workspace);
    },
  }));

  // AD-046 §9.1: bundles (instance-хранилище YAML-групп скиллов).
  app.route('/api/v2/skill-bundles', createSkillBundleRoutes(auth, {
    bundleStore,
    validateSkills: async (names) => {
      const missing: string[] = [];
      for (const name of names) {
        if (!(await skillService.get(name))) missing.push(name);
      }
      return missing;
    },
  }));

  // AD-046 §4.5: scope-API скиллов (сессии/проекты/настройки, аналог MCP).
  const resolveSkillWorkspace = async (projectId: string): Promise<string | undefined> => {
    const project = await projectStore.load(projectId);
    if (!project?.workspace) return undefined;
    const root = config.workspacesRoot ?? join(dataDir, 'workspaces');
    return isAbsolute(project.workspace) ? normalize(project.workspace) : resolve(root, project.workspace);
  };
  app.route('/api/v2/sessions', createSessionSkillScopeRoutes(auth, {
    sessionManager, skillService, settingsStore, projectStore,
    permissionConfig: config.permissionConfig,
    resolveProjectWorkspace: resolveSkillWorkspace,
  }));
  app.route('/api/v2/projects', createProjectSkillScopeRoutes(auth, {
    sessionManager, skillService, settingsStore, projectStore,
    permissionConfig: config.permissionConfig,
    resolveProjectWorkspace: resolveSkillWorkspace,
  }));
  app.route('/api/v2/settings', createSkillSettingsRoutes(auth, { settingsStore }, {
    onSkillsDisabledChange: (disabled) => orchestrator.setSkillsDisabled(disabled),
  }));

  // AD-069 §9.3: read-only прозрачность проектных инструкций (session/project scope).
  // Резолвер — тот же core-модуль, что у оркестратора (Фаза 1/2a); доступ —
  // владелец|ADMIN по сессии, owner/LEAD/ADMIN по проекту.
  if (config.instructionsConfig) {
    const instructionsInfoResolver = createInstructionsInfoResolver(
      new ProjectInstructionsResolver({
        config: config.instructionsConfig,
        dictionaryStore,
        dataDir,
        trustedProjectDirs: config.skillsConfig?.trustedProjectDirs,
        // AD-069 R3: авто-trust workspace внутри workspacesRoot (как в оркестраторе).
        workspacesRoot: config.workspacesRoot ?? join(dataDir, 'workspaces'),
      }),
      config.instructionsConfig,
    );
    app.route('/api/v2/context', createContextRoutes(auth, {
      resolveInstructions: instructionsInfoResolver,
      sessionManager,
      projectStore,
      resolveProjectWorkspace: resolveSkillWorkspace,
      resolveContextWindow: (session) => {
        const model = session?.settings.model;
        return model ? modelWindowLoader(model) || undefined : undefined;
      },
    }));
  }

  // Глобальный SSE-хаб
  app.get('/api/v2/events', async (c) => {
    const signal = c.req.raw.signal;

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();

          const unsubs: Array<() => void> = [];

          const handler = (event: { type: string; data: Record<string, unknown>; sessionId: string; timestamp: string }) => {
            try {
              const line = `data: ${JSON.stringify(event)}\n\n`;
              controller.enqueue(encoder.encode(line));
            } catch {
              // disconnected
            }
          };

          if (connection.connected) {
            // Гибрид: события удалённых сессий (remote:<id>) публикует мост,
            // локальных — оркестратор. Только subscribeAll — без дублей.
            unsubs.push(eventBus.subscribeAll(handler));
          } else {
            const allSessions = await sessionManager.listSessions({ userId: 'local' });
            for (const s of allSessions) {
              unsubs.push(eventBus.subscribe(s.id, handler));
            }
          }

          const keepalive = setInterval(() => {
            try { controller.enqueue(encoder.encode(':keepalive\n\n')); } catch { clearInterval(keepalive); }
          }, 30_000);

          try {
            await new Promise<void>((resolve) => {
              if (signal.aborted) { resolve(); return; }
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          } finally {
            clearInterval(keepalive);
            for (const unsub of unsubs) unsub();
            try { controller.close(); } catch { /* already closed */ }
          }
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      },
    );
  });

  // 404
  app.notFound((c) => {
    return c.json({
      error: {
        code: 'NOT_FOUND',
        message: `Маршрут не найден: ${c.req.method} ${c.req.path}`,
      },
    }, 404);
  });

  // Создаём HTTP сервер
  function toWebRequest(req: IncomingMessage): Request {
    const protocol = 'http';
    const host = req.headers.host || 'localhost';
    const url = `${protocol}://${host}${req.url || '/'}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const method = req.method || 'GET';
    const noBody = ['GET', 'HEAD'].includes(method) || !req.headers['content-length'];
    return new Request(url, {
      method,
      headers,
      body: noBody ? undefined : (Readable.toWeb(req) as ReadableStream),
      duplex: 'half',
    } as RequestInit);
  }

  const staticHandler = config.uiDistPath && existsSync(config.uiDistPath)
    ? serveStatic(config.uiDistPath)
    : null;

  const server = createServer(async (req, res) => {
    try {
      const webReq = toWebRequest(req);
      const url = new URL(webReq.url);

      // Статика UI для GET-запросов без префиксов API
      if (staticHandler && webReq.method === 'GET'
        && !url.pathname.startsWith('/api/')
        && !url.pathname.startsWith('/auth/')
        && !url.pathname.startsWith('/admin/')
        && !url.pathname.startsWith('/ws')
        && !url.pathname.startsWith('/health')) {
        const staticResp = await staticHandler(webReq);
        if (staticResp) {
          const headers = Object.fromEntries(staticResp.headers.entries());
          res.writeHead(staticResp.status, headers);
          if (staticResp.body) {
            const reader = staticResp.body.getReader();
            const pump = async () => {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
              res.end();
            };
            pump().catch(() => res.end());
          } else {
            res.end();
          }
          return;
        }
      }

      const response = await app.fetch(webReq, {});
      if (!response) {
        res.writeHead(500);
        res.end();
        return;
      }
      const headers = Object.fromEntries(response.headers.entries());
      res.writeHead(response.status, headers);
      // SSE/долгоживущие стримы: при chunked-кодировании Node не сбрасывает
      // заголовки в сокет до первого write()/end(). Для пустого начала стрима
      // (SSE до первого события/keepalive) клиент иначе не получит заголовки
      // вовсе — сбрасываем head принудительно.
      res.flushHeaders();
      if (response.body) {
        const reader = response.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        };
        pump().catch(() => res.end());
      } else {
        res.end();
      }
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  // WebSocket /ws/events
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname === '/ws/events') {
      const authHeader = request.headers['authorization'] || request.headers['Authorization'];
      const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;

      // Аутентификация: либо валидный Bearer API-ключ (CLI/API-клиенты), либо
      // cookie-сессия v2 (server-identity/local) — браузер не может ставить
      // Authorization-заголовок на WebSocket, поэтому UI полагается на cookie.
      let authorized = token === config.apiKey;
      if (!authorized) {
        const cookieContext = {
          req: {
            header: (name: string): string | undefined => {
              const v = request.headers[name.toLowerCase()];
              return Array.isArray(v) ? v[0] : v;
            },
          },
        };
        authorized = auth.getCurrentUser(cookieContext) !== null;
      }

      if (!authorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, async (ws: WebSocket) => {
        const clientId = `ws-events-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const unsubs: Array<() => void> = [];

        const handler = (event: { type: string; data: Record<string, unknown> }) => {
          try {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(event));
            }
          } catch { /* ignore */ }
        };

        if (connection.connected) {
          // Гибрид: события удалённых сессий (remote:<id>) публикует мост —
          // подписываемся на все события (без дублей для локальных).
          unsubs.push(eventBus.subscribeAll(handler));
        } else {
          const allSessions = await sessionManager.listSessions({ userId: 'local' });
          for (const s of allSessions) {
            unsubs.push(eventBus.subscribe(s.id, handler));
          }
        }

        ws.send(JSON.stringify({
          type: 'connected',
          client_id: clientId,
          engine: 'synth',
        }));

        ws.on('message', (raw: Buffer) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'ping') {
              ws.send(JSON.stringify({ type: 'pong' }));
            } else if (msg.type === 'send_message') {
              const sid = msg.session_id;
              if (!sid || !msg.content?.trim()) return;

              const streamId = msg.stream_id || generateStreamId();

              ws.send(JSON.stringify({
                type: 'queued',
                session_id: sid,
                stream_id: streamId,
                timestamp: nowISO(),
              }));

              (async () => {
                // Гибрид: remote-сессия (`remote:<id>`) — промпт уходит на удалённый
                // backend (raw Response, тело не читаем), события возвращаются через
                // RemoteEventBridge. Локальный оркестратор не запускается.
                if (isRemoteRef(sid)) {
                  const remote = connection.client;
                  if (!remote) {
                    ws.send(JSON.stringify({
                      type: 'error',
                      session_id: sid,
                      data: { error: 'Удалённый сервер не подключён' },
                      timestamp: nowISO(),
                    }));
                    return;
                  }
                  try {
                    await remote.promptSession(toLocalId(sid), {
                      content: msg.content.trim(),
                      messageId: streamId,
                      ...(msg.agent_role ? { agent: msg.agent_role } : {}),
                      ...(msg.provider ? { provider: msg.provider } : {}),
                      ...(msg.model ? { model: msg.model } : {}),
                    });
                  } catch (err) {
                    ws.send(JSON.stringify({
                      type: 'error',
                      session_id: sid,
                      data: { error: err instanceof Error ? err.message : String(err) },
                      timestamp: nowISO(),
                    }));
                  }
                  return;
                }

                const session = await sessionManager.getSession(sid);
                if (!session) {
                  ws.send(JSON.stringify({
                    type: 'error',
                    session_id: sid,
                    data: { error: 'Session not found' },
                    timestamp: nowISO(),
                  }));
                  return;
                }

                const message: Message = {
                  id: streamId,
                  role: MessageRole.USER,
                  seq: session.messages.length + 1,
                  origin: 'local',
                  parts: [makeTextPart(msg.content.trim())],
                  content: msg.content.trim(),
                  createdAt: nowISO(),
                  disabled: false,
                  pinned: false,
                  hidden: false,
                  author: 'local',
                  agentRole: msg.agent_role || session.settings.agentRole,
                  provider: msg.provider || session.settings.provider,
                  model: msg.model || session.settings.model,
                  metadata: { stream_id: streamId },
                };

                const result = await enqueueUserMessage(
                  sessionManager, eventBus, sid, message, queueManager, processMessage,
                  (msgSid, msg) => orchestrator.obfuscateUserMessageForHistory(msgSid, msg),
                );

                if (!result) {
                  ws.send(JSON.stringify({
                    type: 'queue.stalled',
                    session_id: sid,
                    data: { pending_count: session.pendingMessages.length },
                    timestamp: nowISO(),
                  }));
                }
              })().catch(() => {});
            } else if (msg.type === 'cancel') {
              const sid = msg.session_id;
              if (!sid) return;

              (async () => {
                const session = await sessionManager.getSession(sid);
                if (session?.currentStream) {
                  orchestrator.cancel(session.currentStream.streamId);
                  session.currentStream.cancelled = true;
                  await sessionManager.updateSession(session);
                }
                queueManager.stop(sid);
              })().catch(() => {});
            } else if (msg.type === 'permission_reply') {
              const sid = msg.session_id;
              const approvalId = msg.approval_id;
              if (!sid || !approvalId) return;

              // Новый формат: { action: 'allow'|'deny', once?: boolean }.
              // Старый формат { approved: boolean } остаётся совместимым.
              const action = msg.action === 'allow' || msg.action === 'deny' ? msg.action : undefined;
              eventBus.publish(sid, 'permission.replied', {
                approval_id: approvalId,
                session_id: sid,
                approved: action !== undefined ? action === 'allow' : msg.approved === true,
                ...(action ? { action } : {}),
                ...(typeof msg.once === 'boolean' ? { once: msg.once } : {}),
              });
            }
          } catch { /* ignore parse errors */ }
        });

        ws.on('close', () => {
          for (const unsub of unsubs) unsub();
        });

        ws.on('error', () => {
          for (const unsub of unsubs) unsub();
        });
      });
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  const port = config.port;

  console.log(`synth-core starting on http://localhost:${port}`);
  console.log(`  data dir: ${dataDir}`);
  console.log(`  api key: ${config.apiKey.slice(0, 8)}...`);
  if (config.uiDistPath && existsSync(config.uiDistPath)) {
    console.log(`  ui: serving from ${config.uiDistPath}`);
  }
  if (config.defaultBackendUrl) {
    console.log(`  remote: гибридный режим (сервер ${config.defaultBackendUrl}) — подключение в рантайме`);
  }

  // Watcher фактической живости: создаётся (но НЕ стартует — чтобы тесты app не
  // гоняли интервалы); запускает cli.ts через handle.startConnectionWatcher().
  connectionWatcher = new ConnectionWatcher({
    getTarget: () => connection.backendUrl ?? config.defaultBackendUrl ?? null,
    isSessionActive: () => connection.connected,
    tryConnectFromSaved: async (url) => {
      try {
        const user = await connectRemoteFromSaved(url);
        return !!user;
      } catch {
        return false;
      }
    },
    checkReachable: async () => {
      try {
        const client = connection.client;
        if (!client) return false;
        return await client.isReachable();
      } catch {
        return false;
      }
    },
    checkAuth: async () => {
      const client = connection.client;
      if (!client) return false;
      try {
        const st = await client.getAuthStatus({ timeoutMs: 5000 });
        return st.authenticated === true;
      } catch {
        return false;
      }
    },
    setLiveness: (v) => {
      hybridLiveness = v;
    },
  });

  return {
    app,
    server,
    wss,
    port,
    connection,
    connectRemote,
    connectRemoteFromSaved,
    connectRemoteWithApiKey,
    disconnectRemote,
    // Watcher фактической живости подключения: НЕ стартует внутри
    // createStandaloneApp — запускает/останавливает cli.ts (server.listen →
    // gracefulShutdown), чтобы тесты app не держали фоновых интервалов.
    startConnectionWatcher: () => connectionWatcher?.start(),
    stopConnectionWatcher: () => connectionWatcher?.stop(),
    getHybridStatus: getHybridState,
    eventBus,
    // AD-089: ядро событий — роутер, funnel создания сессий и хранилища
    // (понадобятся на этапах 5–6 при подключении роутов приёма событий).
    eventRouter,
    requestSessionService,
    eventBindingStore,
    eventJournal,
    // AD-089: ingress-точка приёма внешних событий.
    ingress: eventIngress,
    // AD-051 (срез) / AD-089: реестр расписаний и планировщик.
    scheduleStore,
    scheduler: schedulerService,
    // AD-089: остановка sweeper'а ephemeral-сессий (вызывается на graceful shutdown).
    stopEphemeralSweeper,
    // AD-089: остановка периодической retention-очистки журнала событий.
    stopEventJournalPruner,
    // AD-051 (срез): остановка планировщика (на graceful shutdown).
    stopScheduler: () => schedulerService.stop(),
    // Текущий мост событий (создаётся/обновляется в applyConnected) — для stop() при shutdown.
    get remoteEventBridge(): RemoteEventBridge | undefined {
      return activeBridge;
    },
  };
}
