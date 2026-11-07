// Type-only импорт: конфиг-тип MCP нужен для записи реестра (ADR-071 §2.5).
// Runtime-цикла нет — импорт стирается при компиляции.
import type { McpServerConfig } from '../config/types.js';
import type { McpToolDetail } from './prompt.js';

// --- MCP: реестр серверов и сетевой доступ (ADR-071 §2.3.1/§2.5) ---

/** Версия схемы записи реестра MCP — для будущей миграции (ADR-096). */
export const MCP_REGISTRY_SCHEMA_VERSION = 1;

export const MCP_REGISTRY_ORIGINS = ['instance', 'user'] as const;
export type McpRegistryOrigin = (typeof MCP_REGISTRY_ORIGINS)[number];

export const MCP_REGISTRY_TRUST_LEVELS = ['builtin', 'community'] as const;
export type McpRegistryTrust = (typeof MCP_REGISTRY_TRUST_LEVELS)[number];

/**
 * PROP-125: режим доставки серверного MCP-сервера в локальные сессии гибрида.
 *
 * - `auto` — `relay` для `http`/`sse`, `tools` для `stdio` (дефолт);
 * - `relay` — полноценный MCP-клиент через backend (`/api/v2/mcp/relay/:name`);
 * - `tools` — tool-level proxy (`/api/v2/mcp/remote/*`).
 *
 * Неудачный relay **всегда** деградирует в `tools` (с причиной в статусе) —
 * отказа и «тихого» исчезновения сервера нет.
 */
export const MCP_REMOTE_MODES = ['auto', 'relay', 'tools'] as const;
export type McpRemoteMode = (typeof MCP_REMOTE_MODES)[number];

/** Автор записи реестра (кто добавил сервер). */
export interface McpRegistryAuthor {
  userId: string;
  username: string;
}

/**
 * ADR-071 §2.5: плоская запись единого реестра MCP-серверов.
 *
 * Логическая модель сразу проектируется под PostgreSQL (ADR-097): стабильный
 * `id`, `schemaVersion`, timestamps; вложенность ограничена `config`/`author`
 * (раскладываются в JSONB/отдельные колонки). Instance- и пользовательские
 * записи различаются полем `origin`, не отдельными реестрами.
 */
export interface McpRegistryEntry {
  schemaVersion: number;
  id: string;
  name: string;
  config: McpServerConfig;
  origin: McpRegistryOrigin;
  author: McpRegistryAuthor | null;
  trust: McpRegistryTrust;
  /**
   * Системный мастер-флаг (hard-gate): `false` — сервер недоступен НИГДЕ и НИКОГДА
   * (в т.ч. в старых сессиях). Дефолт `true`.
   */
  enabled: boolean;
  /**
   * Переосмыслено: «включён по умолчанию для НОВЫХ ПРОЕКТОВ» — сид
   * `project.mcp.enabled`/`project.mcp.defaultOn` при создании проекта. Снимок:
   * изменение не влияет на ранее созданные проекты/сессии.
   */
  enabledByDefault: boolean;
  /**
   * PROP-125: как доставлять сервер в локальные сессии гибрида.
   * Отсутствие поля = `auto` (записи, созданные до PROP-125).
   */
  remoteMode?: McpRemoteMode;
  createdAt: string;
  updatedAt: string;
}

export const MCP_NETWORK_POLICY_MODES = ['allow', 'deny'] as const;
export type McpNetworkPolicyMode = (typeof MCP_NETWORK_POLICY_MODES)[number];

/**
 * ADR-071 §2.3.1: политика сетевого доступа пользовательских HTTP MCP-серверов.
 * - `deny` — перечисленные адреса/CIDR запрещены (дефолт: приватные диапазоны);
 * - `allow` — разрешены только перечисленные адреса/CIDR (всё прочее запрещено).
 */
export interface McpNetworkPolicy {
  mode: McpNetworkPolicyMode;
  list: string[];
  /**
   * Allow-правила-исключения (точный hostname, `*.suffix`, CIDR/IP).
   * Проверяются первыми; формат/семантика общие с `egress.tools`/`egress.webhooks`.
   */
  exceptions?: string[];
}

