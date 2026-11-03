// files: домен API v2 (ADR-095) — объект `filesApi` и его DTO.

import type { DirectoryListResult, FileReadResult } from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

/**
 * Жёсткий предел глубины рекурсивного листинга (`GET /api/v2/fs?maxDepth=`):
 * сервер режет глубину до 3 (`MAX_FS_LIST_DEPTH`), поэтому клиент не просит
 * больше — иначе в ответе просто не будет того, что ожидалось.
 */
export const FS_LIST_MAX_DEPTH = 3

/**
 * Результат `HEAD /fs/raw`: предпросмотр медиа может быть отвергнут **до**
 * загрузки байтов (413 по `storage.maxPreviewBytes`, 404/403). Компонент
 * показывает причину и «Скачать», а не пустой экран/битую картинку.
 * `status: 0` — сеть/проверка недоступны: элемент всё равно пробуем показать.
 */
export interface RawFileProbe {
  ok: boolean
  status: number
  size: number
  limit?: number
  reason?: string
  message?: string
}

export const filesApi = {
  // Файловая система (API v2 — /fs?project_id=&path=)
  async listDirectory(
    projectId: string,
    path?: string,
    includeHidden?: boolean,
    maxDepth?: number,
  ): Promise<DirectoryListResult> {
    const params = new URLSearchParams({ project_id: projectId })
    if (path) params.set('path', path)
    if (includeHidden) params.set('includeHidden', 'true')
    if (maxDepth) {
      const depth = Math.min(Math.max(1, Math.floor(maxDepth)), FS_LIST_MAX_DEPTH)
      params.set('maxDepth', String(depth))
    }
    return fetchJSON<DirectoryListResult>(`${BASE_URL}/fs?${params.toString()}`)
  },

  async readFile(projectId: string, path: string): Promise<FileReadResult> {
    const params = new URLSearchParams({ project_id: projectId, path })
    return fetchJSON<FileReadResult>(`${BASE_URL}/fs/read?${params.toString()}`)
  },

  async writeFile(projectId: string, path: string, content: string): Promise<FileReadResult> {
    return fetchJSON<FileReadResult>(`${BASE_URL}/fs/write`, {
      method: 'POST',
      body: JSON.stringify({ projectId, path, content }),
    })
  },

  async uploadFile(projectId: string, dirPath: string, file: File): Promise<{ path: string; name: string }> {
    const formData = new FormData()
    formData.append('project_id', projectId)
    formData.append('path', dirPath)
    formData.append('file', file)
    const response = await fetch(`${BASE_URL}/fs/upload`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Upload failed' }))
      throw new Error(error.detail || error.error?.error || `HTTP ${response.status}`)
    }
    return response.json()
  },

  downloadFile(projectId: string, path: string): string {
    const params = new URLSearchParams({ project_id: projectId, path })
    return `${BASE_URL}/fs/download?${params.toString()}`
  },

  /**
   * URL предпросмотра файла (ADR-115/этап B): inline только для
   * `INLINE_PREVIEW_KINDS` (image/video/audio/pdf), `Range`/`ETag` — на сервере.
   * HTML/код/текст сервер отдаёт как `attachment` — в `<img>`/`<iframe>` их не
   * ставим (XSS), для них — чтение через `readFile`.
   */
  rawFileUrl(projectId: string, path: string): string {
    const params = new URLSearchParams({ project_id: projectId, path })
    return `${BASE_URL}/fs/raw?${params.toString()}`
  },

  /** Проверка предпросмотра без загрузки байтов (`HEAD /fs/raw`). */
  async probeRawFile(projectId: string, path: string): Promise<RawFileProbe> {
    const params = new URLSearchParams({ project_id: projectId, path })
    let response: Response
    try {
      response = await fetch(`${BASE_URL}/fs/raw?${params.toString()}`, {
        method: 'HEAD',
        credentials: 'include',
      })
    } catch (e) {
      return { ok: false, status: 0, size: 0, reason: 'network', message: (e as Error).message }
    }

    const size = Number(response.headers.get('content-length') ?? 0)
    if (response.ok) {
      return { ok: true, status: response.status, size: Number.isFinite(size) ? size : 0 }
    }

    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string; error?: string; details?: Record<string, unknown> } }
      | null
    const error = body?.error
    const details = error?.details
    // HEAD-ответ приходит без тела (Hono его отбрасывает), поэтому причина
    // отказа и размеры приходят ещё и заголовками (`GET/HEAD /fs/raw`).
    const headerNumber = (name: string): number | undefined => {
      const raw = response.headers.get(name)
      if (raw === null) return undefined
      const value = Number(raw)
      return Number.isFinite(value) ? value : undefined
    }
    const limitValue = Number(
      details?.maxPreviewBytes ?? headerNumber('x-synth-preview-max-bytes') ?? 0,
    )
    const sizeValue = Number(
      details?.size ?? headerNumber('x-synth-preview-size') ?? (Number.isFinite(size) ? size : 0),
    )
    const headerReason = response.headers.get('x-synth-preview-reason')
    // Других `413` у `/fs/raw` нет — без тела и заголовков это отказ по размеру
    // предпросмотра (иначе UI показал бы голый «HTTP 413»).
    const reason =
      (typeof details?.reason === 'string' ? details.reason : undefined) ||
      headerReason ||
      (response.status === 413 ? 'preview_size' : undefined)
    return {
      ok: false,
      status: response.status,
      size: Number.isFinite(sizeValue) ? sizeValue : 0,
      limit: Number.isFinite(limitValue) && limitValue > 0 ? limitValue : undefined,
      reason,
      message:
        error?.message ||
        error?.error ||
        (reason === 'preview_size' ? undefined : `HTTP ${response.status}`),
    }
  },

  async createDirectory(projectId: string, path: string): Promise<{ created: boolean; path: string }> {
    return fetchJSON(`${BASE_URL}/fs/mkdir`, {
      method: 'POST',
      body: JSON.stringify({ projectId, path }),
    })
  },

  async deleteEntry(projectId: string, path: string): Promise<{ deleted: boolean; path: string }> {
    const params = new URLSearchParams({ project_id: projectId, path })
    return fetchJSON(`${BASE_URL}/fs?${params.toString()}`, {
      method: 'DELETE',
    })
  },

  async moveEntry(
    projectId: string,
    sourcePath: string,
    targetPath: string,
    targetProjectId?: string,
  ): Promise<{ moved: boolean; sourcePath: string; targetPath: string }> {
    const body: Record<string, unknown> = { projectId, sourcePath, targetPath }
    if (targetProjectId) body.targetProjectId = targetProjectId
    return fetchJSON(`${BASE_URL}/fs/move`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
}
