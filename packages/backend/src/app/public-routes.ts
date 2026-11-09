// F6 (аудит §6.1): allowlist публичных эндпоинтов `/api/v2/*`.
//
// Реализация перенесена в core (`packages/core/src/server/app/public-routes.ts`):
// общая логика HTTP живёт в core (ADR-017/ADR-018), а allowlist должен быть
// **один** для обеих сборок (standalone и managed) — иначе публичность
// `/api/v2/meta`/`/api/v2/health` разъехалась бы между ними.
//
// Здесь оставлен тонкий реэкспорт, чтобы существующие импорты
// (`./app/public-routes.js` в `src/app.ts` и `src/app/route-access-census.test.ts`)
// не менялись. См. `@itphx/synth-core`.
export { PUBLIC_API_V2_PATHS, isPublicApiV2Path } from '@itphx/synth-core';
export type { PublicApiRoute } from '@itphx/synth-core';
