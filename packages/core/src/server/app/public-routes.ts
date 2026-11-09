// F6 (аудит §6.1): allowlist публичных эндпоинтов `/api/v2/*`.
//
// **Единая реализация для обеих сборок** — standalone-core (`server/app.ts`:
// гейт `app.use('/api/*', ...)`) и managed backend (`packages/backend/src/app.ts`:
// гейт `app.use('/api/v2/*', ...)`). Общая логика HTTP живёт в core
// (ADR-017/ADR-018), поэтому backend импортирует allowlist отсюда
// (`packages/backend/src/app/public-routes.ts` — тонкий реэкспорт).
//
// Единственный источник правды и для fail-closed гейта на границе приложения,
// и для переписи маршрутов (`packages/backend/src/app/route-access-census.test.ts`).
// Allowlist — строгий по методу+пути: wildcard по префиксу запрещён, иначе новый
// роутер под тем же префиксом стал бы анонимным молча.
//
// Правило: всё, чего здесь нет, требует аутентификации (`401 UNAUTHORIZED`).
// Добавляя публичный роут, добавь запись сюда и в перепись — гейт и тест
// поедут вместе.

export interface PublicApiRoute {
  method: string;
  path: string;
}

/**
 * Публичные маршруты API v2 (без аутентификации).
 *
 * Почему эти и только эти:
 * - `GET /api/v2/health` — liveness (ADR-094): его опрашивают балансировщик и
 *   pod-probe без кредов;
 * - `GET /api/v2/meta` — возможности инстанса (ADR-118 §8): клиент по ним
 *   сверяет модель сообщений до логина (fail-closed гейт транспорта);
 * - `GET /api/v2/i18n/current|translations/*` — локализация UI до логина.
 */
export const PUBLIC_API_V2_PATHS: readonly PublicApiRoute[] = [
  { method: 'GET', path: '/api/v2/health' },
  { method: 'GET', path: '/api/v2/meta' },
  { method: 'GET', path: '/api/v2/i18n/current' },
  { method: 'GET', path: '/api/v2/i18n/translations/ru' },
  { method: 'GET', path: '/api/v2/i18n/translations/en' },
];

/**
 * Публичен ли запрос к `/api/v2/*` (fail-closed: неизвестное — не публично).
 *
 * `OPTIONS` разрешён явно: это CORS-preflight, кредов у него нет, и Hono-CORS
 * (зарегистрирован раньше гейта) отвечает на него сам, не доходя до
 * обработчиков. Без этой строки гейт ломал бы preflight при любой
 * реконфигурации порядка middleware.
 */
export function isPublicApiV2Path(method: string, path: string): boolean {
  const normalized = method.toUpperCase();
  if (normalized === 'OPTIONS') return true;
  return PUBLIC_API_V2_PATHS.some((route) => route.method === normalized && route.path === path);
}
