/**
 * Egress-политика исходящих запросов (web/инструкции/скиллы/webhooks/providers/MCP).
 *
 * Единый формат политики (`mode` + `list` + `exceptions`) используется всеми
 * потребителями; `webhooks` дополнительно поддерживает `mode: 'off'` (dev, без
 * проверок и без требования https). Семантика:
 * - `exceptions` — allow-правила, проверяются **первыми** (точный hostname,
 *   `*.suffix`, CIDR/IP); hostname-правило разрешает сразу, CIDR — по резолву;
 * - `deny` + `list` — блок, если хотя бы один resolved-адрес в `list`;
 * - `allow` + `list` — разрешено, если ВСЕ resolved-адреса в `list` (или exception);
 * - `off` (только webhooks) — проверок нет, `requireHttps = false`.
 *
 * Литеральные `localhost`/`*.localhost`/`*.local`/`*.internal` и приватные IP
 * блокируются самой политикой (дефолтный `list`), а не отдельным зашитым списком;
 * exception может их разрешить.
 *
 * Дефолтный `list` — **общий канонический список** `DEFAULT_MCP_PRIVATE_CIDRS`
 * (`types/mcp.ts`): он же — дефолт `mcp.networkPolicy` и встроенный fallback
 * `engine/net/egress-guard.ts`. Списков «заблокированных адресов» в коде больше
 * нет, поэтому расширять блокировки нужно только этот список.
 */

import { DEFAULT_MCP_PRIVATE_CIDRS } from './mcp.js';

export const EGRESS_POLICY_MODES = ['deny', 'allow'] as const;
export type EgressPolicyMode = (typeof EGRESS_POLICY_MODES)[number];

export const WEBHOOKS_EGRESS_POLICY_MODES = ['deny', 'allow', 'off'] as const;
export type WebhooksEgressPolicyMode = (typeof WEBHOOKS_EGRESS_POLICY_MODES)[number];

/** Скоупы настраиваемой egress-политики (settings/egress). */
export const EGRESS_POLICY_SCOPES = ['tools', 'webhooks'] as const;
export type EgressPolicyScope = (typeof EGRESS_POLICY_SCOPES)[number];

/** Политика egress для встроенных инструментов (web_fetch/web_search/…). */
export interface EgressPolicy {
  mode: EgressPolicyMode;
  /** CIDR/IP/hostname-правила основного списка. */
  list: string[];
  /** Allow-правила-исключения (проверяются первыми). */
  exceptions: string[];
}

/** Политика egress для исходящих webhooks (доп. режим `off` — dev). */
export interface WebhooksEgressPolicy {
  mode: WebhooksEgressPolicyMode;
  list: string[];
  exceptions: string[];
}

/** Настройки журнала внешних запросов (аудит egress). */
export interface EgressLogConfig {
  enabled: boolean;
  /** Срок хранения в днях; `0` — не чистить. */
  retentionDays: number;
}

/**
 * Дефолтная политика встроенных инструментов: deny служебных диапазонов
 * (`DEFAULT_MCP_PRIVATE_CIDRS` — общий канонический список, см. `types/mcp.ts`).
 */
export const DEFAULT_EGRESS_TOOLS_POLICY: EgressPolicy = {
  mode: 'deny',
  list: [...DEFAULT_MCP_PRIVATE_CIDRS],
  exceptions: [],
};

/**
 * Дефолтная политика webhooks: deny служебных диапазонов (тот же общий список)
 * + обязательный https.
 */
export const DEFAULT_EGRESS_WEBHOOKS_POLICY: WebhooksEgressPolicy = {
  mode: 'deny',
  list: [...DEFAULT_MCP_PRIVATE_CIDRS],
  exceptions: [],
};

/** Дефолт журнала внешних запросов: включён, хранить 7 дней. */
export const DEFAULT_EGRESS_LOG: EgressLogConfig = {
  enabled: true,
  retentionDays: 7,
};

/** Скоупы (источники) внешних запросов в журнале egress. */
export const EGRESS_REQUEST_SCOPES = [
  'web_fetch',
  'web_search',
  'skills',
  'instructions',
  'webhooks',
  'providers',
  'mcp',
] as const;
export type EgressRequestScope = (typeof EGRESS_REQUEST_SCOPES)[number];

export const EGRESS_REQUEST_STATUSES = ['allowed', 'blocked', 'error'] as const;
export type EgressRequestStatus = (typeof EGRESS_REQUEST_STATUSES)[number];

/**
 * ADR-099 (D1): фактический маршрут запроса — через прокси, напрямую либо
 * direct-фоллбек после недоступного прокси (`proxy.fallbackDirect`).
 */
export const EGRESS_REQUEST_VIAS = ['proxy', 'direct', 'fallback'] as const;
export type EgressRequestVia = (typeof EGRESS_REQUEST_VIAS)[number];

/**
 * Запись журнала внешних запросов (append-only, без тел/заголовков).
 * `url` хранится без query/userinfo и обрезается до 2048 символов.
 */
export interface EgressRequestLogEntry {
  id: string;
  ts: string;
  scope: EgressRequestScope;
  host: string;
  url: string;
  method?: string;
  status: EgressRequestStatus;
  /** Маршрут запроса (ADR-099 D1): proxy/direct/fallback. */
  via?: EgressRequestVia;
  httpStatus?: number;
  bytes?: number;
  durationMs?: number;
  reason?: string;
  matchedRule?: string;
  sessionId?: string;
  projectId?: string;
  actor?: string;
}

/** Скоупы изменений egress-политик/прокси в security-аудите. */
export const SECURITY_AUDIT_SCOPES = ['tools', 'webhooks', 'mcp', 'proxy', 'tls', 'attachments'] as const;
export type SecurityAuditScope = (typeof SECURITY_AUDIT_SCOPES)[number];

export const SECURITY_AUDIT_ACTIONS = ['update', 'reset'] as const;
export type SecurityAuditAction = (typeof SECURITY_AUDIT_ACTIONS)[number];

/**
 * Запись аудита изменений security-политик (append-only). `before`/`after` —
 * снимки политики до/после операции (`null` для reset — значение не задано).
 */
export interface SecurityAuditEntry {
  id: string;
  ts: string;
  actor: string;
  scope: SecurityAuditScope;
  action: SecurityAuditAction;
  source: 'runtime';
  before: unknown;
  after: unknown;
  version: number;
}
