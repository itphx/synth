import type { EventIdentity, ProfileStore } from '@itphx/synth-shared';
import { parsePrincipalId } from '@itphx/synth-shared';

/**
 * AD-089: резолвер внешнего отправителя → пользователь инстанса.
 * Порядок: override `identityMap` (principalId, затем chatKey) → профиль
 * (`identities`, по principalId). Неизвестен → null.
 *
 * `identityMap` — ручной override, приоритетнее профиля (**человек** должен
 * побеждать профиль, но явная карта администратора — сильнее всего). Профилей
 * десятки — **не кэшируем** (простота; при необходимости кэш добавится позже).
 */
export function createExternalIdentityResolver(deps: {
  profiles: ProfileStore;
  /** Читается на каждом вызове (live-обновление runtime-настройки). */
  getIdentityMap: () => Record<string, string>;
}): (identity: EventIdentity) => Promise<{ userId: string; displayName?: string } | null> {
  return async (identity) => {
    // 1) override `identityMap`: principalId (человек) → chatKey (чат-фоллбек).
    const map = deps.getIdentityMap();
    if (map) {
      const principalId = identity.principalId;
      if (principalId && map[principalId]) return { userId: map[principalId] };
      const chatKey = identity.chatKey;
      if (chatKey && map[chatKey]) return { userId: map[chatKey] };
    }

    // 2) профиль по внешней идентичности (provider+externalId из principalId).
    const principalId = identity.principalId;
    if (!principalId) return null;
    const parsed = parsePrincipalId(principalId);
    if (!parsed) return null;

    const profile = await deps.profiles.findProfileByExternalId(parsed.provider, parsed.externalId);
    if (!profile) return null;

    const displayName = profile.displayName || profile.username;
    return {
      userId: profile.id,
      ...(displayName ? { displayName } : {}),
    };
  };
}
