/**
 * PROP-090 Ф7: гибридная политика плагинов — контракт серверной стороны.
 *
 * Три уровня силы (PROP-090 §«Гибрид»):
 * - **Уровень 1 — cooperative** (красный): allow-list сервера как политика
 *   соответствия. Локальный core сверяется с политикой сервера перед
 *   активацией плагина; сервер недоступен или политика неизвестна — плагин
 *   работает, но помечен «не проверен сервером»;
 * - **Уровень 2 — server-scoped токены** (зелёный): плагин получает доступ к
 *   серверу только с токеном, привязанным к его `plugin_id`; сервер применяет
 *   политику и отвергает чужую привязку;
 * - **Уровень 3 — attestation** — вне объёма.
 *
 * Модуль browser-safe: только типы и чистые функции (его читает и UI).
 */

/**
 * Режим серверной политики плагинов:
 * - `off` — сервер **не ограничивает** плагины (политика соответствия не
 *   применяется, allow-list не запрашивается);
 * - `allowlist` — сервер ограничивает: разрешены только плагины из списка
 *   `allow` (пустой список — не разрешён никто).
 */
export const PLUGIN_HYBRID_MODES = ['off', 'allowlist'] as const;
export type PluginHybridMode = (typeof PLUGIN_HYBRID_MODES)[number];

/**
 * Сигнал о слое плагинов в **публичном** дискавери (`GET /auth/oidc-meta`).
 *
 * Список имён в сигнале **не публичен** — он живёт в аутентифицированном
 * роуте `GET /api/v2/settings/plugins` (блок `hybrid`). Старые серверы без
 * поля → клиент трактует состояние как «неизвестно».
 */
export interface PluginPolicySignal {
  /** Включён ли слой плагинов на сервере (`plugins.enabled`). */
  enabled: boolean;
  /** Режим серверной политики. */
  mode: PluginHybridMode;
}

/**
 * Эффективная серверная политика плагинов (allow-list).
 *
 * `allow` наполнен только при `mode: 'allowlist'` — в режиме `off` список не
 * имеет силы и наружу не отдаётся.
 */
export interface PluginServerPolicy {
  /** Режим политики. */
  mode: PluginHybridMode;
  /** Имена плагинов, которым сервер разрешает работать. */
  allow: string[];
}

/**
 * Статус проверки плагина сервером:
 * - `allowed` — сервер подтвердил (политика `off` или плагин в allow-list);
 * - `denied` — сервер запретил (плагина нет в allow-list при `allowlist`);
 * - `unverified` — сервер недоступен или политика неизвестна (cooperative).
 */
export type PluginServerPolicyStatus = 'unverified' | 'allowed' | 'denied';

/**
 * Заголовок, которым плагин объявляет свою привязку (`plugin_id`) при обращении
 * к серверу с server-scoped токеном (Уровень 2).
 */
export const PLUGIN_ID_HEADER = 'X-Synth-Plugin-Id';

/**
 * Scope service-key для server-scoped токена плагина (Уровень 2): без него
 * сервер отвергает plugin-bound ключ (fail-closed).
 */
export const PLUGIN_INVOKE_SCOPE = 'plugins:invoke';

/**
 * Статус плагина по серверной политике.
 *
 * `policy` не задана (сервера нет / политика неизвестна) → `unverified`:
 * локальный плагин работает (cooperative), но помечается в UI и API.
 */
export function evaluatePluginServerPolicy(
  policy: PluginServerPolicy | undefined | null,
  pluginName: string,
): PluginServerPolicyStatus {
  if (!policy) return 'unverified';
  if (policy.mode === 'off') return 'allowed';
  return policy.allow.includes(pluginName) ? 'allowed' : 'denied';
}

/**
 * `true`, если серверная политика разрешает плагину работать.
 *
 * Политика неизвестна → `true` (cooperative: сервер не подтвердил, но и не
 * запретил — решение остаётся за владельцем локального инстанса).
 */
export function isPluginAllowedByServerPolicy(
  policy: PluginServerPolicy | undefined | null,
  pluginName: string,
): boolean {
  return evaluatePluginServerPolicy(policy, pluginName) !== 'denied';
}

/**
 * Нормализация сигнала дискавери (сервер может прислать что угодно):
 * неизвестный режим → `undefined` (политика неизвестна → cooperative).
 */
export function parsePluginPolicySignal(raw: unknown): PluginPolicySignal | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const body = raw as { enabled?: unknown; mode?: unknown };
  const mode = body.mode;
  if (mode !== 'off' && mode !== 'allowlist') return undefined;
  return { enabled: body.enabled === true, mode };
}
