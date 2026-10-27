// Черновики вложений композера (ADR-115): локальный список, загрузка, ошибки, лимиты.

import { create } from 'zustand'
import { uploadSessionAttachment } from '@/lib/api/attachments'

/** Лимит композера: сколько файлов можно приложить к одному сообщению. */
export const MAX_FILES_PER_MESSAGE = 10

/** Лимит одного файла: 25 МиБ. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024

/** Состояние загрузки одного элемента композера. */
export type AttachmentUploadState = 'pending' | 'uploading' | 'ready' | 'error'

/** Причина отказа — отображается в чипе и переводится через i18n. */
export type AttachmentErrorReason = 'too_many' | 'too_large' | 'upload_failed'

/** Элемент композера: файл + локальный предпросмотр + результат загрузки. */
export interface DraftAttachment {
  /** Локальный id (чип существует до и после загрузки). */
  id: string
  file: File
  name: string
  mimeType: string
  size: number
  /** Локальный object URL для изображений (иначе `''`). */
  previewUrl: string
  /** Группа элементов из одного источника — удаление каскадное. */
  groupId?: string
  /** Сколько элементов в группе (для каскадного удаления и подписей). */
  groupSize?: number
  upload: AttachmentUploadState
  error?: AttachmentErrorReason
  /** id серверного вложения после успешной загрузки. */
  partId?: string
  /** Content-addressed путь blob-порта после успешной загрузки. */
  blobPath?: string
}

interface AttachmentsState {
  bySession: Record<string, DraftAttachment[]>
  /** Добавить файлы и сразу начать их загрузку. */
  addFiles: (sessionId: string, files: File[], opts?: { groupId?: string }) => Promise<void>
  /** Удалить элемент; у элемента с `groupId` удаляется вся группа. */
  remove: (sessionId: string, id: string) => void
  /** Очистить композер сессии, прервав активные загрузки. */
  clear: (sessionId: string) => void
  /** Повторить загрузку элемента, упавшего с ошибкой. */
  retry: (sessionId: string, id: string) => Promise<void>
  /** id успешно загруженных вложений — тело запроса отправки сообщения. */
  readyPartIds: (sessionId: string) => string[]
  /** Есть незавершённые загрузки — отправку блокируем. */
  hasPending: (sessionId: string) => boolean
  /** Освободить object URL при размонтировании композера. */
  dispose: (sessionId: string) => void
}

/** Активные загрузки: ключ `${sessionId}::${id}`. Модульный скоуп — вне React. */
const controllers = new Map<string, AbortController>()

/** Счётчик для фоллбек-id, когда `crypto.randomUUID` недоступен. */
let localIdCounter = 0

function controllerKey(sessionId: string, id: string): string {
  return `${sessionId}::${id}`
}

function createLocalId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `att_${uuid}`
  localIdCounter += 1
  return `att_${Date.now().toString(36)}_${localIdCounter}`
}

function isImage(mimeType: string): boolean {
  return mimeType.toLowerCase().split(';', 1)[0]?.trim().startsWith('image/') ?? false
}

/** Локальный предпросмотр только для изображений (jsdom/старые браузеры — без него). */
function createPreviewUrl(file: File, mimeType: string): string {
  if (!isImage(mimeType)) return ''
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return ''
  try {
    return URL.createObjectURL(file)
  } catch {
    return ''
  }
}

function revokePreviewUrl(item: DraftAttachment): void {
  if (!item.previewUrl) return
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  try {
    URL.revokeObjectURL(item.previewUrl)
  } catch {
    // Освобождение URL — best-effort: ошибка не должна ломать состояние.
  }
}

function abortUpload(sessionId: string, id: string): void {
  const key = controllerKey(sessionId, id)
  const controller = controllers.get(key)
  if (!controller) return
  controller.abort()
  controllers.delete(key)
}

function makeDraft(file: File, groupId?: string): DraftAttachment {
  const mimeType = file.type || 'application/octet-stream'
  return {
    id: createLocalId(),
    file,
    name: file.name,
    mimeType,
    size: file.size,
    previewUrl: createPreviewUrl(file, mimeType),
    groupId,
    upload: 'pending',
  }
}

