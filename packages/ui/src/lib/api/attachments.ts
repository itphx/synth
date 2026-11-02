// attachments: домен API v2 (ADR-115) — загрузка вложений сессии и URL их превью.
//
// Два режима загрузки (B2b):
// - **raw** — тело запроса это сам файл (`POST …/attachments?name=…`), браузер
//   стримит `File` из памяти на диск без буферизации; прогресс — `xhr.upload`;
// - **chunked** — крупные файлы частями (`…/attachments/uploads`), чтобы не
//   держать одно длинное соединение и не буферизовать гигабайты в памяти.
// Если сервер не знает chunked-протокол (`404`/`405` на инициализации),
// прозрачно откатываемся на raw.

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

/** Машинные подробности ошибки (`413`: фактический предел инстанса). */
export interface AttachmentErrorDetails {
  maxBytesPerFile?: number
  maxChunkBytes?: number
}

/** Ошибка API с HTTP-статусом и машинным кодом — как у `fetchJSON` (base.ts). */
export interface AttachmentApiError extends Error {
  status?: number
  code?: string
  details?: AttachmentErrorDetails
}

/** Опции загрузки: отмена и прогресс (`loaded`/`total` в байтах). */
export interface UploadSessionAttachmentOptions {
  signal?: AbortSignal
  /** Прогресс отправки; у chunked — агрегированный по уже принятым частям. */
  onProgress?: (loaded: number, total: number) => void
}

/** Порог перехода на chunked-загрузку (16 МиБ). */
export const CHUNKED_UPLOAD_THRESHOLD_BYTES = 16 * 1024 * 1024

/** Больше этого размера часть не отправляется, даже если сервер разрешил. */
export const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024

/** Ответ инициализации chunked-загрузки (`POST …/uploads`). */
export interface UploadSessionInit {
  uploadId: string
  maxChunkBytes: number
}

/** Ответ приёма части (`PUT …/uploads/:uploadId?offset=N`). */
export interface UploadSessionChunk {
  received: number
  nextOffset: number
}

/** Нужна ли chunked-загрузка для файла такого размера. */
export function shouldUseChunkedUpload(size: number): boolean {
  return Number.isFinite(size) && size >= CHUNKED_UPLOAD_THRESHOLD_BYTES
}

interface UploadErrorPayload {
  detail?: string
  error?: {
    error?: string
    message?: string
    code?: string
    details?: AttachmentErrorDetails
  }
}

/**
 * Разбор ошибки ответа по контракту API v2 (`{error:{code,message,details}}` /
 * `{detail}`) — единая точка для raw (XHR) и chunked (fetch) загрузки.
 *
 * `body` — уже прочитанное тело (строка или разобранный объект): XHR отдаёт
 * `responseText`, `fetch` — `Response`. Ошибки парсинга не маскируют исходный
 * статус: сообщение деградирует до `HTTP <status>`.
 */
export function parseUploadError(status: number, body: unknown): AttachmentApiError {
  let payload: UploadErrorPayload = {}
  if (typeof body === 'string') {
    const text = body.trim()
    if (text !== '') {
      try {
        const parsed: unknown = JSON.parse(text)
        payload = parsed && typeof parsed === 'object' ? (parsed as UploadErrorPayload) : {}
      } catch {
        // Не JSON — показываем как есть (полезнее, чем «HTTP 500»).
        payload = { detail: text }
      }
    }
  } else if (body && typeof body === 'object') {
    payload = body as UploadErrorPayload
  }

  const message =
    payload.detail || payload.error?.error || payload.error?.message || `HTTP ${status}`
  return Object.assign(new Error(message), {
    status,
    code: payload.error?.code,
    details: payload.error?.details,
  }) as AttachmentApiError
}

/**
 * Ошибка HTTP-ответа chunked-протокола (`Response`): тело читается и уходит в
 * общий `parseUploadError` — контракт ошибок тот же, что у raw-загрузки.
 */
async function throwUploadError(response: Response): Promise<never> {
  const body = await response.text().catch(() => '')
  throw parseUploadError(response.status, body)
}

