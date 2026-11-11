/**
 * Обновление оболочки (app-shell) из UI: сброс кэшей, единая метка «страница
 * перезагружена ради новой сборки» и согласование с `PwaUpdatePrompt`.
 *
 * Зачем метка. Обновление пакета из UI (ADR-133) и авто-обновление PWA
 * (`PwaUpdatePrompt`) — два независимых перезагрузчика. После установки новой
 * версии блок «Обновления» перезагружает страницу, а на загруженной странице
 * `PwaUpdatePrompt` находит новый `waiting`-воркер (файлы `sw.js`/ассетов
 * сменились) и перезагружает ещё раз. Метка говорит PWA: «эту перезагрузку уже
 * сделали ради обновления» — новый воркер принимается **тихо**, без второй
 * перезагрузки.
 */

/** Ключ sessionStorage: когда страница перезагружалась ради новой сборки. */
export const SHELL_RELOAD_STORAGE_KEY = 'synth.appShell.reloadedAt'

/** Окно, в котором перезагрузка считается «только что выполненной». */
export const SHELL_RELOAD_WINDOW_MS = 15_000

/** Ключ sessionStorage: серверный build id, для которого перезагрузка уже сделана. */
export const ACK_BUILD_STORAGE_KEY = 'synth.appShell.ackedBuild'

function readStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    // Приватный режим/квота — работаем без меток.
    return null
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, value)
  } catch {
    // см. readStorage
  }
}

/**
 * Сброс кэшей шелла перед обновлением: при повторном деплое той же semver
 * старый SW мог сохранить `index.html`/карту чанков, из-за чего новые хэши
 * ассетов дают 404. `caches` есть не во всех окружениях (и может быть
 * запрещён) — тогда просто идём дальше.
 */
export async function clearShellCaches(): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    const keys = await caches.keys()
    await Promise.all(keys.map((key) => caches.delete(key)))
  } catch {
    // кэш недоступен — обновление всё равно продолжится
  }
}

/** Пометить, что страница перезагружается ради новой сборки. */
export function markShellReload(now: number = Date.now()): void {
  writeStorage(SHELL_RELOAD_STORAGE_KEY, String(now))
}

/**
 * Забрать метку «перезагрузка ради обновления» (одноразово).
 * `true` — перезагрузка была не позже `maxAgeMs` назад.
 */
export function consumeShellReloadMarker(
  now: number = Date.now(),
  maxAgeMs: number = SHELL_RELOAD_WINDOW_MS,
): boolean {
  const raw = readStorage(SHELL_RELOAD_STORAGE_KEY)
  if (raw === null) return false
  writeStorage(SHELL_RELOAD_STORAGE_KEY, null)
  const at = Number(raw)
  if (!Number.isFinite(at)) return false
  const age = now - at
  return age >= 0 && age <= maxAgeMs
}

/**
 * Запомнить серверный build id, для которого перезагрузка уже выполнена.
 * Нужно, когда build id сервера и бандла расходятся не из-за деплоя (например,
 * `SYNTH_BUILD_ID` остался от образа, а пакет обновлён из npm): иначе PWA
 * перезагружал бы страницу на каждой проверке.
 */
export function acknowledgeBuild(build: string | null): void {
  writeStorage(ACK_BUILD_STORAGE_KEY, build && build.length > 0 ? build : null)
}

/** Build id уже согласован перезагрузкой в этой вкладке. */
export function isBuildAcknowledged(build: string | null): boolean {
  if (!build) return false
  return readStorage(ACK_BUILD_STORAGE_KEY) === build
}

/**
 * Перезагрузить приложение после смены кода: сначала сбросить кэши шелла,
 * затем поставить метку и перезагрузить. Метку читает `PwaUpdatePrompt`, чтобы
 * не перезагружать страницу второй раз из-за нового service worker.
 */
export async function reloadAppShell(): Promise<void> {
  await clearShellCaches()
  markShellReload()
  window.location.reload()
}
