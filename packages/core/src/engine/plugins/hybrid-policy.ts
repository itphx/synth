/**
 * PROP-090 Ф7: серверная политика плагинов в гибридном режиме — ядро.
 *
 * Контракт (типы, сигнал дискавери, статусы проверки) живёт в `@itphx/synth-shared`
 * (`types/plugin-hybrid.ts`) — его читают и UI, и backend. Здесь — только
 * ядерные помощники:
 *
 * - {@link resolvePluginServerPolicy} — эффективная политика инстанца из
 *   конфига слоя плагинов (runtime > config > defaults);
 * - {@link describePluginServerPolicy} — представление политики для API
 *   (`GET /api/v2/settings/plugins`): список имён отдаётся **только** при
 *   режиме `allowlist` (в режиме `off` он не имеет силы и наружу не уходит).
 *
 * **Семантика режимов** (PROP-090 §«Гибрид»):
 * - `off` — сервер **не ограничивает** плагины: ни клиентский гейт активации,
 *   ни проверка server-scoped токена по allow-list не применяются;
 * - `allowlist` — сервер ограничивает: разрешены только плагины из `allow`
 *   (пустой список — не разрешён никто).
 */
import type { PluginsConfig } from '@itphx/synth-shared';
import { evaluatePluginServerPolicy } from '@itphx/synth-shared';
import type {
  PluginHybridMode,
  PluginPolicySignal,
  PluginServerPolicy,
  PluginServerPolicyStatus,
} from '@itphx/synth-shared';

export {
  evaluatePluginServerPolicy,
  isPluginAllowedByServerPolicy,
  parsePluginPolicySignal,
  PLUGIN_HYBRID_MODES,
  PLUGIN_ID_HEADER,
  PLUGIN_INVOKE_SCOPE,
} from '@itphx/synth-shared';
export type {
  PluginHybridMode,
  PluginPolicySignal,
  PluginServerPolicy,
  PluginServerPolicyStatus,
} from '@itphx/synth-shared';

/**
 * Эффективная серверная политика из конфига слоя плагинов.
 *
 * Пустая политика (`mode: 'off'`) означает «сервер не ограничивает» — не
 * «политика неизвестна». Неизвестность — это отсутствие политики вообще
 * (`undefined`): сервера нет, он недоступен или старый (без сигнала).
 */
export function resolvePluginServerPolicy(
  config: Pick<PluginsConfig, 'hybrid'> | undefined,
): PluginServerPolicy {
  return {
    mode: config?.hybrid?.mode ?? 'off',
    allow: config?.hybrid?.allow ?? [],
  };
}

/**
 * Представление политики для API/UI: список имён — только при `allowlist`.
 *
 * В режиме `off` список не имеет силы, поэтому наружу не отдаётся (`[]`) —
 * так же, как в standalone (`{ mode: 'off', allow: [] }`).
 */
export function describePluginServerPolicy(
  policy: PluginServerPolicy,
): { mode: PluginHybridMode; allow: string[] } {
  return {
    mode: policy.mode,
    allow: policy.mode === 'allowlist' ? [...policy.allow] : [],
  };
}

/**
 * Статус проверки плагина сервером по политике (для API/UI: маркер
 * «не проверен сервером» — cooperative).
 */
export function pluginServerPolicyStatus(
  policy: PluginServerPolicy | undefined | null,
  pluginName: string,
): PluginServerPolicyStatus {
  return evaluatePluginServerPolicy(policy, pluginName);
}

/**
 * Политика по публичному сигналу дискавери (`GET /auth/oidc-meta`).
 *
 * Сигнал **не содержит** списка имён (список не публичен), поэтому:
 * - `mode: 'off'` — политика известна и разрешает всё (сервер не ограничивает);
 * - `mode: 'allowlist'` — список неизвестен → политика **неизвестна**
 *   (`undefined`): клиент остаётся cooperative и уточняет список
 *   аутентифицированным запросом `GET /api/v2/settings/plugins`;
 * - сигнала нет (старый сервер) — политика неизвестна.
 */
export function policyFromSignal(
  signal: PluginPolicySignal | undefined,
): PluginServerPolicy | undefined {
  if (!signal) return undefined;
  if (signal.mode === 'off') return { mode: 'off', allow: [] };
  return undefined;
}