/**
 * Служебные/специальные адресные диапазоны, запрещённые по умолчанию (SSRF/egress).
 *
 * **Единственный источник истины** для всех egress-политик: `mcp.networkPolicy`,
 * `egress.tools`, `egress.webhooks` (`types/egress.ts`) и встроенный fallback
 * guard'а (`core/engine/net/egress-guard.ts` → `isBlockedIp` без политики).
 * Отдельных списков «заблокированных адресов» в коде больше нет: расширять
 * нужно этот список, иначе политика и guard разойдутся (промис не будет
 * подкреплён кодом).
 *
 * **Правило отбора:** диапазоны, которые не маршрутизируются в публичном
 * интернете (IANA IPv4/IPv6 Special-Purpose Address Registry) либо непригодны
 * как цель исходящего HTTP-запроса (multicast, limited broadcast).
 *
 * IPv4:
 * - `0.0.0.0/8` — «this network»; `0.0.0.0` на Linux ведёт на localhost;
 * - `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` — RFC1918 (private);
 * - `100.64.0.0/10` — CGNAT (RFC 6598); в ряде облаков это адрес метаданных
 *   (напр. Alibaba `100.100.100.200`);
 * - `127.0.0.0/8` — loopback;
 * - `169.254.0.0/16` — link-local (в т.ч. `169.254.169.254` — метаданные облака);
 * - `192.0.0.0/24` — IETF protocol assignments (RFC 6890), включая well-known
 *   NAT64-префиксы `192.0.0.170/171` (RFC 6052): через них внутренний IPv4
 *   достигается по IPv6-адресу и v4-список его не ловит;
 * - `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` — TEST-NET-1/2/3
 *   (RFC 5737): SSRF-риска не несут (не маршрутизируются), но заблокированы
 *   вместе со всеми прочими служебными диапазонами — список самосогласован
 *   («всё специальное»), риск-оценка не нужна по каждому адресу, а вернуть
 *   конкретный адрес можно явным exception политики;
 * - `192.88.99.0/24` — 6to4 relay anycast (RFC 7526, deprecated);
 * - `198.18.0.0/15` — benchmarking (RFC 2544);
 * - `224.0.0.0/4` — multicast: цель для SSRF во внутренние multicast-группы
 *   (mDNS/SSDP и т.п.);
 * - `240.0.0.0/4` — reserved (RFC 1112);
 * - `255.255.255.255/32` — limited broadcast.
 *
 * IPv6:
 * - `::/128` — unspecified, на части стеков эквивалентен loopback;
 * - `::1/128` — loopback;
 * - `::ffff:0:0/96` — IPv4-mapped IPv6. Mapped-запись — типичная попытка обхода
 *   (v4-диапазоны её не ловят), легитимные адреса приходят обычным v4/v6,
 *   поэтому mapped-форма блокируется целиком; `isIpInCidr` дополнительно
 *   приводит mapped к вложенному IPv4 (`::ffff:127.0.0.1` ← `127.0.0.0/8`);
 * - `100::/64` — discard-only (RFC 6666);
 * - `2001:2::/48` — benchmarking (IPv6);
 * - `2001:db8::/32` — documentation (IPv6);
 * - `2002::/16` — 6to4 (RFC 7526, deprecated): адрес вшивает IPv4, поэтому
 *   недостижим для v4-списка;
 * - `fc00::/7` — ULA;
 * - `fe80::/10` — link-local;
 * - `ff00::/8` — multicast.
 *
 * Осознанно НЕ включены (иначе ломается легитимный egress):
 * - `64:ff9b::/96` (NAT64 well-known prefix) и `64:ff9b:1::/48` (local-use
 *   NAT64, RFC 8215) — на IPv6-only сетях с DNS64 резолвер отдаёт
 *   синтезированные AAAA именно из этих префиксов; их блокировка заблокировала
 *   бы весь исходящий трафик к публичным хостам;
 * - глобально маршрутизируемые служебные блоки (`192.31.196.0/24` AS112-v4,
 *   `192.52.193.0/24` AMT, `192.175.48.0/24` AS112, `2001:4860::/32` и т.п.) —
 *   это обычные публичные адреса.
 */
