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
 * | `GET` | `/v1/capabilities` | провайдер, профили, лимиты | JSON |
 * | `GET` | `/health` | liveness (без токена) | `{ok, provider}` |
 * | `GET` | `/metrics` | метрики (`synth_provisioner_*`) | exposition 0.0.4 |
 *
 * `{key}` — **URL-encoded** канонический ключ пула (`poolKeyString` в core:
 * `project:<id>:exec:<profile>`, `session:<id>:browser:<profile>`,
 * `instance:exec:<profile>`). Hono декодирует параметр пути сам — повторно
 * `decodeURIComponent` не применяется.
 *
 * ## Ключ пула
 *
 * Ключ приходит **строкой** и является ключом реестра пулов: он различает
 * области (instance/project/session), класс (`exec`/`browser`) и профиль.
 * Составные поля (`scope`/`id`/`class`/`profile`) передаются рядом — по ним
 * считается idle-таймаут и подбирается ресурс, но идентичность пула — `key`.
 *
 * ## Ошибки
 *
 * Единый формат — `{error:{reason, message}}`; `reason` — из закрытого набора,
 * HTTP-код выводится из него (`ERROR_STATUS`). Текст ошибки **никогда** не
 * содержит токенов (provisioner не логирует и не эхо-возвращает секреты).
 */

import { z } from 'zod';

/** Версия wire-протокола provisioner'а (аддитивные изменения — увеличивают). */
export const PROVISIONER_PROTOCOL_VERSION = 1;

/** Область пула: общий пул инстанса, проектный или сессионный. */
export type PoolScope = 'instance' | 'project' | 'session';

/** Класс пула: обычные команды либо браузерная сессия. */
export type PoolClass = 'exec' | 'browser';

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

/** Ответ `GET /v1/pools` (диагностика). */
export interface PoolsListResponse {
  pools: PoolInfo[];
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
    class: z.enum(['exec', 'browser']),
    profile: z.string().trim().min(1).max(128),
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

/**
 * Человекочитаемое описание ошибок zod-валидации.
 *
 * Порядок и формулировки не являются контрактом: сообщение нужно оператору,
 * а не клиенту. Секретов в нём нет — только пути полей.
 */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}
