// Гибрид (ADR-042/045/079): зеркалирование серверных провайдеров/моделей в
// in-memory кэши, runtime-подключение к удалённому backend, состояние для
// `/api/v2/hybrid/status` и watcher фактической живости.
// Вынесено из `server/app.ts` (ADR-095, шаг 4a) — «вынос по швам», без изменения поведения.
import type { ProviderConfig, ModelConfig } from '@itphx/synth-shared';
import type { RemoteUser } from '../../remote/types.js';
import { RemoteError } from '../../remote/types.js';
import type { RemoteConnection } from '../../remote/connection.js';
import { RemoteEventBridge } from '../../remote/event-bridge.js';
import { setRemoteTokenProvider, removeRemoteTokenProvider } from '../../providers/remote.js';
import { loadCredentials, clearCredentials } from '../../remote/credentials.js';
import { revokeRefreshToken } from '../../remote/device-flow.js';
import { ensureProfile, listProfiles, getLastProfile } from '../../profiles.js';
import { ConnectionWatcher } from '../connection-watcher.js';
import type { JsonStore } from '../../storage/json-store.js';
import type { EventBus } from '../../index.js';
import type { StandaloneConfig } from '../app.js';

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

/** Ленивый доступ к общим зависимостям (создаются в `app.ts` после фабрики). */
export interface HybridRemoteDeps {
  /** Шина событий процесса (мост backend → локальный EventBus). */
  getEventBus: () => EventBus;
  /** Реестр провайдеров (имена локальных провайдеров при `remote.llm=local`). */
  getProviderStore: () => JsonStore<ProviderConfig>;
  /** In-memory кэш провайдеров (зеркала перекрывают записи). */
  getProviderCache: () => Map<string, ProviderConfig>;
  /** In-memory кэш моделей (зеркала перекрывают записи). */
  getModelCache: () => Map<string, ModelConfig>;
}

/**
 * Состояние гибридного подключения standalone-core: зеркала серверных
 * провайдеров/моделей, мост событий, статус живости, публичные `connect*`/`logout`.
 *
 * Зависимости инжектируются лениво: фабрика создаётся до сборки общих
 * зависимостей (`createStandaloneDeps`), а геттеры вызываются только в рантайме
 * (после успешного `connect*`).
 */
export function createHybridRemoteState(
  config: StandaloneConfig,
  connection: RemoteConnection,
  deps: HybridRemoteDeps,
) {
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

  // ── Состояние гибрида (для hybrid/status, без auth) ──
  async function getHybridState() {
    const serverConfigured = !!config.defaultBackendUrl;
    // Реестр профилей серверов (для формы входа UI): известные серверы и последний
    // использованный. ADR-079: путь задаётся createStandaloneApp (`<home>/profiles.json`);
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
    const providerCache = deps.getProviderCache();
    const modelCache = deps.getModelCache();
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
    const providerCache = deps.getProviderCache();
    const modelCache = deps.getModelCache();
    const eventBus = deps.getEventBus();

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
    const localProviderNames = new Set((await deps.getProviderStore().list()).map((p) => p.name));

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
  /**
   * Watcher фактической живости подключения: создаётся (но НЕ стартует) здесь —
   * запуск/остановка идут через хэндл приложения (`startConnectionWatcher` при
   * `server.listen`, `stopConnectionWatcher` при graceful shutdown), чтобы тесты
   * app не держали фоновых интервалов.
   */
  function createConnectionWatcher(): ConnectionWatcher {
    return new ConnectionWatcher({
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
  }

  return {
    getHybridState,
    connectRemote,
    connectRemoteFromSaved,
    connectRemoteWithApiKey,
    disconnectRemote,
    rememberServer,
    logoutRemote,
    /** Имена активных remote-зеркал провайдеров (политика `providerLoader`). */
    getActiveRemoteProviderNames: () => activeRemoteProviderNames,
    /** Модели активных remote-зеркал (роут `/api/v2/models` в гибриде). */
    getActiveRemoteModels: () => activeRemoteModels,
    /** Политика «все LLM — через сервер» (активна при подключении и `remoteLlm !== 'local'`). */
    isBlockLocalProviders: () => blockLocalProviders,
    /** Текущий мост событий (создаётся/обновляется в `applyConnected`) — для stop() при shutdown. */
    getRemoteEventBridge: () => activeBridge,
    createConnectionWatcher,
  };
}
