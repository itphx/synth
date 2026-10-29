// Инфраструктура API v2 (ADR-095): базовый URL, обёртка fetch, кодирование путей.
export const BASE_URL = '/api/v2'

export async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
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
