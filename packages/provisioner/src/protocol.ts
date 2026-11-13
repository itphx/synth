/**
 * Wire-протокол provisioner'а пулов исполнения (PROP-135, Ф4b-2a).
 *
 * Provisioner — **отдельный сервис**, который по запросу control plane
 * поднимает (или назначает) исполнителя и возвращает адрес и токен пула.
 * Контракт — тот, который уже отправляет `HttpExecutionPoolProvider`
 * (`packages/core/src/execution/pool-provider.ts`):
 *
 * | Метод | Путь | Назначение | Ответ |
 * |---|---|---|---|
 * | `POST` | `/v1/pools` | обеспечить пул (идемпотентно) | `{url, token}` |
 * | `POST` | `/v1/pools/{key}/touch` | продлить жизнь пула | `204` |
 * | `POST` | `/v1/pools/{key}/drain` | слить пул | `202` |
 * | `DELETE` | `/v1/pools/{key}` | удалить пул | `202` |
 * | `GET` | `/v1/pools` | диагностика (без токенов) | `{pools}` |
 * | `GET` | `/v1/profiles` | метаданные профилей (без секретов) | `{profiles}` |
 * | `GET` | `/v1/capabilities` | провайдер, профили, лимиты | JSON |
 * | `GET` | `/health` | liveness (без токена) | `{ok, provider}` |
 * | `GET` | `/metrics` | метрики (`synth_provisioner_*`) | exposition 0.0.4 |
 *
 * `{key}` — **URL-encoded** канонический ключ пула (`poolKeyString` в core:
 * `project:<id>:exec:<profile>`, `session:<id>:browser:<profile>`,
 * `session:<id>:sandbox:<profile>`, `instance:exec:<profile>`). Hono декодирует
 * параметр пути сам — повторно `decodeURIComponent` не применяется.
 *
 * ## Ключ пула
 *
 * Ключ приходит **строкой** и является ключом реестра пулов: он различает
 * области (instance/project/session), класс (`exec`/`browser`/`sandbox`) и профиль.
 * Составные поля (`scope`/`id`/`class`/`profile`) передаются рядом — по ним
 * считается idle-таймаут и подбирается ресурс, но идентичность пула — `key`.
 *
 * ## Спецификация профиля (`profileSpec`)
 *
 * Тело `POST /v1/pools` может нести **спецификацию профиля пула** —
 * `profileSpec` (та же strict-схема, что у каталога `SYNTH_PROVISIONER_PROFILES`:
 * `image`/`url`/`network`/`resources`/`runtimeClass`/`readOnlyRootFilesystem`/
 * `env`/`mcpServers`). Её шлёт control plane (backend) из эффективного
 * каталога инстанса (`execution.remote.profiles[<profile>]`), чтобы админ
 * задавал/менял профили в UI, не правя Helm values.
 *
 * Приоритет: **`profileSpec` > каталог provisioner'а**. Провайдер `static`
 * поле игнорирует (адрес пула — из `staticPools`/`profiles[].url`), провайдер
 * `kubernetes` строит по нему под (`image` обязателен; `url` игнорируется).
 *
 * Поле **аддитивное**: запрос без `profileSpec` работает с любой версией
 * provisioner'а (поведение прежнее — каталог provisioner'а). Обратное
 * ограничение: у старого provisioner'а тело запроса разбирается **строгой**
 * схемой, поэтому запрос с `profileSpec` он отвергнет (`400
 * invalid_request`). Backend шлёт поле только для профилей каталога инстанса,
 * у которых задан образ; provisioner новой версии при этом нужно обновить
 * раньше backend'а.
 *
 * ## Ошибки
 *
 * Единый формат — `{error:{reason, message}}`; `reason` — из закрытого набора,
 * HTTP-код выводится из него (`ERROR_STATUS`). Текст ошибки **никогда** не
 * содержит токенов (provisioner не логирует и не эхо-возвращает секреты).
 */

import { z } from 'zod';
import { profileSchema, type ProvisionerProfile } from './config.js';

export { formatIssues } from './format.js';

/** Версия wire-протокола provisioner'а (аддитивные изменения — увеличивают). */
export const PROVISIONER_PROTOCOL_VERSION = 1;