export const useAttachmentsStore = create<AttachmentsState>()((set, get) => {
  /** Патч одного элемента; если элемент уже удалён — тихо игнорируем. */
  function patch(sessionId: string, id: string, changes: Partial<DraftAttachment>): void {
    set((state) => {
      const list = state.bySession[sessionId]
      if (!list) return state
      const index = list.findIndex((item) => item.id === id)
      if (index < 0) return state
      const next = list.slice()
      next[index] = { ...list[index]!, ...changes }
      return { bySession: { ...state.bySession, [sessionId]: next } }
    })
  }

  /** Загрузка элемента: `pending` → `uploading` → `ready` / `error`. */
  async function upload(sessionId: string, id: string): Promise<void> {
    const item = get().bySession[sessionId]?.find((entry) => entry.id === id)
    if (!item) return

    const controller = new AbortController()
    controllers.set(controllerKey(sessionId, id), controller)
    patch(sessionId, id, { upload: 'uploading', error: undefined })

    try {
      const uploaded = await uploadSessionAttachment(sessionId, item.file, {
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      patch(sessionId, id, {
        upload: 'ready',
        error: undefined,
        partId: uploaded.id,
        blobPath: uploaded.blobPath,
        mimeType: uploaded.mime || item.mimeType,
        size: uploaded.size || item.size,
        name: uploaded.name || item.name,
      })
    } catch {
      // Отмена (clear/remove) — не ошибка: элемент уже уходит из состояния.
      if (controller.signal.aborted) return
      patch(sessionId, id, { upload: 'error', error: 'upload_failed' })
    } finally {
      const key = controllerKey(sessionId, id)
      if (controllers.get(key) === controller) controllers.delete(key)
    }
  }

  return {
    bySession: {},

    async addFiles(sessionId, files, opts) {
      if (!files.length) return
      const groupId = opts?.groupId
      // Снимок читаем до `set`: дедуп и лимиты считать по актуальному списку,
      // а создавать object URL — вне обновления состояния.
      const current = get().bySession[sessionId] ?? []
      const drafts: DraftAttachment[] = []
      let accepted = current.length

      for (const file of files) {
        const duplicate =
          current.some((item) => item.name === file.name && item.size === file.size) ||
          drafts.some((item) => item.name === file.name && item.size === file.size)
        if (duplicate) continue

        const draft = makeDraft(file, groupId)
        if (file.size > MAX_FILE_BYTES) {
          // Превышение размера — элемент не загружается, но причина остаётся в чипе.
          draft.upload = 'error'
          draft.error = 'too_large'
        } else if (accepted >= MAX_FILES_PER_MESSAGE) {
          draft.upload = 'error'
          draft.error = 'too_many'
        } else {
          accepted += 1
        }
        drafts.push(draft)
      }

      if (!drafts.length) return

      if (groupId) {
        const groupSize = current.filter((item) => item.groupId === groupId).length + drafts.length
        for (const draft of drafts) draft.groupSize = groupSize
      }

      set((state) => ({
        bySession: {
          ...state.bySession,
          [sessionId]: [...(state.bySession[sessionId] ?? []), ...drafts],
        },
      }))

      await Promise.all(
        drafts.filter((draft) => draft.upload === 'pending').map((draft) => upload(sessionId, draft.id)),
      )
    },

    remove(sessionId, id) {
      const list = get().bySession[sessionId] ?? []
      const target = list.find((item) => item.id === id)
      if (!target) return
      const removed = target.groupId
        ? list.filter((item) => item.groupId === target.groupId)
        : [target]
      const removedIds = new Set(removed.map((item) => item.id))

      for (const item of removed) {
        abortUpload(sessionId, item.id)
        revokePreviewUrl(item)
      }

      set((state) => {
        const next = (state.bySession[sessionId] ?? []).filter((item) => !removedIds.has(item.id))
        return { bySession: { ...state.bySession, [sessionId]: next } }
      })
    },

    clear(sessionId) {
      const list = get().bySession[sessionId] ?? []
      for (const item of list) {
        abortUpload(sessionId, item.id)
        revokePreviewUrl(item)
      }
      set((state) => ({ bySession: { ...state.bySession, [sessionId]: [] } }))
    },

    async retry(sessionId, id) {
      const list = get().bySession[sessionId] ?? []
      const item = list.find((entry) => entry.id === id)
      if (!item || item.upload !== 'error') return

      // Причину-лимит повторно проверяем: файл мог уменьшиться/освободиться место.
      if (item.file.size > MAX_FILE_BYTES) {
        patch(sessionId, id, { upload: 'error', error: 'too_large' })
        return
      }
      if (item.error === 'too_many') {
        const active = list.filter((entry) => entry.id !== id && entry.upload !== 'error').length
        if (active >= MAX_FILES_PER_MESSAGE) {
          patch(sessionId, id, { upload: 'error', error: 'too_many' })
          return
        }
      }

      await upload(sessionId, id)
    },

    readyPartIds(sessionId) {
      return (get().bySession[sessionId] ?? [])
        .filter((item) => item.upload === 'ready' && !!item.partId)
        .map((item) => item.partId as string)
    },

    hasPending(sessionId) {
      return (get().bySession[sessionId] ?? []).some(
        (item) => item.upload === 'pending' || item.upload === 'uploading',
      )
    },

    dispose(sessionId) {
      const list = get().bySession[sessionId] ?? []
      for (const item of list) {
        abortUpload(sessionId, item.id)
        revokePreviewUrl(item)
      }
      set((state) => {
        const next = { ...state.bySession }
        delete next[sessionId]
        return { bySession: next }
      })
    },
  }
})