/** Ошибка отмены с именем, по которому вызывающий отличает abort от сбоя. */
function abortError(): Error {
  const error = new Error('Upload aborted')
  error.name = 'AbortError'
  return error
}

function parseJsonBody<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** URL списка/сессии chunked-загрузки вложений сессии. */
function uploadsUrl(sessionId: string): string {
  return `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/attachments/uploads`
}

/**
 * RAW-загрузка: `POST …/attachments?name=…`, тело — сам `File`.
 *
 * `XMLHttpRequest` выбран осознанно: только он даёт прогресс отправки
 * (`xhr.upload.onprogress`) и стримит `File` без чтения в `ArrayBuffer`
 * (`fetch` с `File` тоже не буферизует, но прогресса не отдаёт).
 *
 * `Content-Type` — MIME файла (сервер всё равно проверяет сигнатуру); имя
 * передаётся в `?name=` (percent-encoded), чтобы не полагаться на заголовок.
 */
function uploadRaw(
  sessionId: string,
  file: File,
  opts?: UploadSessionAttachmentOptions,
): Promise<UploadedAttachment> {
  return new Promise<UploadedAttachment>((resolve, reject) => {
    const signal = opts?.signal
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    const xhr = new XMLHttpRequest()
    const url = `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/attachments?name=${encodeURIComponent(file.name)}`
    let settled = false

    const handleAbort = () => {
      xhr.abort()
    }
    const cleanup = () => {
      signal?.removeEventListener('abort', handleAbort)
    }
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      run()
    }

    xhr.open('POST', url)
    // Cookie-аутентификация — как у `fetchJSON` (`credentials: 'include'`).
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')

    if (xhr.upload) {
      xhr.upload.onprogress = (event: ProgressEvent) => {
        // `total` может быть 0 при неизвестном размере — подставляем размер файла.
        const total = event.total > 0 ? event.total : file.size
        opts?.onProgress?.(event.loaded, total)
      }
    }

    xhr.onload = () => {
      finish(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const uploaded = parseJsonBody<UploadedAttachment>(xhr.responseText)
          if (uploaded) {
            resolve(uploaded)
            return
          }
          reject(
            Object.assign(new Error(`HTTP ${xhr.status}`), {
              status: xhr.status,
            }) as AttachmentApiError,
          )
          return
        }
        reject(parseUploadError(xhr.status, xhr.responseText))
      })
    }
    xhr.onerror = () => {
      finish(() =>
        reject(
          Object.assign(new Error('Upload failed'), { status: 0 }) as AttachmentApiError,
        ),
      )
    }
    xhr.onabort = () => {
      finish(() => reject(abortError()))
    }

    signal?.addEventListener('abort', handleAbort, { once: true })
    try {
      xhr.send(file)
    } catch (err) {
      finish(() => reject(err))
    }
  })
}

