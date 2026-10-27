// attachments: домен API v2 (ADR-115) — загрузка вложений сессии и URL их превью.

import { BASE_URL } from './base'

/** Серверное вложение (ответ `POST /sessions/:id/attachments`). */
export interface UploadedAttachment {
  /** id части сообщения — по нему строится URL байтов (`attachmentContentUrl`). */
  id: string
  /** Content-addressed путь в blob-порту (`attachments/ab/<sha256>`). */
  blobPath: string
  sha256: string
  mime: string
  size: number
  name?: string
}

/** Ошибка API с HTTP-статусом и машинным кодом — как у `fetchJSON` (base.ts). */
interface AttachmentApiError extends Error {
  status?: number
  code?: string
}

/**
 * Разбор ошибки ответа по контракту API v2 (`{error:{code,message}}` / `{detail}`).
 *
 * Дублирует обработку `fetchJSON` осознанно: multipart-запрос **не может** идти
 * через `fetchJSON`, потому что тот жёстко ставит `Content-Type: application/json`,
 * а для `FormData` заголовок (с boundary) обязан проставить браузер. Тот же приём
 * уже используется в `files.uploadFile` (`lib/api/files.ts`).
 */
async function throwUploadError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => ({ detail: 'Upload failed' }))) as {
    detail?: string
    error?: { error?: string; message?: string; code?: string }
  }
  const message =
    body.detail || body.error?.error || body.error?.message || `HTTP ${response.status}`
  throw Object.assign(new Error(message), {
    status: response.status,
    code: body.error?.code,
  }) as AttachmentApiError
}

/**
 * Загружает один файл вложения в сессию (multipart, поле `file`).
 *
 * `Content-Type` намеренно не задаётся — boundary ставит браузер.
 * Ошибки: 413 (размер), 415 (тип), 403/404 (доступ/сессия).
 */
export async function uploadSessionAttachment(
  sessionId: string,
  file: File,
  opts?: { signal?: AbortSignal },
): Promise<UploadedAttachment> {
  const form = new FormData()
  form.append('file', file, file.name)

  const response = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: 'POST',
    body: form,
    credentials: 'include',
    signal: opts?.signal,
  })
  if (!response.ok) await throwUploadError(response)
  return response.json() as Promise<UploadedAttachment>
}

/**
 * URL байтов вложения для `<img src>` (относительный путь).
 *
 * Авторизация — та же, что у остальных запросов (cookie), поэтому путь
 * отдаётся как есть: подставлять токен в query не нужно.
 */
export function attachmentContentUrl(sessionId: string, partId: string): string {
  return `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(partId)}`
}
