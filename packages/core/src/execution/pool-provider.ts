/**
 * Провайдеры пулов исполнения (PROP-135, Ф4b-1).
 *
 * ## Зачем
 *
 * Ф4a (роутер портов) умел выбирать порт **по профилю**: адреса исполнителей
 * известны из конфигурации, порты создаются на старте. Динамические пулы
 * (проектный/сессионный под, отдельный исполнитель на проект) требуют
 * другого: адрес пула известен **только в момент обращения** — его даёт
 * provisioner (сервис, который сам поднимает/назначает исполнителей).
 *
 * Этот модуль вводит **провайдер пулов** — источник адреса и токена пула:
 *
 * - `StaticExecutionPoolProvider` — пулы из конфигурации (адрес профиля);
 * - `HttpExecutionPoolProvider` — пулы от provisioner'а по HTTP.
 *
 * ## Ключ пула
 *
 * Ключ — **то, что различает пулы**: область (`instance`/`project`/`session`),
 * идентификатор области (id проекта/сессии; у `instance` — нет), класс
 * (`exec`/`browser`/`sandbox`) и профиль. Строковое представление
 * (`poolKeyString`) — **канонический** идентификатор пула: он идёт в
 * provisioner по проводу и служит ключом кэша портов в роутере.
 *
 * ## Секреты
 *
 * Токен provisioner'а — **путь/ссылка**, а не значение (инвариант 13):
 * значение читается из файла (`readExecutorToken`) в момент обращения и
 * **никогда** не попадает в текст ошибок, логи и ключи пулов.
 */

import type {
  ExecutionProfileClass,
  ExecutionProfileNetwork,
  ExecutionProfileResourceList,
  ExecutionProfileResources,
  ExecutionProfileToleration,
  ResolvedExecutionProfile,
  ResolvedExecutionRemoteConfig,
} from '@itphx/synth-shared';
import { egressFetch, type FetchLike } from '../security/tls.js';
import { readExecutorToken } from './remote.js';

/** Область пула: общий пул инстанса, проектный или сессионный. */
export type ExecutionPoolScope = 'instance' | 'project' | 'session';

/**
 * Класс пула: обычные команды, браузерная сессия либо разовый песочный запуск.
 *
 * `sandbox` (PROP-135 слайс 5a) — отдельный профиль исполнения для
 * `sandbox_exec`: другой образ/набор программ, отдельный пул и собственная
 * политика провижининга. Ключ пула поэтому различает классы — иначе
 * песочный запуск занял бы порт обычного пула.
 */
export type ExecutionPoolClass = 'exec' | 'browser' | 'sandbox';

/**
 * Ключ пула исполнения.
 *
 * `id` обязателен для `project`/`session` (иначе ключи разных проектов
 * совпали бы — это ломало бы изоляцию пулов).
 */
export interface ExecutionPoolKey {
  /** Область пула. */
  scope: ExecutionPoolScope;
  /** Идентификатор области (id проекта/сессии); у `instance` — нет. */
  id?: string;
  /** Класс пула. */
  class: ExecutionPoolClass;
  /** Имя профиля исполнения. */
  profile: string;
  /**
   * Относительный путь внутри PVC workspace (`proj-slug`,
   * `proj-slug/.worktrees/feature`) — что монтировать в пул как рабочее
   * дерево (PROP-135 Ф4b-2b-2a).
   *
   * В ключ пула (`poolKeyString`) **не** входит: пул остаётся один на
   * область (проект/сессию), а subPath — свойство монтирования тома, которое
   * provisioner получает из тела `POST /v1/pools`. Не задан — монтируется
   * корень тома (поведение для standalone-проектов вне `workspacesRoot`).
   */
  workspaceSubPath?: string;
}

/**
 * Каноническая строка ключа пула: `project:<id>:exec:<profile>`,
 * `session:<id>:browser:<profile>`, `session:<id>:sandbox:<profile>`,
 * `instance:exec:<profile>`.
 *
 * Единое представление нужно в двух местах: провод к provisioner'у (путь
 * `POST /v1/pools/{key}`) и кэш портов роутера (один порт на ключ).
 *
 * @throws Error — у `project`/`session` без `id` (fail-closed: ключ без
 *   идентификатора совпал бы с ключом чужого пула).
 */
export function poolKeyString(key: ExecutionPoolKey): string {
  const profile = (key.profile ?? '').trim() || 'default';
  const cls = key.class;
  if (key.scope === 'instance') {
    return `instance:${cls}:${profile}`;
  }
  const id = (key.id ?? '').trim();
  if (id === '') {
    throw new Error(
      `execution pool key for scope "${key.scope}" requires an id (project/session pool isolation)`,
    );
  }
  return `${key.scope}:${id}:${cls}:${profile}`;
}

/**
 * Публичное описание пула исполнения (PROP-135 Ф6b-1) — диагностика для
 * admin-API/UI.
 *
 * **Без адреса и токена**: `url` пула и его токен — секреты доступа к
 * исполнителю (инвариант 13), наружу они не отдаются. Ключ пула — только если
 * его знает провайдер (у `static` пулы адресуются профилем — ключа нет).
 */
