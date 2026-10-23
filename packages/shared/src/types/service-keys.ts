/**
 * ADR-052 (этап I): service-key — независимый от binding-key (ADR-089) ключ
 * инстанса для внешних сервисов со **скоупами** (`scopes`) и **проектной
 * проекцией** (`allowedProjects`). Здесь только контракты и browser-safe
 * матчер скоупов; хранилище и enforcement живут в core.
 */
import type { GlobalRole } from './index.js';

/**
 * Семейства скоупов с wildcard-поддержкой. Глобальный `*` намеренно не вводится
 * (ADR-052; каталог — `docs/API_V2.md` §1): `events:*` покрывает все `events:*`, но не `bindings:*`.
 *
 * `automation` в семейства **не** входит: `automation:install` — зонтичный скоуп
 * установки пакета расширений, а не ресурсное семейство. Wildcard `automation:*`
 * не вводится намеренно — иначе он молча покрывал бы будущие `automation:*`-скоупы
 * (напр. запуск/удаление), не связанные с установкой пакета.
 */
export const SERVICE_SCOPE_FAMILIES = [
  'events',
  'bindings',
  'keys',
  'routes',
  'sessions',
  'schedules',
] as const;

export type ServiceScopeFamily = (typeof SERVICE_SCOPE_FAMILIES)[number];

/**
 * Каталог скоупов service-key (ADR-052; `docs/API_V2.md` §1).
 * Точечные скоупы вне wildcard-семейств:
 * - `llm:chat` — LLM-прокси (роут без проектного измерения);
 * - `addons:install` — зонтичный скоуп installer-ключа: установка/обновление
 *   MCP-реестра и скиллов (PROP-090 installer);
 * - `automation:install` — зонтичный скоуп **установщика пакетов расширений**:
 *   агенты и их ролевые промпты, пайплайны, а также порождаемые пакетом
 *   правила маршрутизации и расписания. Для установщика пакета заменяет
 *   `addons:install`, `routes:write` и `schedules:write` (см. `SERVICE_SCOPE_SETS`);
 *   `addons:install` при этом **не** открывает создание агентов;
 * - `users:read` — чтение пользователей/идентичностей машинной кредой
 *   (консент-сервисы аддонов);
 * - `plugins:invoke` — server-scoped токен плагина (PROP-090 Ф7, Уровень 2):
 *   ключ, привязанный к `plugin_id`; без этого scope сервер отвергает такой
 *   ключ (fail-closed).
 */
export const SERVICE_SCOPES = [
  'events:ingest',
  'events:watch',
  'bindings:read',
  'bindings:write',
  'keys:read',
  'keys:write',
  'routes:read',
  'routes:write',
  'sessions:create',
  'sessions:read',
  'sessions:prompt',
  'schedules:read',
  'schedules:write',
  'llm:chat',
  'addons:install',
  'automation:install',
  'users:read',
  'plugins:invoke',
] as const;

export type ServiceScope = (typeof SERVICE_SCOPES)[number];

/**
 * ADR-052: «любой из»-наборы скоупов для гейтов, где зонтичный
 * `automation:install` (установщик пакета) заменяет ресурсный скоуп.
 *
 * Это единственное место, где выражено «замещение»: guard проверяет, что
 * покрыт **хотя бы один** элемент набора. `routes:write`/`schedules:write`
 * остаются самостоятельными (правка чужих правил/расписаний), а
 * `automation:install` — доступ установщика пакета к тем же точкам.
 */
export const SERVICE_SCOPE_SETS = {
  /** Запись правил маршрутизации: `routes:write` или установщик пакета. */
  routesWrite: ['routes:write', 'automation:install'],
  /** Запись расписаний: `schedules:write` или установщик пакета. */
  schedulesWrite: ['schedules:write', 'automation:install'],
  /** Установка агентов и их ролевых промптов: установщик пакета. */
  agentsWrite: ['automation:install'],
} as const;

/** Набор скоупов «достаточно любого из» (см. `SERVICE_SCOPE_SETS`). */
export type ServiceScopeSet = (typeof SERVICE_SCOPE_SETS)[keyof typeof SERVICE_SCOPE_SETS];

/**
 * `true`, если строка — известный скоуп: элемент каталога либо wildcard
 * семейства (`<family>:*`, напр. `events:*`). Глобальный `*` не принимается.
 */
