// Type-only импорт: конфиг-тип MCP нужен для записи реестра (ADR-071 §2.5).
// Runtime-цикла нет — импорт стирается при компиляции.
import type { McpServerConfig } from '../config/types.js';
import type { McpToolDetail } from './prompt.js';

// --- MCP: реестр серверов и сетевой доступ (ADR-071 §2.3.1/§2.5) ---

/** Версия схемы записи реестра MCP — для будущей миграции (PROP-032). */
export const MCP_REGISTRY_SCHEMA_VERSION = 1;

export const MCP_REGISTRY_ORIGINS = ['instance', 'user'] as const;
export type McpRegistryOrigin = (typeof MCP_REGISTRY_ORIGINS)[number];

export const MCP_REGISTRY_TRUST_LEVELS = ['builtin', 'community'] as const;
export type McpRegistryTrust = (typeof MCP_REGISTRY_TRUST_LEVELS)[number];

/** Автор записи реестра (кто добавил сервер). */
export interface McpRegistryAuthor {
  userId: string;
  username: string;
}

/**
 * ADR-071 §2.5: плоская запись единого реестра MCP-серверов.
 *
 * Логическая модель сразу проектируется под PostgreSQL (PROP-032): стабильный
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
}

/**
 * Приватные/служебные диапазоны, запрещённые по умолчанию (SSRF/egress).
 *
 * База: RFC1918 (`10/8`, `172.16/12`, `192.168/16`), loopback (`127/8`, `::1`),
 * link-local (`169.254/16`, `fe80::/10`), ULA (`fc00::/7`). Дополнительно:
 * - `0.0.0.0/8` — «this network»; `0.0.0.0` на Linux ведёт на localhost;
 * - `100.64.0.0/10` — CGNAT (RFC 6598); в ряде облаков это адрес метаданных
 *   (напр. Alibaba `100.100.100.200`);
 * - `::/128` — unspecified IPv6, на части стеков эквивалентен loopback;
 * - `::ffff:0:0/96` — IPv4-mapped IPv6. Mapped-запись — типичная попытка обхода
 *   (v4-диапазоны её не ловят), легитимные адреса приходят обычным v4/v6,
 *   поэтому mapped-форма блокируется целиком; `isIpInCidr` дополнительно
 *   приводит mapped к вложенному IPv4 (`::ffff:127.0.0.1` ← `127.0.0.0/8`).
 */
export const DEFAULT_MCP_PRIVATE_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  'fc00::/7',
  'fe80::/10',
] as const;

/** Дефолтная политика: deny приватных диапазонов (ADR-071 §2.3.1). */
export const DEFAULT_MCP_NETWORK_POLICY: McpNetworkPolicy = {
  mode: 'deny',
  list: [...DEFAULT_MCP_PRIVATE_CIDRS],
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
   * ADR-071 §2.2/§2.6: транспортный статус для таблицы «MCP» в статистике:
   * `disabled` — выключен в эффективном наборе, `connected`/`error`/`circuit-open`
   * — состояние подключения активного сервера.
   */
  status?: 'connected' | 'error' | 'disabled' | 'circuit-open';
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