export interface PoolInfo {
  /** Канонический ключ пула (`poolKeyString`); у `static` — отсутствует. */
  key?: string;
  /** Имя профиля исполнения пула. */
  profile: string;
  /** Состояние: задан профилем (`configured`), готов (`ready`), снимается (`draining`). */
  state: 'configured' | 'ready' | 'draining';
  /** Когда пул выдан (ISO-8601). */
  createdAt?: string;
  /** Когда пул последний раз использовался (ISO-8601). */
  lastUsedAt?: string;
}

/**
 * Разбор канонического ключа пула (`poolKeyString`) обратно в ключ.
 *
 * Нужен admin-API (`POST /pools/:key/drain`, `DELETE /pools/:key`): клиент
 * присылает **строку** ключа (как в протоколе provisioner'а), а методы
 * провайдера принимают объект. Формат: `instance:<class>:<profile>` либо
 * `<scope>:<id>:<class>:<profile>`; профиль — остаток после класса (имя может
 * содержать `:`).
 *
 * @throws Error — пустая строка, неизвестная область/класс, пустой id или профиль.
 */
export function parsePoolKey(key: string): ExecutionPoolKey {
  const raw = (key ?? '').trim();
  const parts = raw.split(':');
  const scope = parts[0];
  let parsed: ExecutionPoolKey | null = null;
  if (scope === 'instance' && parts.length >= 3) {
    parsed = {
      scope: 'instance',
      class: toPoolClass(parts[1]),
      profile: parts.slice(2).join(':'),
    };
  } else if ((scope === 'project' || scope === 'session') && parts.length >= 4) {
    const id = parts[1] ?? '';
    if (id.trim() === '') throw new Error(`execution pool key "${raw}" has no scope id`);
    parsed = {
      scope,
      id,
      class: toPoolClass(parts[2]),
      profile: parts.slice(3).join(':'),
    };
  }
  if (!parsed) throw new Error(`invalid execution pool key "${raw}"`);
  if (parsed.profile.trim() === '') {
    throw new Error(`execution pool key "${raw}" has no profile`);
  }
  return parsed;
}

/** Класс пула из сегмента ключа; неизвестный — ошибка (fail-closed). */
function toPoolClass(value: string | undefined): ExecutionPoolClass {
  if (value === 'exec' || value === 'browser' || value === 'sandbox') return value;
  throw new Error(`invalid execution pool class "${value ?? ''}"`);
}

/**
 * Метка времени provisioner'а (мс epoch либо ISO-строка) → ISO-8601.
 *
 * Невалидное/отсутствующее значение — `undefined` (поле не отдаём): пул без
 * времени жизни всё равно показывается, «битая» дата наружу не пойдёт.
 */
function toIsoTime(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const ms = Date.parse(trimmed);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return undefined;
}

/** Непустая строка из неизвестного значения либо `undefined`. */
function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Список ресурсов профиля из ответа provisioner'а (только строки, `undefined` — пусто). */
function toProfileResourceList(raw: unknown): ExecutionProfileResourceList | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const list: ExecutionProfileResourceList = {};
  const cpu = toOptionalString(record.cpu);
  const memory = toOptionalString(record.memory);
  const ephemeralStorage = toOptionalString(record.ephemeralStorage);
  if (cpu !== undefined) list.cpu = cpu;
  if (memory !== undefined) list.memory = memory;
  if (ephemeralStorage !== undefined) list.ephemeralStorage = ephemeralStorage;
  return Object.keys(list).length > 0 ? list : undefined;
}

/** Ресурсы профиля (`requests`/`limits`); пустой блок не отдаётся. */
function toProfileResources(raw: unknown): ExecutionProfileResources | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const requests = toProfileResourceList(record.requests);
  const limits = toProfileResourceList(record.limits);
  if (requests === undefined && limits === undefined) return undefined;
  return {
    ...(requests !== undefined ? { requests } : {}),
    ...(limits !== undefined ? { limits } : {}),
  };
}

/**
 * Запись `GET /v1/profiles` → метаданные профиля.
 *
 * Неизвестная/битая запись пропускается, если у неё нет имени (нечего
 * показывать). Значения нормализуются к строкам: чужой/старый provisioner не
 * должен ломать admin-API.
 */
function toProfileInfo(entry: unknown): ExecutionProfileInfo | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const name = toOptionalString(record.name);
  if (name === undefined) return null;
  const description = toOptionalString(record.description);
  const image = toOptionalString(record.image);
  const runtimeClass = toOptionalString(record.runtimeClass);
  const network =
    record.network === 'none' || record.network === 'restricted' || record.network === 'full'
      ? record.network
      : undefined;
  const resources = toProfileResources(record.resources);
  const profileClass =
    record.class === 'exec' || record.class === 'browser' || record.class === 'both'
      ? record.class
      : undefined;
  const mcpServers = toProfileMcpServers(record.mcpServers);
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(image !== undefined ? { image } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(runtimeClass !== undefined ? { runtimeClass } : {}),
    ...(profileClass !== undefined ? { class: profileClass } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
  };
}

/**
 * MCP-серверы из ответа provisioner'а: имя (+ команда/аргументы, если есть).
 *
 * Старая форма — только имена (`'playwright'`); новая — объекты. Env сервера
 * наружу не отдаётся (инвариант 13).
 */
