/**
 * PROP-125 §2: источник состава серверных MCP-серверов гибрида
 * (режимы `relay` и `tools`).
 *
 * Локальный core не знает серверный реестр MCP: состав приходит по
 * HTTP-контракту backend'а (`GET /api/v2/mcp/remote/servers`). Здесь —
 * discovery-слой, по образцу `ExecutorMcpSource` (ADR-077):
 *
 * - **TTL 120 с** — ленивое обновление при обращении (`ensureFresh`);
 * - **пауза 15 с после неудачи** — как у источника исполнителя: типичная
 *   причина пустого снимка — временная недоступность backend'а, полный TTL
 *   скрывал бы серверы на две минуты после реконнекта;
 * - **ошибка не ломает ход**: `ensureFresh` не бросает — состав сохраняется
 *   (имена/метаданные), все серверы помечаются `down` с причиной, а
 *   `offlineReason` объясняет, что произошло (решение 4 владельца: «показывать
 *   ошибку с причиной», а не молча убирать серверы);
 * - **backend не подключён** (`getClient()` → `null`) — тот же офлайн-снимок:
 *   локальный core не должен падать из-за отсутствия гибридного backend'а;
 * - **фича не поддерживается** (`features.remoteMcp` отсутствует у старого
 *   backend'а) — запросов нет, снимок пуст (PROP-125 §3, fail-closed);
 * - `close()` — остановка источника.
 *
 * **Режим доставки** (PROP-125 §0, `resolveRemoteMcpMode`): `relay` —
 * полноценный MCP-клиент на `/api/v2/mcp/relay/:name` (Bearer гибрида
 * подставляется на каждый запрос), `tools` — tool-level proxy
 * (`/api/v2/mcp/remote/*`). Неудачный relay — **всегда** деградация в
 * `tools` с причиной в статусе (решение 8 владельца), а не отказ.
 *
 * Серверы помечаются `origin: 'remote'` — это **runtime-записи**: они не
 * персистятся в реестр `McpRegistryStore` и не редактируются пользователем.
 * Проводка в `McpManager` — следующий этап (T3a-2).
 */

import type { McpRemoteMode, RemoteMcpServerInfo } from '@itphx/synth-shared';
import { warning } from '../../logger.js';
import { egressFetch } from '../../security/tls.js';
import { McpClient, type McpClientLike, type McpToolDef, type McpToolResult } from './client.js';
import {
  RemoteBackendMcpClient,
  type RemoteMcpBackendApi,
} from './remote-backend-mcp-client.js';

/** TTL снимка состава серверов, мс (как у источника исполнителя). */
export const REMOTE_MCP_SOURCE_TTL_MS = 120_000;

/**
 * Пауза перед повтором **неудачного** discovery, мс.
 *
 * Как и у `EXECUTOR_MCP_SOURCE_RETRY_MS`: после временной недоступности
 * backend'а полный TTL (120 с) оставил бы локальные сессии без серверных
 * MCP-тулов на две минуты после реконнекта.
 */
export const REMOTE_MCP_SOURCE_RETRY_MS = 15_000;

/** Текст офлайн-состояния: backend гибрида не подключён. */
export const REMOTE_MCP_OFFLINE_REASON = 'Гибридный backend не подключён';

/** Серверный MCP-сервер в снимке источника. */
export interface RemoteMcpServerSnapshot {
  name: string;
  status: 'idle' | 'up' | 'down';
  toolCount: number;
  /** Системный мастер-флаг сервера (`false` — сервер выключен администратором). */
  enabled: boolean;
  /** «Включён по умолчанию» — сид `project.mcp` для новых проектов. */
  enabledByDefault: boolean;
  /** Режим доставки в локальные сессии (PROP-125 §0). */
  remoteMode: McpRemoteMode;
  /**
   * Транспорт сервера на стороне backend'а (`stdio`/`sse`/`http`).
   *
   * Нужен для разбора режима `auto` (PROP-125 §0): `http`/`sse` → релей,
   * `stdio` → tool-level proxy. Значение приходит из ответа `/mcp/remote/servers`.
   */
  type: 'stdio' | 'sse' | 'http';
  /** Причина последней ошибки (без секретов). */
  error?: string;
  /** Инструкции сервера (ADR-071 §2.2), если сервер их отдал. */
  instructions?: string;
}

