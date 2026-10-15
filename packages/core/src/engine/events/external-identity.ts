import type { EventIdentity, ProfileStore } from '@itphx/synth-shared';
import { parsePrincipalId } from '@itphx/synth-shared';

/**
 * ADR-089: резолвер внешнего отправителя → пользователь инстанса.
 * Порядок: override `identityMap` (principalId, затем chatKey) → профиль
 * (`identities`, по principalId). Неизвестен → null.
 *
 * `identityMap` — ручной override, приоритетнее профиля (**человек** должен
 * побеждать профиль, но явная карта администратора — сильнее всего). Профилей
 * десятки — **не кэшируем** (простота; при необходимости кэш добавится позже).
 *
 * ADR-089 (этап 5): профильная ветка дополнительно возвращает `roles` профиля —
 * базу для эффективных ролей отправителя (`resolveEffectiveRoles`). Ветка
 * override `identityMap` роли **не** знает (карта хранит только id) → `roles`
 * не задаётся (трактуется как «нет ролей», fail-closed).
 *
 * ADR-089 (standalone): `localUserId` — id пользователя инстанса, к которому
 * нормализуется **сопознанный** внешний отправитель. В single-user инстансе
 * человек-владелец один (`local`, паритет с `resolveUserId` и WS-подпиской);
 * без нормализации владельцем сессии становился бы профильный UUID
 * (`ProfileData.id`), и сессия выпадала из `listSessions({ userId: 'local' })`
 * и подписки владельца (`0 subscribers`). Managed/гибрид опцию не задают —
 * там id пользователей реальные (OIDC/профильные) и elevated-правила иные,
 * поведение не меняется.
 */
export function createExternalIdentityResolver(deps: {
  profiles: ProfileStore;
  /** Читается на каждом вызове (live-обновление runtime-настройки). */
  getIdentityMap: () => Record<string, string>;
  /** ADR-089: нормализовать сопознанного внешнего отправителя к локальному пользователю (standalone). */
  localUserId?: string;
}): (
  identity: EventIdentity,
) => Promise<{ userId: string; displayName?: string; roles?: string[] } | null> {
  /** ADR-089: в single-user инстансе любой сопознанный отправитель — локальный владелец. */
  const withLocalUser = (
    resolved: { userId: string; displayName?: string; roles?: string[] },
  ): { userId: string; displayName?: string; roles?: string[] } =>
    deps.localUserId ? { ...resolved, userId: deps.localUserId } : resolved;

  return async (identity) => {
    // 1) override `identityMap`: principalId (человек) → chatKey (чат-фоллбек).
    const map = deps.getIdentityMap();
    if (map) {
      const principalId = identity.principalId;
      if (principalId && map[principalId]) return withLocalUser({ userId: map[principalId] });
      const chatKey = identity.chatKey;
      if (chatKey && map[chatKey]) return withLocalUser({ userId: map[chatKey] });
    }

    // 2) профиль по внешней идентичности (provider+externalId из principalId).
    const principalId = identity.principalId;
    if (!principalId) return null;
    const parsed = parsePrincipalId(principalId);
    if (!parsed) return null;

    const profile = await deps.profiles.findProfileByExternalId(parsed.provider, parsed.externalId);
    if (!profile) return null;

    const displayName = profile.displayName || profile.username;
    return withLocalUser({
      userId: profile.id,
      ...(displayName ? { displayName } : {}),
      ...(profile.roles ? { roles: profile.roles } : {}),
    });
  };
}