function toProfileMcpServers(raw: unknown): ExecutionProfileMcpServerInfo[] {
  if (!Array.isArray(raw)) return [];
  const servers: ExecutionProfileMcpServerInfo[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const name = entry.trim();
      if (name !== '') servers.push({ name });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { name?: unknown; command?: unknown; args?: unknown };
    const name = toOptionalString(record.name);
    if (name === undefined) continue;
    const command = toOptionalString(record.command);
    const args = Array.isArray(record.args)
      ? record.args.filter((item): item is string => typeof item === 'string')
      : [];
    servers.push({
      name,
      ...(command !== undefined ? { command } : {}),
      ...(args.length > 0 ? { args } : {}),
    });
  }
  return servers;
}

/** Адрес (и необязательный токен) пула исполнения. */
export interface ExecutionPoolRef {
  /** Адрес исполнителя пула (`http://…`). */
  url: string;
  /** Токен доступа к пулу (значение, не путь) — если провайдер его выдал. */
  token?: string;
}

// Типы ресурсов/сетевого класса — общие с конфигурацией (`@itphx/synth-shared`);
// реэкспорт сохраняет публичную поверхность core.
export type {
  ExecutionProfileNetwork,
  ExecutionProfileResourceList,
  ExecutionProfileResources,
} from '@itphx/synth-shared';

/**
 * Метаданные профиля исполнения для admin-API/UI.
 *
 * **Без секретов**: env профиля, команды/аргументы/env MCP-серверов, адреса и
 * токены пулов не отдаются (инвариант 13). У MCP-серверов отдаются **имя,
 * команда и аргументы** — env сервера наружу не уходит.
 * Незаданное поле — «неизвестно»: у `static` метаданные берутся из
 * `execution.remote.profiles`, у `http` — от provisioner'а.
 */
export interface ExecutionProfileInfo {
  /** Имя профиля. */
  name: string;
  /** Человекочитаемое описание (если задано). */
  description?: string;
  /** Образ пула. */
  image?: string;
  /** Сетевой класс профиля. */
  network?: ExecutionProfileNetwork;
  /** Ресурсы контейнера пула. */
  resources?: ExecutionProfileResources;
  /** `runtimeClassName` пода. */
  runtimeClass?: string;
  /** Класс профиля (ADR-135, аддендум §11): `exec` | `browser` | `both`. */
  class?: ExecutionProfileClass;
  /** MCP-серверы профиля: имя + команда + аргументы (без env). */
  mcpServers?: ExecutionProfileMcpServerInfo[];
}

/** MCP-сервер профиля в DTO метаданных (без env — инвариант 13). */
export interface ExecutionProfileMcpServerInfo {
  /** Имя MCP-сервера. */
  name: string;
  /** Команда запуска сервера (если известна). */
  command?: string;
  /** Аргументы команды. */
  args?: string[];
}

/** Метаданные профиля (без имени и адресов) — то, что отдаёт admin-API. */
export type ExecutionProfileMetadata = Pick<
  ExecutionProfileInfo,
  'description' | 'image' | 'network' | 'resources' | 'runtimeClass' | 'class' | 'mcpServers'
>;

/**
 * Собрать `ExecutionProfileInfo` из имени и метаданных: незаданные поля
 * **отсутствуют** (не `undefined`-ключи) — DTO остаётся компактным.
 */
export function toExecutionProfileInfo(
  name: string,
  meta: ExecutionProfileMetadata | undefined,
): ExecutionProfileInfo {
  const info: ExecutionProfileInfo = { name };
  if (!meta) return info;
  if (meta.description !== undefined && meta.description !== '') info.description = meta.description;
  if (meta.image !== undefined && meta.image !== '') info.image = meta.image;
  if (meta.network !== undefined) info.network = meta.network;
  if (meta.resources !== undefined) info.resources = meta.resources;
  if (meta.runtimeClass !== undefined && meta.runtimeClass !== '') {
    info.runtimeClass = meta.runtimeClass;
  }
  if (meta.class !== undefined) info.class = meta.class;
  if (meta.mcpServers !== undefined && meta.mcpServers.length > 0) {
    info.mcpServers = meta.mcpServers.map((server) => ({
      name: server.name,
      ...(server.command !== undefined && server.command !== '' ? { command: server.command } : {}),
      ...(server.args !== undefined && server.args.length > 0 ? { args: [...server.args] } : {}),
    }));
  }
  return info;
}

/**
 * Метаданные из эффективного профиля конфигурации (`execution.remote.profiles`).
 * Только заданные поля: пустой профиль даёт `undefined`.
 *
 * MCP-серверы отдаются **без env** (инвариант 13): имя, команда, аргументы.
 */
