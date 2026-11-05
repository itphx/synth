/**
 * Подстановка версии и идентификатора сборки в собранный service worker
 * (`public/sw.js`). Вынесено из `vite.config.ts` чистой функцией, чтобы
 * покрыть тестом: имя кэша обязано меняться при **каждой** сборке, даже если
 * semver не изменился (повторный деплой той же версии).
 */

/** Плейсхолдер версии Synth в `public/sw.js`. */
export const SW_VERSION_PLACEHOLDER = '__SYNTH_VERSION__'
/** Плейсхолдер идентификатора сборки (`SYNTH_BUILD_ID`) в `public/sw.js`. */
export const SW_BUILD_ID_PLACEHOLDER = '__SYNTH_BUILD_ID__'

export interface ServiceWorkerRenderOptions {
  /** Версия Synth (semver из `packages/shared/package.json`). */
  version: string
  /** Идентификатор сборки; пусто — только версия, без «висящего» дефиса. */
  buildId?: string
}

/**
 * Безопасный для имени кэша/JS-строки build id: оставляем только
 * `[A-Za-z0-9._-]` (commit sha проходит как есть, мусор из env — отбрасывается).
 */
function sanitizeBuildId(buildId: string): string {
  return buildId.trim().replace(/[^A-Za-z0-9._-]/g, '')
}

/**
 * Имя кэша шелла: `synth-shell-<version>` либо
 * `synth-shell-<version>-<buildId>` (при непустом build id).
 */
export function serviceWorkerCacheName(version: string, buildId = ''): string {
  const safe = sanitizeBuildId(buildId)
  return safe ? `synth-shell-${version}-${safe}` : `synth-shell-${version}`
}

/** Подставить версию и build id в исходник service worker. */
export function renderServiceWorker(
  source: string,
  options: ServiceWorkerRenderOptions,
): string {
  return source
    .replaceAll(SW_VERSION_PLACEHOLDER, options.version)
    .replaceAll(SW_BUILD_ID_PLACEHOLDER, sanitizeBuildId(options.buildId ?? ''))
}