export function isKnownScope(scope: string): boolean {
  if ((SERVICE_SCOPES as readonly string[]).includes(scope)) return true;
  const idx = scope.indexOf(':');
  if (idx <= 0 || idx === scope.length - 1) return false;
  const family = scope.slice(0, idx);
  const rest = scope.slice(idx + 1);
  return rest === '*' && (SERVICE_SCOPE_FAMILIES as readonly string[]).includes(family);
}

/**
 * Проверка покрытия требуемого скоупа выданными:
 * - точное совпадение (`events:ingest` ∈ granted);
 * - wildcard-семейство (`events:*` покрывает любой `events:<x>`);
 * - для запроса `family:*` — только тот же wildcard (не покрывается точными).
 *
 * Глобальный `*` не поддерживается: `hasServiceScope(granted, '*')` → `false`.
 */
export function hasServiceScope(granted: readonly string[], required: string): boolean {
  if (!Array.isArray(granted)) return false;
  if (granted.includes(required)) return true;
  const idx = required.indexOf(':');
  if (idx <= 0 || idx === required.length - 1) return false;
  const family = required.slice(0, idx);
  return granted.includes(`${family}:*`);
}

/**
 * Проверка «достаточно любого из»: покрыт **хотя бы один** элемент `required`
 * (точное совпадение или wildcard-семейство, `hasServiceScope`). Пустой
 * `required` ничего не открывает (fail-closed).
 */
export function hasAnyServiceScope(
  granted: readonly string[],
  required: readonly string[],
): boolean {
  if (!Array.isArray(granted) || !Array.isArray(required) || required.length === 0) return false;
  return required.some((scope) => hasServiceScope(granted, scope));
}

/**
 * ADR-052: service-key инстанса.
 *
 * Секрет (`synth_svc_<base64url>`) не хранится в этой сущности: at-rest лежит
 * только sha256-хеш (внутренняя запись хранилища), наружу отдаётся `prefix`.
 * Полный plaintext — единственный раз в `ServiceApiKeyCreated` при создании.
 */
export interface ServiceApiKey {
  /** `svk_<uuid>`. */
  id: string;
  /** Обязательная метка (уникальна глобально по инстансу, регистронезависимо). */
  label: string;
  description?: string;
  /**
   * Роли синтетического пользователя, которому аутентифицирует ключ (RBAC
   * managed-режима / доступность эндпоинтов).
   */
  roles: GlobalRole[];
  /** Выданные скоупы (каталог + wildcard-семейства; ADR-052, `docs/API_V2.md` §1). */
  scopes: string[];
  /**
   * Проектная проекция: ключ ограничен подмножеством проектов инстанса
   * (ADR-014). Пусто/отсутствует — ключ действует по политике инстанса.
   */
  allowedProjects?: string[];
  /** Лимит запросов/мин (0 — без лимита); не задан — без лимита. */
  rateLimitPerMinute?: number;
  /** ISO-8601 срок действия; заполнен и прошёл — ключ недействителен. */
  expiresAt?: string;
  /** ISO-8601 мягкий отзыв; заполнен — ключ недействителен независимо от срока. */
  revokedAt?: string;
  /** id создателя. */
  createdBy: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601; best-effort отметка использования. */
  lastUsedAt?: string;
  /** Префикс секрета для идентификации в UI (plaintext наружу не отдаётся). */
  prefix: string;
}

/** ADR-052: ответ создания service-key — метаданные + однократно показываемый секрет. */
export interface ServiceApiKeyCreated extends ServiceApiKey {
  /** Plaintext-секрет `synth_svc_<base64url>`; возвращается единственный раз. */
  key: string;
}

/** ADR-052: тело создания service-key (`POST /api/v2/service-keys`). */
export interface CreateServiceApiKeyInput {
  label: string;
  description?: string;
  roles?: GlobalRole[];
  scopes: string[];
  allowedProjects?: string[];
  rateLimitPerMinute?: number;
  expiresAt?: string;
}

/**
 * ADR-052: тело обновления service-key (`PATCH /api/v2/service-keys/:id`).
 * `undefined` — не трогать; `null` — сбросить опциональное значение.
 */
export interface UpdateServiceApiKeyPatch {
  label?: string;
  description?: string | null;
  roles?: GlobalRole[];
  scopes?: string[];
  allowedProjects?: string[] | null;
  rateLimitPerMinute?: number | null;
  expiresAt?: string | null;
}