export function executionProfileMetadata(
  profile: Partial<ExecutionProfileMetadata> | undefined,
): ExecutionProfileMetadata | undefined {
  if (!profile) return undefined;
  const meta: ExecutionProfileMetadata = {};
  if (profile.description !== undefined && profile.description !== '') {
    meta.description = profile.description;
  }
  if (profile.image !== undefined && profile.image !== '') meta.image = profile.image;
  if (profile.network !== undefined) meta.network = profile.network;
  if (profile.resources !== undefined) meta.resources = profile.resources;
  if (profile.runtimeClass !== undefined && profile.runtimeClass !== '') {
    meta.runtimeClass = profile.runtimeClass;
  }
  if (profile.class !== undefined) meta.class = profile.class;
  if (profile.mcpServers !== undefined && profile.mcpServers.length > 0) {
    meta.mcpServers = profile.mcpServers.map((server) => ({
      name: server.name,
      ...(server.command !== undefined && server.command !== '' ? { command: server.command } : {}),
      ...(server.args !== undefined && server.args.length > 0 ? { args: [...server.args] } : {}),
    }));
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Источник пулов исполнения.
 *
 * `ensure` — **обязательный**: он возвращает адрес (и токен) пула, создавая
 * пул при необходимости. Остальные методы необязательны и по контракту
 * **best-effort** (сбой `touch`/`drain`/`release` не должен ломать ход).
 */
export interface ExecutionPoolProvider {
  /** Адрес (и токен) пула по ключу; при необходимости пул создаётся. */
  ensure(key: ExecutionPoolKey): Promise<ExecutionPoolRef>;
  /** Продлить жизнь пула (idle-таймаут на стороне provisioner'а). */
  touch?(key: ExecutionPoolKey): Promise<void>;
  /** Слить пул (освободить исполнителей, но не удалить пул). */
  drain?(key: ExecutionPoolKey): Promise<void>;
  /** Удалить пул (освободить ресурсы). */
  release?(key: ExecutionPoolKey): Promise<void>;
  /**
   * PROP-135 Ф6b-1: список известных пулов для диагностики (без адресов и
   * токенов). Не задан — провайдер не умеет перечислять пулы (admin-API
   * ответит `503 EXECUTION_PROVIDER_UNAVAILABLE`).
   */
  list?(): Promise<PoolInfo[]>;
  /** Диагностика: имя провайдера и известные профили. */
  capabilities?(): Promise<{ provider: string; profiles: string[] }>;
  /**
   * Метаданные профилей (образ/сеть/ресурсы/runtimeClass, имена MCP-серверов)
   * для admin-API/UI. Не задан — провайдер их не умеет (admin-API покажет
   * только имена из каталога конфигурации).
   */
  profilesInfo?(): Promise<ExecutionProfileInfo[]>;
  /**
   * Прогрев образов на нодах (PROP-135, Ф4b-2b): тянет образы в реестр
   * нод кластера, чтобы первый пул с этим образом не ждал скачивания.
   *
   * Не задан — провайдер прогрев не умеет (`static`: адреса пулов заданы
   * извне, подов кластера нет) — admin-API ответит
   * `501 EXECUTION_PROVIDER_UNAVAILABLE`.
   */
  warmImages?(images: string[]): Promise<ExecutionImageWarmResult[]>;
}

/**
 * Структурная проверка: переданное значение — провайдер пулов.
 *
 * По образцу `isExecutionRouter`/`isExecutionPort`: значение может прийти из
 * другой копии модуля, поэтому проверка опирается на форму, а не на класс.
 */
export function isExecutionPoolProvider(value: unknown): value is ExecutionPoolProvider {
  return typeof (value as { ensure?: unknown } | null | undefined)?.ensure === 'function';
}

/**
 * Ошибка провайдера пулов — понятная причина отказа.
 *
 * Отдельный класс (как `ExecutionProfileUnavailableError` в роутере): вызывающий
 * отличает «provisioner недоступен» от «исполнитель не отвечает».
 */
export class ExecutionPoolProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExecutionPoolProviderError';
  }
}

/**
 * Запись статического профиля: адрес пула + метаданные из
 * `execution.remote.profiles` (описания образа/сети/ресурсов).
 */
export type StaticExecutionProfile = { url: string[] } & ExecutionProfileMetadata;

/**
 * Провайдер пулов из конфигурации (PROP-135 Ф4b-1, `provider: static`).
 *
 * Адрес пула известен заранее: это первый адрес профиля. **Изоляции пулов
 * нет** — ключ пула игнорируется: `project`/`session` при `provider: static`
 * дают тот же порт профиля, что и `instance` (документированное ограничение:
 * динамические пулы — только при `provider: http`).
 */
export class StaticExecutionPoolProvider implements ExecutionPoolProvider {
  private readonly _profiles: Record<string, StaticExecutionProfile>;

  constructor(profiles: Record<string, StaticExecutionProfile>) {
    this._profiles = profiles;
  }

  async ensure(key: ExecutionPoolKey): Promise<ExecutionPoolRef> {
    const profile = this._profiles[key.profile];
    const url = profile?.url?.[0]?.trim() ?? '';
    if (url === '') {
      throw new ExecutionPoolProviderError(
        `execution pool provider "static" has no address for profile "${key.profile}" ` +
          `(execution.remote.profiles.${key.profile}.url / execution.remote.url)`,
      );
    }
    // Токена нет: адрес и токен исполнителя читает фабрика порта (токен —
    // путь/ссылка из конфигурации, инвариант 13).
    return { url };
  }

  async capabilities(): Promise<{ provider: string; profiles: string[] }> {
    return { provider: 'static', profiles: Object.keys(this._profiles) };
  }

  /**
   * Метаданные профилей static-провайдера — из каталога конфигурации
   * (`execution.remote.profiles`): имя + заданные поля. Адреса пулов и токены
   * наружу не отдаются.
   */
  async profilesInfo(): Promise<ExecutionProfileInfo[]> {
    return Object.entries(this._profiles).map(([name, profile]) =>
      toExecutionProfileInfo(name, profile),
    );
  }

  /**
   * PROP-135 Ф6b-1: пулы статического провайдера — профили конфигурации.
   *
   * Ключа пула нет (адресация по профилю), состояние — `configured`:
   * физического пула с жизненным циклом у `static` не существует.
   */
  async list(): Promise<PoolInfo[]> {
    return Object.keys(this._profiles).map((profile) => ({
      profile,
      state: 'configured' as const,
    }));
  }
}