export const DEFAULT_MCP_PRIVATE_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '100::/64',
  '2001:2::/48',
  '2001:db8::/32',
  '2002::/16',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
] as const;

/** Дефолтная политика: deny служебных диапазонов (ADR-071 §2.3.1). */
export const DEFAULT_MCP_NETWORK_POLICY: McpNetworkPolicy = {
  mode: 'deny',
  list: [...DEFAULT_MCP_PRIVATE_CIDRS],
  exceptions: [],
};

// --- MCP: уровни/скоуп и эффективный набор (ADR-071 §2.2/§2.4) ---

export const MCP_SERVER_LEVELS = ['system', 'project', 'session'] as const;
export type McpServerLevel = (typeof MCP_SERVER_LEVELS)[number];

/**
 * ADR-071 §2.2: почему сервер отключён в эффективном наборе сессии:
 * - `system_disabled` — выключен системным мастер-флагом (`McpRegistryEntry.enabled === false`);
 * - `project_disabled` — не разрешён проектом (`project.enabled` — hard-gate);
 * - `session_optout` — явный opt-out в сессии (`mcpDisabledServers`);
 * - `not_default` — нет в снапшоте сессии (`mcpDefaultOn`) и не включён явно.
 *
 * Причина `config` отсутствует: `McpServerConfig.enabled` — только сид записи
 * реестра (`seedFromConfig`), в резолвинге/подключении не участвует.
 */
export const MCP_DISABLED_REASONS = [
  'system_disabled',
  'project_disabled',
  'session_optout',
  'not_default',
] as const;
export type McpDisabledReason = (typeof MCP_DISABLED_REASONS)[number];

/**
 * ADR-071 §2.4: эффективное состояние MCP-сервера для сессии. Отдаётся API
 * `GET /api/v2/sessions/:id/mcp`; отключённые серверы не исчезают из выдачи.
 */
export interface McpServerEffective {
  name: string;
  level: McpServerLevel;
  enabled: boolean;
  /** Причина отключения (только при `enabled === false`). */
  reason?: McpDisabledReason;
  connected?: boolean;
  origin: McpRegistryOrigin;
  trust: McpRegistryTrust;
  /**
   * PROP-125: источник для UI — локальный инстанс или сервер гибрида.
   * Не путать с `origin` (про реестр записи: instance/user).
   */
  source?: 'local' | 'server';
  /**
   * ADR-071 §2.2/§2.6: транспортный статус для таблицы «MCP» в статистике:
   * `disabled` — выключен в эффективном наборе, `connected`/`error`/`circuit-open`
   * — состояние подключения активного сервера.
   */
  status?: 'connected' | 'error' | 'disabled' | 'circuit-open';
  /**
   * PROP-125: причина недоступности/деградации сервера (без секретов).
   *
   * Для серверных MCP-серверов гибрида — причина, по которой сервер не
   * работает: backend офлайн, сервер упал или relay не поднялся и клиент
   * деградировал в режим `tools`. Для локальных серверов поле отсутствует —
   * ошибки там не ведутся.
   */
  error?: string;
  /** ADR-071 §2.5/§2.6: автор записи реестра (null для instance/config-серверов). */
  author?: McpRegistryAuthor | null;
  /** ADR-071 §2.2/§2.6: имена инструментов сервера (пусто, если не подключён). */
  tools?: string[];
  /** ADR-071 §2.6: суммарные символы JSON-определений тулов сервера. */
  chars?: number;
  /** ADR-071 §2.6: оценка токенов сервера (`ceil(chars / ratio)`). */
  estTokens?: number;
  /** ADR-071 §2.6: chars-per-token, применённый к оценке (4 — без калибровки). */
  ratio?: number;
  /** ADR-071 §2.6: пер-тульные chars/estTokens/ratio + признак admin_disabled. */
  toolDetails?: McpToolDetail[];
}

// --- PROP-125: контракт удалённого MCP (сервер гибрида → локальный core) ---