/**
 * Фактический режим доставки серверного MCP-сервера (PROP-125 §0).
 *
 * - `relay`/`tools` — как записано в реестре (`remoteMode`);
 * - `auto` — `relay` для `http`/`sse`, `tools` для `stdio`;
 * - снимка нет (сервер ещё не discovered) — `tools` (fail-safe: режим
 *   `tools` работает на любом транспорте, релей требует HTTP-эндпоинта).
 */
export function resolveRemoteMcpMode(
  snapshot: Pick<RemoteMcpServerSnapshot, 'remoteMode' | 'type'> | undefined,
): 'relay' | 'tools' {
  if (!snapshot) return 'tools';
  if (snapshot.remoteMode === 'relay') return 'relay';
  if (snapshot.remoteMode === 'tools') return 'tools';
  // `auto`: сетевые серверы умеют релей, `stdio` — только tool-level proxy.
  return snapshot.type === 'http' || snapshot.type === 'sse' ? 'relay' : 'tools';
}

/** Параметры источника. */
export interface RemoteMcpSourceOptions {
  /**
   * Текущий клиент гибрида; `null` — backend не подключён.
   *
   * Геттер (а не значение): клиент появляется и исчезает при реконнекте, а
   * фасад клиента сервера берёт его **на каждый вызов** — иначе после
   * дисконнекта остался бы клиент с мёртвым backend'ом.
   */
  getClient: () => RemoteMcpBackendApi | null;
  /** TTL снимка, мс (по умолчанию 120 000). */
  ttlMs?: number;
  /** Пауза перед повтором после неудачного discovery, мс (по умолчанию 15 000). */
  retryMs?: number;
  /**
   * Транспорт релея (тесты/кастомный `fetch`).
   *
   * По умолчанию — `egressFetch` (ADR-099: единый источник доверия TLS/CA).
   */
  fetchImpl?: typeof fetch;
}

/**
 * Источник состава серверных MCP-серверов гибрида.
 *
 * Экземпляр — зависимость сборки приложения (не process-глобальный синглтон):
 * создаётся при подключении к backend'у, живёт столько же, сколько процесс
 * (инвариант 24).
 */
export class RemoteMcpSource {
  private readonly _getClient: () => RemoteMcpBackendApi | null;
  private readonly _ttlMs: number;
  private readonly _retryMs: number;
  /** PROP-125: транспорт релея (по умолчанию — `egressFetch`, ADR-099). */
  private readonly _fetchImpl: typeof fetch | undefined;
  private _servers = new Map<string, RemoteMcpServerSnapshot>();
  /**
   * PROP-125 (решение 8): причины деградации `relay → tools` по серверам.
   *
   * Сервер не исчезает при неудачном relay — он продолжает работать в
   * режиме `tools`, а причина видна в статусе (`getServerError`).
   */
  private readonly _degraded = new Map<string, string>();
  /**
   * Последний известный адрес backend'а гибрида.
   *
   * Нужен, когда клиент временно отсутствует (дисконнект): адрес релея
   * остаётся прежним, а запрос всё равно не уйдёт — реле-транспорт бросит
   * «Гибридный backend не подключён» (fail-closed, без обращения наружу).
   */
  private _backendUrl: string | undefined;
  /** Время последнего успешного снимка (0 — успешного снимка ещё не было). */
  private _snapshotAt = 0;
  /** Время последней неудачи discovery (0 — неудач не было). */
  private _failedAt = 0;
  /** Ближайший момент повтора после неудачи (0 — не задано). */
  private _retryAt = 0;
  /** Причина офлайна (backend не подключён / discovery провалился). */
  private _offlineReason: string | undefined;
  private _closed = false;
  /**
   * PROP-125 §3: поддержка фичи серверных MCP в backend'е.
   *
   * Старый backend без `features.remoteMcp` — фича **молча** выключена
   * (fail-closed, без шума в UI): источник не ходит в backend и держит
   * пустой снимок. Флаг ставится при подключении гибрида
   * (`applyConnected` → `setSupported`) и снимается при отключении.
   */
  private _supported = false;