/** Опции HTTP-провайдера пулов. */
export interface HttpExecutionPoolProviderOptions {
  /** Адрес provisioner'а (`http://…`). */
  url: string;
  /** **Путь/ссылка** на токен provisioner'а (НЕ значение — инвариант 13). */
  tokenSecret: string;
  /** Таймаут обращения к provisioner'у, мс. */
  timeoutMs: number;
  /**
   * Эффективный каталог профилей инстанца
   * (`execution.remote.profiles` — уже с учётом runtime-секции).
   *
   * Из него собирается `profileSpec` в теле `POST /v1/pools`: под пула
   * поднимается по образу/сети/ресурсам/etc. **профиля инстанса**, а не
   * каталога provisioner'а. Не задан — `profileSpec` не отправляется
   * (provisioner возьмёт свой каталог — обратная совместимость).
   */
  profiles?: Record<string, ResolvedExecutionProfile>;
  /** Транспорт (тесты подменяют `fetch`). */
  fetchImpl?: FetchLike;
}

/**
 * MCP-сервер профиля в форме provisioner'а (`name`/`command`/`args`/`env`).
 *
 * Формат — как у `SYNTH_EXECUTOR_MCP_SERVERS` (ADR-077 шаг B1): исполнитель
 * пула запускает сервер у себя, поэтому нужна команда.
 */
export interface ExecutionPoolProfileMcpServer {
  /** Имя MCP-сервера (уникально в профиле). */
  name: string;
  /** Команда запуска сервера. */
  command: string;
  /** Аргументы команды. */
  args?: string[];
  /** Переменные окружения сервера. */
  env?: Record<string, string>;
}

/**
 * Спецификация профиля пула (`profileSpec` в теле `POST /v1/pools`).
 *
 * Формат — как у профиля provisioner'а (`SYNTH_PROVISIONER_PROFILES`):
 * образ, сетевой класс, ресурсы, runtimeClass, read-only корневая ФС, env и
 * MCP-серверы. `url` **не** переносится: адрес пула — это адрес созданного
 * пода, а не профиль (`static`).
 */
export interface ExecutionPoolProfileSpec {
  /** Образ пула (обязателен: под не из чего поднять). */
  image: string;
  /** Сетевой класс пула. */
  network?: ExecutionProfileNetwork;
  /** Ресурсы контейнера пула (произвольные ключи — например, `nvidia.com/gpu`). */
  resources?: ExecutionProfileResources;
  /** `runtimeClassName` пода. */
  runtimeClass?: string;
  /** Read-only корневая ФС контейнера пула. */
  readOnlyRootFilesystem?: boolean;
  /** Дополнительные переменные окружения пула. */
  env?: Record<string, string>;
  /** MCP-серверы пула (полное описание — с командой). */
  mcpServers?: ExecutionPoolProfileMcpServer[];
  /** Произвольные аннотации пода (`metadata.annotations`). */
  annotations?: Record<string, string>;
  /** Пользовательские метки пода (`metadata.labels`). */
  labels?: Record<string, string>;
  /** `spec.nodeSelector` пода — отбор нод по меткам. */
  nodeSelector?: Record<string, string>;
  /** `spec.tolerations` пода — правила размещения на «tainted» нодах. */
  tolerations?: ExecutionProfileToleration[];
  /** `spec.affinity` пода — passthrough (JSON, ≤8 КиБ). */
  affinity?: Record<string, unknown>;
}

/**
 * Итог прогрева образа (одна запись на образ).
 *
 * `ok: false` — образ не прогрет (таймаут/ошибка API); причина — в `error`
 * (без секретов).
 */
export interface ExecutionImageWarmResult {
  /** Образ, который прогревали. */
  image: string;
  /** Удалось ли прогреть образ. */
  ok: boolean;
  /** Число нод, на которых образ прогрет. */
  nodes: number;
  /** Причина неудачи (без секретов). */
  error?: string;
}

/**
 * Предел числа образов в одном запросе прогрева.
 *
 * Прогрев бьёт по реестру образов на каждой ноде — десяток за раз достаточно,
 * а больше — уже нагрузка на кластер без нужды.
 */
export const EXECUTION_WARM_IMAGES_MAX = 20;

/**
 * Таймаут ожидания готовности DaemonSet'а прогрева на **один образ**, мс.
 *
 * Совпадает с лимитом provisioner'а (`WARM_IMAGE_TIMEOUT_MS`): столько ждёт
 * он сам, столько закладывает control plane на запрос.
 */
export const EXECUTION_WARM_IMAGE_TIMEOUT_MS = 300_000;

/** Запас к таймауту прогона (создание/удаление DaemonSet'а), мс. */
export const EXECUTION_WARM_IMAGE_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Предел длины ссылки на образ (docker-ref).
 */
export const EXECUTION_IMAGE_REF_MAX_LENGTH = 512;

/**
 * Проверка ссылки на образ (docker-ref).
 *
 * Fail-closed: пустая строка, пробелы и недопустимые символы — отказ.
 * Значение уходит в provisioner как имя образа DaemonSet'а прогрева, поэтому
 * мусор отсекаем на границе API.
 */
export function isValidImageRef(image: string): boolean {
  const trimmed = (image ?? '').trim();
  if (trimmed === '' || trimmed.length > EXECUTION_IMAGE_REF_MAX_LENGTH) return false;
  if (/\s/.test(trimmed)) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/.test(trimmed);
}

