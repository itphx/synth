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
    throw Object.assign(new Error(msg), { status: response.status, code })
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

/** Кодирует относительный путь supporting-файла, сохраняя разделители `/`. */
export function encodeFilePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