  constructor(opts: RemoteMcpSourceOptions) {
    this._getClient = opts.getClient;
    this._ttlMs = opts.ttlMs ?? REMOTE_MCP_SOURCE_TTL_MS;
    this._retryMs = opts.retryMs ?? REMOTE_MCP_SOURCE_RETRY_MS;
    this._fetchImpl = opts.fetchImpl;
  }

  get closed(): boolean {
    return this._closed;
  }

  /**
   * Поддерживает ли backend серверные MCP (`features.remoteMcp`)?
   *
   * `false` — фича выключена: источник не делает запросов и держит пустой
   * снимок (PROP-125 §3, «старый backend → фича молча выключена»).
   */
  get isSupported(): boolean {
    return this._supported;
  }

  /**
   * Включить/выключить фичу серверных MCP (PROP-125 §3).
   *
   * - `false` — снимок **очищается** (состав, метки офлайна, причины
   *   деградации и повтора сброшены): после отключения гибрида серверных MCP
   *   в мире не остаётся;
   * - `true` (переход) — сбрасывается время снимка, поэтому следующий
   *   `ensureFresh` перечитывает состав у backend'а.
   */
  setSupported(value: boolean): void {
    if (!value) {
      this._supported = false;
      this._clearSnapshot();
      this._degraded.clear();
      return;
    }
    if (this._supported) return;
    this._supported = true;
    // Включение поддержки — следующий `ensureFresh` перечитывает состав.
    this._snapshotAt = 0;
  }

  /** Причина офлайна (backend не подключён или discovery провалился). */
  get offlineReason(): string | undefined {
    return this._offlineReason;
  }

  /** Ближайший момент повтора discovery после неудачи (0 — не задано). */
  get nextRetryAt(): number {
    return this._retryAt;
  }

