/**
 * CORS origin-политика backend (fail-closed).
 *
 * Приоритет:
 * 1. явный `SYNTH_CORS_ORIGIN` (env) — используется всегда (как раньше);
 * 2. явный dev-режим `SYNTH_CORS_ALLOW_ALL=true` — отражаем запрошенный origin;
 * 3. точное совпадение с белым списком `server.allowedOrigins` — эхо;
 * 4. иначе — `undefined`: заголовки CORS не выставляются.
 *
 * Пустой белый список больше НЕ означает «разрешить всё»: без явного флага
 * произвольный origin не отражается (иначе `credentials: true` + эхо = CSRF-риск).
 * Для локальной разработки открытый CORS включается явно (env-флаг).
 */

export interface CorsOriginOptions {
  /** Белый список `server.allowedOrigins` из конфига. */
  allowedOrigins: string[];
  /** Явный origin из env `SYNTH_CORS_ORIGIN` (приоритетнее белого списка). */
  envOrigin?: string;
  /** Явный dev-режим `SYNTH_CORS_ALLOW_ALL=true` — отражать любой origin. */
  allowAll?: boolean;
}

/** Разрешить ли `origin` для CORS; `undefined` — заголовки не выставляются. */
export function resolveCorsOrigin(
  origin: string | undefined,
  { allowedOrigins, envOrigin, allowAll = false }: CorsOriginOptions,
): string | undefined {
  if (envOrigin) return envOrigin;
  if (allowAll) return origin || undefined;
  // Same-origin/нативные клиенты (нет Origin) в CORS-заголовках не нуждаются.
  if (!origin) return undefined;
  return allowedOrigins.includes(origin) ? origin : undefined;
}
