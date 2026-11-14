/**
 * ADR-140: связь профиля пользователя с принципалом (ACL-id).
 *
 * `ProfileData.id` — внутренний UUID профиля, а ACL-id (то, что стоит в
 * `project.ownerId`, `project.members`, `session.ownerId`) — идентификатор
 * пользователя из токена: OIDC `sub` либо debug-id (`admin`/`developer`).
 * Из-за расхождения гранты, выданные через UI (каталог отдавал `profile.id`),
 * не совпадали с принципалом, а передача владения не находила получателя.
 *
 * Связь делается через существующий механизм идентичностей (`ADR-089`):
 * при логине профилю привязывается auth-идентичность (`provider: 'auth'`,
 * `externalId` = id пользователя из токена). Миграции схемы не нужны —
 * используется поле `ProfileData.identities`.
 */
import type { ProfileData, ProfileStore, User } from '@itphx/synth-shared';
import { nowISO } from '@itphx/synth-shared';

/** Провайдер auth-идентичности: id пользователя из токена (OIDC `sub`/debug-id). */
export const AUTH_IDENTITY_PROVIDER = 'auth';

/**
 * ACL-id профиля: привязанная auth-идентичность (sub/debug-id) либо
 * `profile.id` (legacy — профиль без auth-идентичности).
 */
export function principalIdOf(profile: ProfileData): string {
  const auth = (profile.identities ?? []).find((i) => i.provider === AUTH_IDENTITY_PROVIDER);
  return auth?.externalId ?? profile.id;
}

/**
 * Привязать auth-идентичность пользователя к его профилю (при логине).
 *
 * Идемпотентно и best-effort: ошибка привязки не ломает вход (логируется
 * вызывающим, без секретов).
 * - профиль с такой auth-идентичностью уже есть → ничего не делаем;
 * - иначе профиль по username → привязываем идентичность;
 * - иначе создаём профиль и привязываем.
 *
 * `linkIdentity` возвращает `null`, если пара `(auth, id)` уже занята другим
 * профилем (конфликт) — это не ошибка входа: факт логируется, вход продолжается.
 */
export async function ensurePrincipalIdentity(profiles: ProfileStore, user: User): Promise<void> {
  const linked = await profiles.findProfileByExternalId(AUTH_IDENTITY_PROVIDER, user.id);
  if (linked) return;

  const byUsername = await profiles.getProfileByUsername(user.username);
  const profile = byUsername ?? await profiles.getOrCreateProfile({
    username: user.username,
    roles: user.roles,
  });

  const updated = await profiles.linkIdentity(profile.id, {
    provider: AUTH_IDENTITY_PROVIDER,
    externalId: user.id,
    linkedAt: nowISO(),
    linkedBy: 'login',
  });

  if (!updated) {
    // Конфликт: пара `(auth, id)` занята другим профилем — перезаписывать нельзя.
    console.warn('[auth] привязка auth-идентичности не выполнена: пара занята другим профилем');
  }
}
