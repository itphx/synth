// Классификация сетевых ошибок (нет ответа сервера) — ADR-118/ADR-024.
//
// Нужна, чтобы отличать «сервер/сеть недоступны» (нет HTTP-ответа: таймаут,
// обрыв, DNS) от осмысленного HTTP-статуса (401/403/5xx). Гейт входа по этой
// разнице не должен превращать сетевую ошибку в «гостя» (форма входа с API-ключом
// на managed/OIDC-инстансе — именно этот баг).

/**
 * Ошибка «ответа не было»: `AbortError`/`TimeoutError` (наш дедлайн или
 * пользовательская отмена), `TypeError: Failed to fetch` (fetch не смог
 * установить соединение) и типовые сетевые сообщения браузеров.
 */
export function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const name = (error as { name?: unknown }).name
  if (name === 'AbortError' || name === 'TimeoutError') return true

  // fetch отдаёт TypeError при сетевом сбое/CORS/обрыве соединения.
  if (error instanceof TypeError) return true

  const message = (error as { message?: unknown }).message
  if (typeof message === 'string') {
    return /failed to fetch|networkerror|network request failed|load failed|network error/i.test(message)
  }
  return false
}