/**
 * MCP-серверы профиля → форма provisioner'а.
 *
 * Каталог инстанца (`execution.remote.profiles[].mcpServers`) в runtime-секции
 * хранит **полное описание** (команда нужна, чтобы запустить сервер в поде);
 * config-уровень — только имена, и записи без команды отбрасываются: под
 * получит дефолт образа, а не сломанный MCP-сервер.
 */
function toProfileSpecMcpServers(raw: unknown): ExecutionPoolProfileMcpServer[] {
  if (!Array.isArray(raw)) return [];
  const servers: ExecutionPoolProfileMcpServer[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') continue;
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as {
      name?: unknown;
      command?: unknown;
      args?: unknown;
      env?: unknown;
    };
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const command = typeof record.command === 'string' ? record.command.trim() : '';
    if (name === '' || command === '') continue;
    const args = Array.isArray(record.args)
      ? record.args.filter((item): item is string => typeof item === 'string')
      : undefined;
    let env: Record<string, string> | undefined;
    if (typeof record.env === 'object' && record.env !== null) {
      const entries: Array<[string, string]> = [];
      for (const [key, value] of Object.entries(record.env as Record<string, unknown>)) {
        if (typeof value === 'string') entries.push([key, value]);
      }
      if (entries.length > 0) env = Object.fromEntries(entries);
    }
    servers.push({
      name,
      command,
      ...(args !== undefined && args.length > 0 ? { args } : {}),
      ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
    });
  }
  return servers;
}

/**
 * Спецификация профиля пула из эффективного каталога инстанца.
 *
 * @param profile профиль каталога (`execution.remote.profiles[<profile>]`)
 * @returns спецификация либо `undefined` — профиля нет или у него нет
 *   образа (тогда `profileSpec` не отправляется: provisioner возьмёт свой
 *   каталог — обратная совместимость).
 */
export function executionPoolProfileSpec(
  profile: ResolvedExecutionProfile | undefined,
): ExecutionPoolProfileSpec | undefined {
  if (profile === undefined) return undefined;
  const image = (profile.image ?? '').trim();
  if (image === '') return undefined;
  const spec: ExecutionPoolProfileSpec = { image };
  if (profile.network !== undefined) spec.network = profile.network;
  if (profile.resources !== undefined) spec.resources = profile.resources;
  if (profile.runtimeClass !== undefined && profile.runtimeClass !== '') {
    spec.runtimeClass = profile.runtimeClass;
  }
  if (profile.readOnlyRootFilesystem !== undefined) {
    spec.readOnlyRootFilesystem = profile.readOnlyRootFilesystem;
  }
  if (profile.env !== undefined && Object.keys(profile.env).length > 0) {
    spec.env = { ...profile.env };
  }
  // Placement профиля (аннотации/метки/отбор нод) — уходит в pod spec пула.
  if (profile.annotations !== undefined && Object.keys(profile.annotations).length > 0) {
    spec.annotations = { ...profile.annotations };
  }
  if (profile.labels !== undefined && Object.keys(profile.labels).length > 0) {
    spec.labels = { ...profile.labels };
  }
  if (profile.nodeSelector !== undefined && Object.keys(profile.nodeSelector).length > 0) {
    spec.nodeSelector = { ...profile.nodeSelector };
  }
  if (profile.tolerations !== undefined && profile.tolerations.length > 0) {
    spec.tolerations = profile.tolerations.map((toleration) => ({ ...toleration }));
  }
  if (profile.affinity !== undefined && Object.keys(profile.affinity).length > 0) {
    spec.affinity = { ...profile.affinity };
  }
  const mcpServers = toProfileSpecMcpServers(profile.mcpServers);
  if (mcpServers.length > 0) spec.mcpServers = mcpServers;
  return spec;
}

/**
 * Провайдер пулов у provisioner'а (PROP-135 Ф4b-1, `provider: http`).
 *
 * ## Протокол
 *
 * - `POST {url}/v1/pools` — тело `{ key, scope, id, class, profile }`
 *   (+ `workspaceSubPath`, если задан — per-project монтирование PVC,
 *   + `profileSpec`, если эффективный профиль инстанца задал образ),
 *   ответ `{ url, token }`; адрес и токен пула приходят **из ответа**;
 * - `POST {url}/v1/pools/{key}/touch` — продлить жизнь пула (best-effort);
 * - `POST {url}/v1/pools/{key}/drain` — слить пул (best-effort);
 * - `DELETE {url}/v1/pools/{key}` — удалить пул (best-effort);
 * - `GET {url}/v1/pools` — список пулов (диагностика, без адресов и токенов);
 * - `GET {url}/v1/capabilities` — диагностика (`{ provider, profiles }`).
 *
 * `{key}` — **URL-encoded** канонический ключ пула (`poolKeyString`).
 *
 * ## Секреты
 *
 * Bearer-токен читается из файла (`provisioner.tokenSecret`) и **кэшируется
 * на процесс**: значение токена не попадает ни в логи, ни в текст ошибок
 * (в ошибку идёт только путь и техническая причина).
 */
