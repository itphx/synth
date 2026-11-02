// Персист байтов черновиков композера (ADR-115).
//
// Текст черновика живёт в localStorage (`lib/composer-drafts`), а байты
// вложений — в IndexedDB: localStorage не годится для Blob'ов, а держать
// файлы только в памяти нельзя — reload/выгрузка PWA теряла вложения.
//
// Все операции best-effort: ошибки IDB, приватного режима и квоты
// проглатываются — композер продолжает работать без персиста.

/** Причина отказа вложения (совпадает с `AttachmentErrorReason` стора). */
export type StoredDraftAttachmentError = 'too_many' | 'too_large' | 'upload_failed'

/** Запись черновика вложения в хранилище байтов. */
export interface StoredDraftAttachment {
  sessionId: string
  draftId: string
  name: string
  mimeType: string
  size: number
  blob: Blob
  groupId?: string
  groupSize?: number
  partId?: string
  blobPath?: string
  error?: StoredDraftAttachmentError
}

/** Частичное обновление записи (после загрузки или ошибки). */
export type StoredDraftAttachmentPatch = Partial<
  Pick<
    StoredDraftAttachment,
    'name' | 'mimeType' | 'size' | 'groupId' | 'groupSize' | 'partId' | 'blobPath' | 'error'
  >
>

/** Порт хранилища байтов черновиков (реализации: IndexedDB, in-memory для тестов). */
export interface DraftAttachmentStorage {
  put(record: StoredDraftAttachment): Promise<void>
  patch(sessionId: string, draftId: string, changes: StoredDraftAttachmentPatch): Promise<void>
  remove(sessionId: string, draftId: string): Promise<void>
  removeSession(sessionId: string): Promise<void>
  list(sessionId: string): Promise<StoredDraftAttachment[]>
}

const DB_NAME = 'synth-composer-drafts'
const DB_VERSION = 1
const STORE_NAME = 'attachments'
const KEY_PATH = 'key'
const SESSION_INDEX = 'sessionId'

interface IdbRecord extends StoredDraftAttachment {
  key: string
}

function recordKey(sessionId: string, draftId: string): string {
  return `${sessionId}::${draftId}`
}

function stripKey(record: IdbRecord): StoredDraftAttachment {
  const copy: Partial<IdbRecord> = { ...record }
  delete copy.key
  return copy as StoredDraftAttachment
}

/** Открытая БД на процесс: одна на всё приложение, лениво. */
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: KEY_PATH })
          store.createIndex(SESSION_INDEX, SESSION_INDEX, { unique: false })
        }
      }
      request.onsuccess = () => resolve(request.result)
      // Приватный режим/запрет хранилища: работаем без персиста.
      request.onerror = () => {
        dbPromise = null
        resolve(null)
      }
      request.onblocked = () => {
        dbPromise = null
        resolve(null)
      }
    } catch {
      dbPromise = null
      resolve(null)
    }
  })
  return dbPromise
}

/** Выполнить мутацию в транзакции; любые ошибки — тихо, без reject. */
async function runWrite(
  action: (store: IDBObjectStore) => void,
): Promise<void> {
  const db = await openDatabase()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      let tx: IDBTransaction
      try {
        tx = db.transaction(STORE_NAME, 'readwrite')
      } catch {
        resolve()
        return
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
      try {
        action(tx.objectStore(STORE_NAME))
      } catch {
        resolve()
      }
    })
  } catch {
    // Транзакция не открылась — персист недоступен, UI не ломаем.
  }
}

/** IndexedDB-реализация порта. Без `indexedDB` (jsdom) — no-op. */
export function createIndexedDbDraftAttachmentStorage(): DraftAttachmentStorage {
  return {
    async put(record) {
      await runWrite((store) => {
        store.put({ ...record, key: recordKey(record.sessionId, record.draftId) })
      })
    },

    async patch(sessionId, draftId, changes) {
      await runWrite((store) => {
        const key = recordKey(sessionId, draftId)
        const request = store.get(key)
        request.onsuccess = () => {
          const current = request.result as IdbRecord | undefined
          if (!current) return
          store.put({ ...current, ...changes, key })
        }
      })
    },

    async remove(sessionId, draftId) {
      await runWrite((store) => {
        store.delete(recordKey(sessionId, draftId))
      })
    },

    async removeSession(sessionId) {
      await runWrite((store) => {
        const index = store.index(SESSION_INDEX)
        const request = index.openCursor(sessionId)
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          store.delete(cursor.primaryKey)
          cursor.continue()
        }
      })
    },

    async list(sessionId) {
      const db = await openDatabase()
      if (!db) return []
      try {
        return await new Promise<StoredDraftAttachment[]>((resolve) => {
          let tx: IDBTransaction
          try {
            tx = db.transaction(STORE_NAME, 'readonly')
          } catch {
            resolve([])
            return
          }
          const index = tx.objectStore(STORE_NAME).index(SESSION_INDEX)
          const request = index.getAll(sessionId)
          request.onsuccess = () => {
            const rows = (request.result ?? []) as IdbRecord[]
            resolve(rows.map(stripKey))
          }
          request.onerror = () => resolve([])
          tx.onabort = () => resolve([])
        })
      } catch {
        return []
      }
    },
  }
}

/** In-memory реализация порта — для тестов и инъекции. */
export function createMemoryDraftAttachmentStorage(): DraftAttachmentStorage {
  const records = new Map<string, StoredDraftAttachment>()
  return {
    async put(record) {
      records.set(recordKey(record.sessionId, record.draftId), { ...record })
    },
    async patch(sessionId, draftId, changes) {
      const key = recordKey(sessionId, draftId)
      const current = records.get(key)
      if (!current) return
      records.set(key, { ...current, ...changes })
    },
    async remove(sessionId, draftId) {
      records.delete(recordKey(sessionId, draftId))
    },
    async removeSession(sessionId) {
      for (const [key, record] of records) {
        if (record.sessionId === sessionId) records.delete(key)
      }
    },
    async list(sessionId) {
      return [...records.values()]
        .filter((record) => record.sessionId === sessionId)
        .map((record) => ({ ...record }))
    },
  }
}

let overrideStorage: DraftAttachmentStorage | null = null
let defaultStorage: DraftAttachmentStorage | null = null

/** Текущее хранилище байтов черновиков (ленивая IndexedDB-реализация). */
export function getDraftAttachmentStorage(): DraftAttachmentStorage {
  return overrideStorage ?? (defaultStorage ??= createIndexedDbDraftAttachmentStorage())
}

/**
 * Подменить хранилище в тестах. `null` — вернуть реализацию по умолчанию
 * (IndexedDB, без неё — no-op).
 */
export function setDraftAttachmentStorageForTests(impl: DraftAttachmentStorage | null): void {
  overrideStorage = impl
  if (impl === null) defaultStorage = null
}