/**
 * Максимальная длина `workspaceSubPath` (относительный путь внутри PVC).
 *
 * Ограничение не из Kubernetes API (там лимит на длину пути больше), а
 * защитное: проект — это один-два сегмента (`proj-slug`, `proj-slug/.worktrees/x`).
 */
export const MAX_WORKSPACE_SUB_PATH_LENGTH = 512;

/**
 * Предел числа образов в одном запросе прогрева.
 *
 * Прогрев тянет образ на **каждую** ноду кластера — десяток за раз
 * достаточно, а больше — нагрузка на кластер без нужды.
 */
export const WARM_IMAGES_MAX = 20;

/** Предел длины ссылки на образ (docker-ref). */
export const IMAGE_REF_MAX_LENGTH = 512;

/**
 * Таймаут ожидания готовности DaemonSet'а прогрева на **один образ**, мс.
 *
 * Образ качается на каждую ноду — 5 минут на образ (максимум для большого
 * образа на медленной ноде).
 */
export const WARM_IMAGE_TIMEOUT_MS = 300_000;

/**
 * Проверка ссылки на образ (docker-ref).
 *
 * Fail-closed: пустая строка, пробелы и недопустимые символы — отказ.
 * Значение уходит в имя DaemonSet'а прогрева и в pod spec, поэтому мусор
 * отсекаем на границе API.
 */
export function isValidImageRef(image: string): boolean {
  const trimmed = (image ?? '').trim();
  if (trimmed === '' || trimmed.length > IMAGE_REF_MAX_LENGTH) return false;
  if (/\s/.test(trimmed)) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/.test(trimmed);
}

/** Схема тела `POST /v1/images/warm` (fail-closed: неизвестные поля — ошибка). */
export const warmImagesRequestSchema = z
  .object({
    images: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(IMAGE_REF_MAX_LENGTH)
          .refine(isValidImageRef, { message: 'ожидается ссылка на образ (docker-ref)' }),
      )
      .min(1)
      .max(WARM_IMAGES_MAX),
  })
  .strict();

/**
 * Итог прогрева одного образа.
 *
 * `ok: false` — образ не прогрет (таймаут/ошибка API); причина — в `error`
 * (без секретов).
 */
export interface WarmImageResult {
  /** Образ, который прогревали. */
  image: string;
  /** Удалось ли прогреть образ. */
  ok: boolean;
  /** Число нод, на которых образ прогрет. */
  nodes: number;
  /** Причина неудачи (без секретов). */
  error?: string;
}

/** Ответ `POST /v1/images/warm`. */
export interface WarmImagesResponse {
  /** Итог по каждому образу (порядок — как в запросе). */
  results: WarmImageResult[];
}

/**
 * Проверить `workspaceSubPath` — путь **внутри** PVC, а не произвольный путь.
 *
 * Разрешено: относительный путь из непустых сегментов (`proj-slug`,
 * `proj-slug/.worktrees/x`). Запрещено: абсолютный путь (`/…`), выход наверх
 * (`..`), текущий каталог (`.`), пустые сегменты (`a//b`, `a/`), обратный
 * слэш и управляющие символы — `subPath` монтирует каталог внутри тома, и
 * `..`/абсолютный путь вывели бы пул за границу проекта.
 *
 * @param value значение из запроса (уже обрезанное по краям)
 * @returns `true` — путь допустим как `subPath`
 */