export class HttpExecutionPoolProvider implements ExecutionPoolProvider {
  private readonly _url: string;
  private readonly _tokenSecret: string;
  private readonly _timeoutMs: number;
  /** Эффективный каталог профилей инстанса (источник `profileSpec`). */
  private readonly _profiles: Record<string, ResolvedExecutionProfile>;
  private readonly _fetchImpl: FetchLike | undefined;
  /** Кэш значения токена на процесс (`null` — ещё не читали). */
  private _token: Promise<string> | null = null;

  constructor(opts: HttpExecutionPoolProviderOptions) {
    this._url = opts.url.replace(/\/+$/, '');
    this._tokenSecret = opts.tokenSecret;
    this._timeoutMs = opts.timeoutMs;
    this._profiles = opts.profiles ?? {};
    this._fetchImpl = opts.fetchImpl;
  }

  async ensure(key: ExecutionPoolKey): Promise<ExecutionPoolRef> {
    // Спецификация профиля пула: эффективный профиль инстанса (образ/сеть/
    // ресурсы/…). Её поднимает provisioner вместо своего каталога — так админ
    // задаёт профили в UI, не правя Helm values. Профиля нет или у него нет
    // образа — `profileSpec` не отправляется (provisioner возьмёт свой
    // каталог; старый provisioner поле просто не знает).
    const profileSpec = executionPoolProfileSpec(this._profiles[key.profile]);
    const body = {
      key: poolKeyString(key),
      scope: key.scope,
      ...(key.id ? { id: key.id } : {}),
      class: key.class,
      profile: key.profile,
      // PROP-135 Ф4b-2b-2a: per-project монтирование PVC — поле аддитивное
      // (старый provisioner его проигнорирует и смонтирует корень тома).
      ...(key.workspaceSubPath ? { workspaceSubPath: key.workspaceSubPath } : {}),
      ...(profileSpec !== undefined ? { profileSpec } : {}),
    };
    const response = await this._request('POST', '/v1/pools', body, true);
    const payload = (await response.json().catch(() => null)) as {
      url?: unknown;
      token?: unknown;
    } | null;
    const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
    if (url === '') {
      throw new ExecutionPoolProviderError(
        `execution pool provider "http" returned no pool address for key "${body.key}"`,
      );
    }
    const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
    return token === '' ? { url } : { url, token };
  }

  async touch(key: ExecutionPoolKey): Promise<void> {
    await this._bestEffort('POST', `/v1/pools/${encodeURIComponent(poolKeyString(key))}/touch`);
  }

  async drain(key: ExecutionPoolKey): Promise<void> {
    await this._bestEffort('POST', `/v1/pools/${encodeURIComponent(poolKeyString(key))}/drain`);
  }

  async release(key: ExecutionPoolKey): Promise<void> {
    await this._bestEffort('DELETE', `/v1/pools/${encodeURIComponent(poolKeyString(key))}`);
  }

  /**
   * PROP-135 Ф6b-1: список пулов у provisioner'а (`GET /v1/pools`).
   *
   * Ответ провайдера несёт `url` пула — в DTO он **не попадает** (секрет
   * доступа к исполнителю): наружу идут только ключ, профиль, состояние и
   * метки времени. Записи без профиля пропускаются (нечего показать).
   */
  async list(): Promise<PoolInfo[]> {
    const response = await this._request('GET', '/v1/pools', undefined, true);
    const payload = (await response.json().catch(() => null)) as { pools?: unknown } | null;
    const raw = Array.isArray(payload?.pools) ? payload.pools : [];
    const pools: PoolInfo[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as {
        key?: unknown;
        profile?: unknown;
        state?: unknown;
        createdAt?: unknown;
        lastUsedAt?: unknown;
      };
      const profile = typeof record.profile === 'string' ? record.profile.trim() : '';
      if (profile === '') continue;
      const key = typeof record.key === 'string' ? record.key.trim() : '';
      const createdAt = toIsoTime(record.createdAt);
      const lastUsedAt = toIsoTime(record.lastUsedAt);
      pools.push({
        ...(key !== '' ? { key } : {}),
        profile,
        state:
          record.state === 'draining' ? 'draining' : record.state === 'ready' ? 'ready' : 'configured',
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
      });
    }
    return pools;
  }

  async capabilities(): Promise<{ provider: string; profiles: string[] }> {
    const response = await this._request('GET', '/v1/capabilities', undefined, true);
    const payload = (await response.json().catch(() => null)) as {
      provider?: unknown;
      profiles?: unknown;
    } | null;
    const profiles = Array.isArray(payload?.profiles)
      ? payload.profiles.filter((p): p is string => typeof p === 'string')
      : [];
    return {
      provider: typeof payload?.provider === 'string' ? payload.provider : 'http',
      profiles,
    };
  }

  /**
   * Метаданные профилей у provisioner'а (`GET /v1/profiles`).
   *
   * Ответ — **только метаданные** (образ/сеть/ресурсы/runtimeClass и имена
   * MCP-серверов); env, команды MCP и токены provisioner не отдаёт. Записи без
   * имени и неизвестные поля при разборе отбрасываются.
   */
  async profilesInfo(): Promise<ExecutionProfileInfo[]> {
    const response = await this._request('GET', '/v1/profiles', undefined, true);
    const payload = (await response.json().catch(() => null)) as { profiles?: unknown } | null;
    const raw = Array.isArray(payload?.profiles) ? payload.profiles : [];
    const profiles: ExecutionProfileInfo[] = [];
    for (const entry of raw) {
      const info = toProfileInfo(entry);
      if (info !== null) profiles.push(info);
    }
    return profiles;
  }

