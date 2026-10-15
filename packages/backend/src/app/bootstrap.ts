// Bootstrap-сиды backend.
// Вынесено из `app.ts` (ADR-095, шаг 4b) — «вынос по швам», без изменения поведения.
import type { AuthConfig } from '@itphx/synth-shared';
import type { FileProfileStore } from '@itphx/synth-core';

/**
 * Сидировать профили тестовых пользователей (debug mode). Fire-and-forget
 * (паритет с прежним `app.ts`): старт не блокируется, ошибки пишутся в лог.
 *
 * Вызывается в `createBackendDeps` сразу после сборки хранилищ и **до**
 * построения рантайма (оркестратор/события/шедулер) — как в прежнем `app.ts`,
 * где сид стоял между хранилищами и рантаймом.
 */
export function seedDebugTestUsers(profilesStore: FileProfileStore, auth: AuthConfig): void {
  // Сидирование тестовых пользователей (debug mode)
  if (auth.debugMode && auth.testUsers) {
    for (const tu of auth.testUsers) {
      profilesStore.getOrCreateProfile({
        username: tu.username,
        roles: tu.roles,
      }).catch((e: unknown) => console.warn('seed: failed to create profile for', tu.username, e));
    }
  }
}