export function isValidWorkspaceSubPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_WORKSPACE_SUB_PATH_LENGTH) return false;
  if (value.startsWith('/')) return false;
  // Обратный слэш в Linux-пути — не разделитель, а подозрительный символ
  // (в Windows-семантике он позволил бы `..\`); отклоняем целиком.
  if (value.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return false;
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

/** Область пула: общий пул инстанса, проектный или сессионный. */
export type PoolScope = 'instance' | 'project' | 'session';

/**
 * Класс пула: обычные команды, браузерная сессия либо разовый песочный запуск.
 *
 * `sandbox` (PROP-135 слайс 5a) — пул отдельного профиля для `sandbox_exec`.
 * Значение аддитивное: протокол provisioner'а **не повышается** (старый
 * provisioner вернёт `400 invalid_request` на неизвестный класс — fail-closed).
 */
export type PoolClass = 'exec' | 'browser' | 'sandbox';

/** Состояние пула в реестре provisioner'а. */
export type PoolState = 'ready' | 'draining';

/** Сетевой режим профиля (для будущего Kubernetes-провайдера). */
export type PoolNetworkMode = 'none' | 'restricted' | 'full';

/**
 * Запрос обеспечения пула (`POST /v1/pools`).
 *
 * `id` обязателен для `project`/`session`: пул без идентификатора области
 * совпал бы с пулом другого проекта/сессии (изоляция пулов).
 */
export interface EnsurePoolRequest {
  /** Канонический ключ пула (`scope:id:class:profile`). */
  key: string;
  /** Область пула. */
  scope: PoolScope;
  /** Идентификатор области (id проекта/сессии); у `instance` — нет. */
  id?: string;
  /** Класс пула. */
  class: PoolClass;
  /** Имя профиля исполнения. */
  profile: string;
  /**
   * Относительный путь внутри PVC workspace (`proj-slug`,
   * `proj-slug/.worktrees/x`), который монтируется в пул как рабочее дерево.
   *
   * Не задан — монтируется корень тома (совместимо с `static`-провайдером,
   * который это поле игнорирует). Абсолютный путь, `..` и пустые сегменты —
   * `invalid_request` (`400`).
   */
  workspaceSubPath?: string;
  /**
   * Спецификация профиля пула (ADR-135, аддитивное поле протокола).
   *
   * Профиль пула задаётся **в теле запроса**: control plane (backend) шлёт
   * эффективный профиль инстанса (`execution.remote.profiles[<profile>]`), и
   * provisioner создаёт пул по нему — админу не нужно править Helm values.
   * Приоритет: `profileSpec` > каталог provisioner'а
   * (`SYNTH_PROVISIONER_PROFILES`).
   *
   * Провайдер `static` поле **игнорирует** (адрес пула — из `staticPools`/
   * `profiles[].url`); провайдер `kubernetes` строит по нему спецификацию
   * пода (`image` обязателен, `url` игнорируется).
   *
   * Поле не приходит — provisioner работает как раньше (профиль берётся из
   * его каталога).
   */
  profileSpec?: ProvisionerProfile;
}

/** Ответ обеспечения пула: адрес и токен доступа к исполнителю. */
export interface EnsurePoolResponse {
  /** Адрес исполнителя пула (`http://…`). */
  url: string;
  /** Токен доступа к пулу (значение; provisioner его не сохраняет наружу). */
  token: string;
}

/** Публичное описание пула (диагностика `GET /v1/pools`; токена нет). */
export interface PoolInfo {
  /** Канонический ключ пула. */
  key: string;
  /** Адрес исполнителя пула. */
  url: string;
  /** Профиль исполнения. */
  profile: string;
  /** Область пула. */
  scope: PoolScope;
  /** Идентификатор области (у `instance` — нет). */
  id?: string;
  /** Состояние пула. */
  state: PoolState;
  /** Когда пул выдан, мс. */
  createdAt: number;
  /** Когда пул последний раз использовался, мс. */
  lastUsedAt: number;
  /** Когда началось снятие, мс (только `draining`). */
  drainingAt?: number;
}

/** Лимиты provisioner'а (в ответе `/v1/capabilities`). */
export interface ProvisionerLimits {
  /** Лимит живых пулов. */
  maxPools: number;
  /** Idle-таймаут проектного/инстансного пула, мс. */
  idleTimeoutMs: number;
  /** Idle-таймаут сессионного пула, мс. */
  sessionIdleTimeoutMs: number;
  /** Предельное время жизни пула, мс. */
  maxLifetimeMs: number;
  /** Пауза между drain и release, мс. */
  drainGraceMs: number;
}

/** Ответ `GET /v1/capabilities`. */
export interface ProvisionerCapabilities {
  provider: string;
  profiles: string[];
  protocol: number;
  limits: ProvisionerLimits;
}

/**
 * Список ресурсов профиля (`requests`/`limits` контейнера пула).
 *
 * Список **произвольный**: кроме `cpu`/`memory`/`ephemeralStorage` можно
 * задать расширенные ресурсы (`nvidia.com/gpu`, `example.com/fpga`).
 */
export interface ProfileResourceList {
  cpu?: string;
  memory?: string;
  ephemeralStorage?: string;
  /** Произвольные ключи ресурсов (`nvidia.com/gpu: "1"`). */
  [key: string]: string | undefined;
}

/** Ресурсы профиля — как в PodSpec (`requests` и/или `limits`). */
export interface ProfileResources {
  requests?: ProfileResourceList;
  limits?: ProfileResourceList;
}

/**
 * Публичное описание профиля исполнения (`GET /v1/profiles`).
 *
 * Наружу отдаются только **метаданные** профиля: образ, сеть, ресурсы,
 * runtimeClass и **имена** MCP-серверов. Команды/аргументы/env MCP-серверов,
 * env профиля, URL и токены пулов не отдаются (инвариант 13).
 */
export interface ProvisionerProfileInfo {
  /** Имя профиля. */
  name: string;
  /** Человекочитаемое описание (если задано оператором). */
  description?: string;
  /** Образ пула (`kubernetes`). */
  image?: string;
  /** Сетевой класс профиля. */
  network?: PoolNetworkMode;
  /** Ресурсы контейнера пула. */
  resources?: ProfileResources;
  /** `runtimeClassName` пода. */
  runtimeClass?: string;
  /** **Имена** MCP-серверов профиля (без command/args/env). */
  mcpServers?: string[];
}

/** Ответ `GET /v1/pools` (диагностика). */
export interface PoolsListResponse {
  pools: PoolInfo[];
}

/** Ответ `GET /v1/profiles` (метаданные профилей для admin-API/UI). */
export interface ProfilesListResponse {
  profiles: ProvisionerProfileInfo[];
}

/** Ответ `GET /health` (без токена). */
export interface ProvisionerHealth {
  ok: true;
  provider: string;
}

/** Схема тела `POST /v1/pools` (fail-closed: неизвестные поля — ошибка). */
export const ensurePoolRequestSchema = z
  .object({
    key: z.string().trim().min(1).max(512),
    scope: z.enum(['instance', 'project', 'session']),
    id: z.string().trim().min(1).max(512).optional(),
    class: z.enum(['exec', 'browser', 'sandbox']),
    profile: z.string().trim().min(1).max(128),
    workspaceSubPath: z
      .string()
      .trim()
      .min(1)
      .max(MAX_WORKSPACE_SUB_PATH_LENGTH)
      .refine(isValidWorkspaceSubPath, {
        message:
          'workspaceSubPath должен быть относительным путём внутри PVC: без «/» в начале, ' +
          'без «..», «.» и пустых сегментов',
      })
      .optional(),
    // Спецификация профиля пула из тела запроса (та же strict-схема, что у
    // каталога профилей provisioner'а): неизвестное поле внутри — ошибка
    // валидации (`400`), а не молчаливый игнор.
    profileSpec: profileSchema.optional(),
  })
  .strict()
  .refine((value) => value.scope === 'instance' || value.id !== undefined, {
    message: 'для scope project/session обязателен id (изоляция пулов)',
    path: ['id'],
  });

/** Причина ошибки provisioner'а — закрытый набор (лейбл `reason` в метриках). */
export type ProvisionerErrorReason =
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'pool_not_found'
  | 'capacity'
  | 'internal_error';

/** HTTP-код по причине ошибки. */
export type ProvisionerErrorStatus = 400 | 401 | 404 | 429 | 500;

/** Соответствие причины ошибки и HTTP-кода. */
export const ERROR_STATUS: Record<ProvisionerErrorReason, ProvisionerErrorStatus> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  pool_not_found: 404,
  capacity: 429,
  internal_error: 500,
};

/** Тело ошибки (`error`-обёртка — как у API v2 и исполнителя). */
export interface ProvisionerErrorBody {
  reason: ProvisionerErrorReason;
  message: string;
}

/** Ответ с ошибкой. */
export interface ProvisionerErrorResponse {
  error: ProvisionerErrorBody;
}

/**
 * Собрать ответ с ошибкой.
 *
 * @param reason причина (закрытый набор)
 * @param message понятный текст (не содержит секретов)
 */
export function errorResponse(
  reason: ProvisionerErrorReason,
  message: string,
): { status: ProvisionerErrorStatus; body: ProvisionerErrorResponse } {
  return { status: ERROR_STATUS[reason], body: { error: { reason, message } } };
}
