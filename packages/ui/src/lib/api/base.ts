// Инфраструктура API v2 (ADR-095): базовый URL, обёртка fetch, кодирование путей.
export const BASE_URL = '/api/v2'

/**
 * Дедлайн по умолчанию (~15 с) — **только для идемпотентных чтений** (`GET`/
 * `HEAD`): без него зависший запрос (например, медленный `/api/v2/meta` при
 * недоступном сервере) держал старт приложения бесконечно — «Загрузка…» без
 * выхода на экран «Сервер недоступен».
 *
 * Долгие мутации (`POST`/`PUT`/`PATCH`/`DELETE`) дефолтного дедлайна **не
 * получают**: архив, миграции, установка плагина, консолидация памяти идут
 * минутами, и обрыв по таймеру оставлял бы сервер работать «в пустоту».
 * Явный `timeoutMs` работает для любого метода.
 *
 * Внешний `signal` (git-операции, загрузка вложений) означает, что жизненным
 * циклом запроса управляет вызывающий: дефолтный таймаут тогда не ставится,
 * иначе долгий `git clone` обрывался бы на 15-й секунде.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

export interface FetchJSONOptions extends RequestInit {
  /** Явный дедлайн в мс (перекрывает поведение по умолчанию). */
  timeoutMs?: number
}

/**
 * Сигнал с дедлайном, объединённый с внешним `signal`. Возвращает `cleanup`,
 * который снимает таймер и слушатель отмены (вызывать в `finally`).
 */
export function createTimeoutSignal(
  timeoutMs: number,
  external?: AbortSignal | null,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    },
  }
}

export async function fetchJSON<T>(url: string, options?: FetchJSONOptions): Promise<T> {
  const { timeoutMs, signal: externalSignal, ...init } = options ?? {}
  const method = (init.method ?? 'GET').toUpperCase()
  const isIdempotentRead = method === 'GET' || method === 'HEAD'
  // Дефолтный дедлайн — только GET/HEAD; мутации без явного timeoutMs и внешний
  // signal без таймаута управляются вызывающим (долгие операции не обрываем).
  const useTimeout = timeoutMs !== undefined || (isIdempotentRead && !externalSignal)
  const deadline = useTimeout
    ? createTimeoutSignal(timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, externalSignal)
    : null
  // Внешний signal без дедлайна всё равно обязан дойти до fetch (отмена клона и т.п.).
  const requestSignal = deadline?.signal ?? externalSignal

  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
      },
      ...(requestSignal ? { signal: requestSignal } : {}),
    })
  } finally {
    deadline?.cleanup()
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Request failed' }))
    const msg = error.detail || error.error?.error || error.error?.message || `HTTP ${response.status}`
    // `code` (ADR-075) нужен вызывающему, чтобы отличать 409-подтверждение от прочих 409/403.
    const code = error.error?.code
    // `forceRequired` (ADR-114) — признак «нужен явный force» у 409: без него
    // вызывающий не отличит подтверждение удаления (грязный worktree) от прочих
    // конфликтов и не покажет второй шаг подтверждения.
    const forceRequired = error.error?.forceRequired === true
    // `details` — машиночитаемая причина отказа (ADR-076: у 409 «путь занят» —
    // `{path, occupied: 'repo'|'stub'|'dir', entries?}`). Без него вызывающий
    // видит только текст и не может предложить действие (зарегистрировать /
    // удалить / сменить путь).
    const details = error.error?.details
    throw Object.assign(new Error(msg), { status: response.status, code, forceRequired, details })
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

/** Кодирует относительный путь supporting-файла, сохраняя разделители `/`. */
export function encodeFilePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