/** Отменить chunked-сессию (best-effort: сервер сам уберёт её по TTL). */
async function cancelUploadSession(base: string, uploadId: string): Promise<void> {
  try {
    await fetch(`${base}/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE',
      credentials: 'include',
    })
  } catch {
    // Отмена — best-effort; исходная ошибка/abort важнее.
  }
}

/**
 * CHUNKED-загрузка крупного файла: инициализация → последовательные части →
 * завершение. Часть — `file.slice(offset, offset + chunkSize)` (браузер отдаёт
 * байты без загрузки всего файла в память), `chunkSize` ограничен и сервером
 * (`maxChunkBytes` из init), и нашим потолком 8 МиБ.
 *
 * При ошибке/abort после инициализации сессия отменяется (`DELETE`), чтобы
 * временный объект не жил до TTL.
 */
async function uploadChunked(
  sessionId: string,
  file: File,
  opts?: UploadSessionAttachmentOptions,
): Promise<UploadedAttachment> {
  const base = uploadsUrl(sessionId)
  const init = await fetch(base, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
    }),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  })

  // Старый сервер: chunked-протокола нет — прозрачный откат на raw-загрузку.
  if (init.status === 404 || init.status === 405) {
    return uploadRaw(sessionId, file, opts)
  }
  if (!init.ok) await throwUploadError(init)

  const info = (await init.json().catch(() => null)) as Partial<UploadSessionInit> | null
  const uploadId = typeof info?.uploadId === 'string' ? info.uploadId : ''
  if (uploadId === '') throw parseUploadError(init.status, info)

  const serverChunkBytes =
    typeof info?.maxChunkBytes === 'number' && info.maxChunkBytes > 0
      ? info.maxChunkBytes
      : MAX_UPLOAD_CHUNK_BYTES
  const chunkSize = Math.max(1, Math.min(serverChunkBytes, MAX_UPLOAD_CHUNK_BYTES))
  const total = file.size
  let offset = 0

  try {
    opts?.onProgress?.(0, total)
    while (offset < total) {
      const end = Math.min(offset + chunkSize, total)
      const chunk = file.slice(offset, end)
      const response = await fetch(
        `${base}/${encodeURIComponent(uploadId)}?offset=${offset}`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunk,
          ...(opts?.signal ? { signal: opts.signal } : {}),
        },
      )
      if (!response.ok) await throwUploadError(response)

      const applied = (await response.json().catch(() => null)) as Partial<UploadSessionChunk> | null
      // Сервер — источник истины о смещении (защита от расхождения среза).
      offset =
        typeof applied?.nextOffset === 'number' && applied.nextOffset > offset
          ? applied.nextOffset
          : end
      opts?.onProgress?.(offset, total)
    }

    const completed = await fetch(`${base}/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST',
      credentials: 'include',
      ...(opts?.signal ? { signal: opts.signal } : {}),
    })
    if (!completed.ok) await throwUploadError(completed)

    const uploaded = (await completed.json().catch(() => null)) as UploadedAttachment | null
    if (!uploaded) throw parseUploadError(completed.status, null)
    opts?.onProgress?.(total, total)
    return uploaded
  } catch (err) {
    await cancelUploadSession(base, uploadId)
    throw err
  }
}

/**
 * Загружает один файл вложения в сессию.
 *
 * Обычные файлы — raw-body потоком (`POST …/attachments?name=…`), крупные
 * (`>= CHUNKED_UPLOAD_THRESHOLD_BYTES`) — частями. Если chunked-протокол
 * недоступен (старый сервер, `404`/`405`), автоматический откат на raw.
 *
 * Ошибки: 413 (размер, `details.maxBytesPerFile`), 415 (тип/вложения выключены),
 * 403/404 (доступ/сессия), `AbortError` при отмене по `signal`.
 */
export async function uploadSessionAttachment(
  sessionId: string,
  file: File,
  opts?: UploadSessionAttachmentOptions,
): Promise<UploadedAttachment> {
  if (shouldUseChunkedUpload(file.size)) return uploadChunked(sessionId, file, opts)
  return uploadRaw(sessionId, file, opts)
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

/**
 * URL серверной миниатюры вложения (`?variant=thumb`, ADR-115).
 *
 * Нет миниатюры (не применима/ещё не сгенерирована) — сервер отвечает `404`,
 * вызывающий подставляет оригинал через `attachmentContentUrl`.
 */
export function attachmentThumbnailUrl(sessionId: string, partId: string): string {
  return `${attachmentContentUrl(sessionId, partId)}?variant=thumb`
}

/** Признак URL миниатюры — тот же суффикс, что добавляет `attachmentThumbnailUrl`. */
const THUMB_QUERY_SUFFIX = '?variant=thumb'

/**
 * Полный контент по URL миниатюры — фоллбек превью, когда миниатюры нет
 * (сервер ответил `404` на `?variant=thumb`, ADR-115).
 *
 * `undefined` — URL не является миниатюрой (локальный object URL черновика).
 */
export function attachmentContentUrlFromThumb(thumbUrl: string): string | undefined {
  if (!thumbUrl.endsWith(THUMB_QUERY_SUFFIX)) return undefined
  return thumbUrl.slice(0, -THUMB_QUERY_SUFFIX.length)
}