/**
 * PROP-125: вложение в результате удалённого MCP-вызова (base64, как в
 * протоколе исполнителя 5 — ADR-077).
 */
export interface McpRemoteAttachment {
  mime: string;
  name?: string;
  base64: string;
}

/**
 * PROP-125: описание серверного MCP-сервера для локального клиента.
 *
 * Секреты и URL с креденшелами в выдачу не попадают (ADR-105).
 */
export interface RemoteMcpServerInfo {
  name: string;
  type: 'stdio' | 'sse' | 'http';
  origin: 'instance' | 'user';
  trust: McpRegistryTrust;
  /** Системный мастер-флаг (hard-gate): `false` — сервер недоступен нигде. */
  enabled: boolean;
  /** «Включён по умолчанию для новых проектов» (сид `project.mcp`). */
  enabledByDefault: boolean;
  /** Фактический режим доставки в локальные сессии (PROP-125). */
  remoteMode: McpRemoteMode;
  status: 'idle' | 'up' | 'down';
  toolCount: number;
  error?: string;
  instructions?: string;
}

/** PROP-125: описание одного инструмента удалённого MCP-сервера. */
export interface RemoteMcpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** PROP-125: ответ `GET /api/v2/mcp/remote/tools?server=…`. */
export interface RemoteMcpToolsResponse {
  server: string;
  instructions?: string;
  tools: RemoteMcpToolInfo[];
}

/** PROP-125: тело `POST /api/v2/mcp/remote/call`. */
export interface RemoteMcpCallRequest {
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/**
 * PROP-125: результат удалённого MCP-вызова — тот же шейп, что у протокола
 * исполнителя 5 (`docs/EXECUTION.md`): один формат на два «MCP вне процесса».
 */
export interface RemoteMcpCallResult {
  content: string;
  isError: boolean;
  attachments?: McpRemoteAttachment[];
}

// --- ADR-105 (Ф3): запрет plaintext-секретов в заголовках MCP-коннектора ---

/**
 * Машинно-читаемый код ошибки записи реестра MCP с plaintext-секретом
 * в заголовках (ADR-105 §5, Ф3).
 *
 * HTTP: `400` с `error.code = "MCP_SECRET_HEADER_FORBIDDEN"`.
 */
export const MCP_SECRET_HEADER_ERROR_CODE = 'MCP_SECRET_HEADER_FORBIDDEN';

/**
 * Заголовки, значение которых — **секрет**. В реестре MCP (и в конфиге
 * коннектора) им не место: токен лежит в слое внешних доступов
 * (`ExternalCredential`, ADR-105), а коннектор ссылается на него по id
 * (`auth: { kind: 'credential', credentialId }`).
 *
 * Сравнение — регистронезависимое (HTTP-заголовки нечувствительны к регистру).
 */
export const FORBIDDEN_MCP_SECRET_HEADERS = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'cookie',
] as const;

export type ForbiddenMcpSecretHeader = (typeof FORBIDDEN_MCP_SECRET_HEADERS)[number];

/**
 * Найти запрещённые (секретные) заголовки в словаре `headers`.
 *
 * Возвращает **исходные имена** заголовков (как их записал пользователь) —
 * они уходят в сообщение об ошибке (значения — никогда).
 */
export function findForbiddenMcpSecretHeaders(
  headers: Record<string, string> | undefined | null,
): string[] {
  if (!headers) return [];
  const forbidden = new Set<string>(FORBIDDEN_MCP_SECRET_HEADERS);
  return Object.keys(headers).filter((name) => forbidden.has(name.trim().toLowerCase()));
}

/**
 * Текст ошибки «секретный заголовок в коннекторе» — **единый** для слоя
 * хранилища, HTTP-роутов (core/backend) и probe (ADR-105 §5, Ф3).
 *
 * Значений заголовков в тексте нет — только их имена.
 */
export function mcpSecretHeaderErrorMessage(forbidden: string[]): string {
  return `Заголовки с секретами (${forbidden.join(', ')}) в MCP-коннекторе запрещены — используйте auth.kind='credential' (доступ к внешнему сервису)`;
}