  /**
   * Прогрев образов у provisioner'а (`POST /v1/images/warm`).
   *
   * Запрос **долгий**: provisioner ждёт готовности DaemonSet'а на всех нодах
   * (до 300 с на образ), поэтому таймаут запроса считается от числа образов,
   * а не берётся из общего таймаута provisioner'а (10 с по умолчанию).
   */
  async warmImages(images: string[]): Promise<ExecutionImageWarmResult[]> {
    const timeoutMs = Math.max(
      this._timeoutMs,
      images.length * EXECUTION_WARM_IMAGE_TIMEOUT_MS + EXECUTION_WARM_IMAGE_TIMEOUT_MARGIN_MS,
    );
    const response = await this._request('POST', '/v1/images/warm', { images }, true, timeoutMs);
    const payload = (await response.json().catch(() => null)) as { results?: unknown } | null;
    const raw = Array.isArray(payload?.results) ? payload.results : [];
    const results: ExecutionImageWarmResult[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as {
        image?: unknown;
        ok?: unknown;
        nodes?: unknown;
        error?: unknown;
      };
      const image = typeof record.image === 'string' ? record.image.trim() : '';
      if (image === '') continue;
      const nodes =
        typeof record.nodes === 'number' && Number.isFinite(record.nodes) ? record.nodes : 0;
      const error = typeof record.error === 'string' ? record.error.trim() : '';
      results.push({
        image,
        ok: record.ok === true,
        nodes,
        ...(error !== '' ? { error } : {}),
      });
    }
    return results;
  }

  /**
   * Best-effort вызов: сбой не ломает ход (смысл `touch`/`drain`/`release` —
   * подчистка, а не условие работы).
   */
  private async _bestEffort(method: string, path: string): Promise<void> {
    try {
      await this._request(method, path, undefined, false);
    } catch {
      // Намеренно проглочено: best-effort.
    }
  }

  /**
   * Запрос к provisioner'у: bearer-токен, таймаут, приведение ответа к ошибке.
   *
   * @param requireAuth `true` — заголовок `Authorization` обязателен
   * @param body тело запроса (JSON) либо `undefined`
   * @param timeoutMs таймаут запроса (по умолчанию — общий таймаут провайдера)
   */
  private async _request(
    method: string,
    path: string,
    body: unknown,
    requireAuth: boolean,
    timeoutMs: number = this._timeoutMs,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (requireAuth) {
      headers.authorization = `Bearer ${await this._readToken()}`;
    }
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await egressFetch(`${this._url}${path}`, init, {
        ...(this._fetchImpl ? { fetchImpl: this._fetchImpl } : {}),
      });
    } catch (err) {
      throw new ExecutionPoolProviderError(
        `execution pool provider "http" request failed (${method} ${path})`,
        { cause: err },
      );
    }
    if (!response.ok) {
      // Тело ответа **не** включаем в текст ошибки: provisioner мог бы
      // вернуть эхо токена.
      throw new ExecutionPoolProviderError(
        `execution pool provider "http" request failed (${method} ${path}): status ${response.status}`,
      );
    }
    return response;
  }

  /** Значение bearer-токена (кэш на процесс); при ошибке — понятная причина. */
  private async _readToken(): Promise<string> {
    if (!this._token) {
      this._token = readExecutorToken(this._tokenSecret).catch((err: unknown) => {
        // Кэш сбрасываем: файл токена мог появиться позже (файл монтируется
        // после старта процесса).
        this._token = null;
        throw new ExecutionPoolProviderError(
          'execution pool provider "http" could not read its token ' +
            '(execution.remote.provisioner.tokenSecret / SYNTH_EXECUTION_PROVISIONER_TOKEN)',
          { cause: err },
        );
      });
    }
    return this._token;
  }
}

/**
 * Фабрика провайдера пулов по эффективной секции `execution`.
 *
 * `provider: static` — пулы из конфигурации; `provider: http` — provisioner
 * по HTTP. Неизвестное значение — **fail-closed** (его отсекает резолвер
 * конфигурации; здесь — страховка).
 *
 * @param remote эффективная секция `execution.remote`
 * @param opts транспорт (тесты подменяют `fetch`)
 */
export function createExecutionPoolProvider(
  remote: ResolvedExecutionRemoteConfig,
  opts?: { fetchImpl?: FetchLike },
): ExecutionPoolProvider {
  if (remote.provider === 'http') {
    return new HttpExecutionPoolProvider({
      url: remote.provisioner.url,
      tokenSecret: remote.provisioner.tokenSecret,
      timeoutMs: remote.provisioner.timeoutMs,
      // Каталог профилей инстанца (с учётом runtime-секции) — источник
      // `profileSpec` в теле `POST /v1/pools`.
      profiles: remote.profiles,
      ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }
  const profiles: Record<string, StaticExecutionProfile> = {};
  for (const [name, profile] of Object.entries(remote.profiles)) {
    profiles[name] = { url: [...profile.url], ...(executionProfileMetadata(profile) ?? {}) };
  }
  // Профиль по умолчанию существует всегда: из каталога либо «общие
  // параметры секции» (адреса секции — как «профиль по умолчанию»).
  if (!profiles[remote.defaultProfile]) {
    profiles[remote.defaultProfile] = { url: [...remote.url] };
  }
  return new StaticExecutionPoolProvider(profiles);
}