  /** Снимок состава (без I/O): что известно на момент последнего refresh. */
  listServers(): RemoteMcpServerSnapshot[] {
    return [...this._servers.values()]
      .map((server) => ({ ...server }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Сервер по имени из снимка. */
  getServer(name: string): RemoteMcpServerSnapshot | undefined {
    const server = this._servers.get(name);
    return server ? { ...server } : undefined;
  }

  /** Серверы, включённые по умолчанию (сид `project.mcp` для новых проектов). */
  getDefaultServerNames(): string[] {
    return this.listServers()
      .filter((server) => server.enabledByDefault === true)
      .map((server) => server.name);
  }

  /**
   * Причина недоступности/деградации сервера (без секретов).
   *
   * PROP-125 (решение 8): сначала — причина деградации `relay → tools`
   * (релей не поднялся, сервер продолжает работать в режиме `tools`), затем —
   * причина со стороны backend'а (`error` в снимке: сервер упал/офлайн).
   * Сервера без проблемы — `undefined`.
   */
  getServerError(name: string): string | undefined {
    return this._degraded.get(name) ?? this._servers.get(name)?.error;
  }

  /**
   * Снимок просрочен (или его ещё нет)?
   *
   * - **фича выключена** — снимок не просрочен: обновлять нечего, запросов
   *   не будет. Иначе `McpManager` гонял бы `refreshRemoteServers` на каждом
   *   ходе вхолостую (PROP-125 §3);
   * - **неудачный discovery** (backend недоступен / не подключён) — короткая
   *   пауза (`retryMs`, 15 с) вместо полного TTL: иначе офлайн-состояние
   *   дёргало бы backend на каждом `ensureToolsLoaded` (ветка `_failedAt`
   *   была недостижимой — `_goOffline` обнуляет `_snapshotAt`, и проверка
   *   «снимка нет» срабатывала раньше). Как у источника исполнителя
   *   (`EXECUTOR_MCP_SOURCE_RETRY_MS`);
   * - **валидного снимка нет** (`_snapshotAt === 0`: первый запрос) — состав
   *   устарел сразу: снимка всё равно нет;
   * - **успешный снимок** — обычный TTL (`ttlMs`).
   */
  isStale(now: number = Date.now()): boolean {
    // Фича выключена — снимка нет и не будет (запросы не делаются).
    if (!this._supported) return false;
    // После неудачи — короткая пауза (retryMs), а не полный TTL.
    if (this._failedAt !== 0) return now >= this._retryAt;
    if (this._snapshotAt === 0) return true;
    return now >= this._snapshotAt + this._ttlMs;
  }

  /**
   * Обновить снимок состава, если он просрочен (ленивое обновление).
   *
   * **Не бросает**: недоступный backend — это офлайн-состояние, а не ошибка
   * хода. Снимок при этом сохраняется (имена и метаданные), а все серверы
   * помечаются `down` с причиной — по решению 4 владельца серверы остаются
   * видимыми с причиной, а не исчезают молча.
   */
  async ensureFresh(): Promise<void> {
    if (this._closed) return;
    if (!this._supported) {
      // Фича выключена (старый backend без `features.remoteMcp`) — запросов
      // не делаем, снимок пуст (PROP-125 §3).
      this._clearSnapshot();
      return;
    }
    if (!this.isStale()) return;

    const client = this._getClient();
    if (!client) {
      this._goOffline(REMOTE_MCP_OFFLINE_REASON);
      return;
    }

    let servers: RemoteMcpServerInfo[];
    try {
      servers = await client.getRemoteMcpServers();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warning('MCP', `Не удалось получить состав серверных MCP-серверов: ${reason}`);
      this._goOffline(reason);
      return;
    }

    this._servers = new Map(
      (Array.isArray(servers) ? servers : [])
        .filter((server) => server && typeof server.name === 'string' && server.name.length > 0)
        .map((server) => [server.name, toSnapshot(server)] as const),
    );
    // Сервер исчез из состава — его причина деградации больше неактуальна.
    // Причины по оставшимся серверам **не** сбрасываются: активная деградация
    // (релей не поднялся) живёт до успешного восстановления или снятия фичи.
    for (const degradedName of [...this._degraded.keys()]) {
      if (!this._servers.has(degradedName)) this._degraded.delete(degradedName);
    }
    this._snapshotAt = Date.now();
    this._failedAt = 0;
    this._retryAt = 0;
    this._offlineReason = undefined;
  }

  /**
   * Клиент одного серверного MCP-сервера (поверхность `McpClientLike`).
   *
   * **Режим доставки** (PROP-125 §0) — по снимку сервера:
   * - `relay` — обычный MCP-клиент на `/api/v2/mcp/relay/:name` (Streamable
   *   HTTP, Bearer гибрида подставляется на каждый запрос);
   * - `tools` — tool-level proxy (`/api/v2/mcp/remote/*`).
   *
   * Для режима `relay` клиент **всегда** обёрнут в `RemoteMcpFallbackClient`:
   * неудачный handshake — не отказ, а деградация в `tools` с причиной
   * (решение 8 владельца).
   *
   * Клиенту передаётся **фасад**: он берёт текущего клиента гибрида на
   * каждый вызов. Иначе после дисконнекта/реконнекта остался бы клиент с
   * мёртвым backend'ом (или, наоборот, новый сервер не был бы виден).
   */
  createClient(name: string): McpClientLike {
    const mode = resolveRemoteMcpMode(this._servers.get(name));
    if (mode === 'tools') {
      return new RemoteBackendMcpClient(name, this._facade());
    }
    return new RemoteMcpFallbackClient(
      name,
      () => this._createRelayClient(name),
      () => new RemoteBackendMcpClient(name, this._facade()),
      {
        onDegraded: (reason) => {
          this._degraded.set(name, reason);
        },
        onRecovered: () => {
          this._degraded.delete(name);
        },
      },
    );
  }

  /**
   * MCP-клиент релея: обычный `McpClient` на `/api/v2/mcp/relay/:name`.
   *
   * Создаётся **в момент подключения** (не заранее): адрес backend'а и токен
   * берутся свежими — гибрид мог переподключиться к другому адресу.
   */
  private _createRelayClient(name: string): McpClientLike {
    const backendUrl = this._resolveBackendUrl();
    if (!backendUrl) {
      throw new Error(REMOTE_MCP_OFFLINE_REASON);
    }
    return new McpClient(
      name,
      {
        type: 'http',
        description: `MCP-сервер гибрида "${name}" (relay, PROP-125)`,
        url: `${backendUrl}/api/v2/mcp/relay/${encodeURIComponent(name)}`,
      },
      { fetch: this._relayFetch() },
    );
  }

  /**
   * Транспорт релея: Bearer гибрида подставляется **на каждый запрос**.
   *
   * Токен берётся у текущего клиента (он обновляется в рантайме) — статический
   * заголовок протух бы. Backend не подключён — запрос не уходит
   * вовсе (fail-closed): ни сети, ни утечки токена.
   */
  private _relayFetch(): typeof fetch {
    const baseFetch: typeof fetch = this._fetchImpl ?? egressFetch;
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const api = this._getClient();
      if (!api) throw new Error(REMOTE_MCP_OFFLINE_REASON);
      const token = await api.getAccessToken();
      const headers = new Headers(init?.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return baseFetch(input, { ...(init ?? {}), headers });
    };
  }

  /** Адрес backend'а гибрида (текущий или последний известный). */
  private _resolveBackendUrl(): string | undefined {
    const url = this._getClient()?.backendUrl ?? this._backendUrl;
    if (url) this._backendUrl = url;
    return url;
  }

  /** Остановить источник (снимок сбрасывается; соединений не держим). */
  close(): void {
    this._closed = true;
    this._clearSnapshot();
    this._degraded.clear();
  }

  /**
   * Полный сброс снимка: состав, метки времени и причина офлайна.
   *
   * Используется при выключении фичи (`setSupported(false)`) и при остановке
   * источника (`close()`) — после него следующий `ensureFresh` читает состав
   * заново (если фича включена).
   */
  private _clearSnapshot(): void {
    this._servers.clear();
    this._snapshotAt = 0;
    this._failedAt = 0;
    this._retryAt = 0;
    this._offlineReason = undefined;
  }

  /**
   * Фасад API backend'а для клиента сервера: текущий клиент — на каждый вызов.
   *
   * Нет клиента (backend не подключён) — ошибка с понятным текстом: клиент
   * сервера не должен молча «успешно» ничего не сделать.
   */
  private _facade(): RemoteMcpBackendApi {
    const getClient = this._getClient;
    const require = (): RemoteMcpBackendApi => {
      const client = getClient();
      if (!client) throw new Error(REMOTE_MCP_OFFLINE_REASON);
      return client;
    };
    return {
      get backendUrl(): string {
        return getClient()?.backendUrl ?? '';
      },
      getAccessToken: () => require().getAccessToken(),
      getRemoteMcpServers: () => require().getRemoteMcpServers(),
      getRemoteMcpTools: (server: string) => require().getRemoteMcpTools(server),
      callRemoteMcp: (body) => require().callRemoteMcp(body),
    };
  }

  /**
   * Офлайн-снимок: имена и метаданные прошлого снимка сохраняются, все
   * серверы помечаются `down` с причиной.
   */
  private _goOffline(reason: string): void {
    const offline = new Map<string, RemoteMcpServerSnapshot>();
    for (const server of this._servers.values()) {
      offline.set(server.name, { ...server, status: 'down', error: reason });
    }
    this._servers = offline;
    this._offlineReason = reason;
    // Валидного снимка нет — следующий `ensureFresh` проверит backend снова,
    // но не раньше окна повтора (`retryMs`, см. `isStale`).
    const now = Date.now();
    this._snapshotAt = 0;
    this._failedAt = now;
    this._retryAt = now + this._retryMs;
  }
}

/** Ответ сервера → снимок источника (нормализация полей). */
function toSnapshot(server: RemoteMcpServerInfo): RemoteMcpServerSnapshot {
  const status = server.status === 'up' || server.status === 'down' ? server.status : 'idle';
  const toolCount = Number.isFinite(server.toolCount) && server.toolCount > 0 ? server.toolCount : 0;
  const type = server.type === 'sse' || server.type === 'http' ? server.type : 'stdio';
  return {
    name: server.name,
    status,
    toolCount,
    enabled: server.enabled !== false,
    enabledByDefault: server.enabledByDefault === true,
    remoteMode: server.remoteMode,
    type,
    ...(server.error ? { error: server.error } : {}),
    ...(server.instructions ? { instructions: server.instructions } : {}),
  };
}

/** Колбэки обёртки релея (PROP-125, решение 8). */
export interface RemoteMcpFallbackHooks {
  /** Релей не поднялся — сервер деградировал в `tools`; причина — для статуса. */
  onDegraded: (reason: string) => void;
  /** Релей поднялся — активная деградация снята. */
  onRecovered: () => void;
}

/**
 * Клиент серверного MCP-сервера с деградацией `relay → tools`.
 *
 * PROP-125 (решение 8 владельца): **неудачный relay — всегда деградация** в
 * tool-level proxy, а не отказ. Сервер остаётся доступным (инструменты
 * работают через `/api/v2/mcp/remote/*`), а причина неудачи видна в статусе
 * (`getServerError`) — «молчаливого» исчезновения сервера нет.
 *
 * Клиенты создаются **лениво** (фабриками): адрес backend'а и токен берутся
 * в момент подключения — гибрид мог переподключиться.
 */
export class RemoteMcpFallbackClient implements McpClientLike {
  private readonly _name: string;
  private readonly _createRelay: () => McpClientLike;
  private readonly _createTools: () => McpClientLike;
  private readonly _hooks: RemoteMcpFallbackHooks;
  /** Активный клиент (релей или tools). */
  private _active: McpClientLike | null = null;

  constructor(
    name: string,
    createRelay: () => McpClientLike,
    createTools: () => McpClientLike,
    hooks: RemoteMcpFallbackHooks,
  ) {
    this._name = name;
    this._createRelay = createRelay;
    this._createTools = createTools;
    this._hooks = hooks;
  }

  get name(): string {
    return this._name;
  }

  get isConnected(): boolean {
    return this._active?.isConnected === true;
  }

  get tools(): McpToolDef[] {
    return this._active?.tools ?? [];
  }

  /** ADR-071 §2.2: инструкции активного сервера (релей или tools). */
  get instructions(): string | undefined {
    return this._active?.instructions;
  }

  /**
   * Подключение: сначала релей, при ошибке — деградация в `tools`.
   *
   * Ошибка `tools`-клиента (backend недоступен) пробрасывается — сервер без
   * backend'а не подключится ни в одном режиме; причина relay при этом уже
   * записана в источник (`onDegraded`).
   */
  async connect(): Promise<void> {
    if (this._active?.isConnected) return;

    try {
      const relay = this._createRelay();
      await relay.connect();
      this._active = relay;
      this._hooks.onRecovered();
      return;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warning('MCP', `MCP-сервер "${this._name}": relay недоступен (${reason}) — режим tools`);
      this._hooks.onDegraded(reason);
    }

    const tools = this._createTools();
    await tools.connect();
    this._active = tools;
  }

  async disconnect(): Promise<void> {
    const active = this._active;
    this._active = null;
    if (active) await active.disconnect();
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const active = this._active;
    if (!active) {
      return { content: `MCP-сервер "${this._name}" не подключён`, isError: true };
    }
    return active.callTool(name, args, meta);
  }
}
