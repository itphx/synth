import { describe, it, expect, afterEach } from 'vitest'

import {
  createMemoryDraftAttachmentStorage,
  getDraftAttachmentStorage,
  setDraftAttachmentStorageForTests,
  type StoredDraftAttachment,
} from './draft-attachments'

const SESSION = 's1'

function stored(overrides: Partial<StoredDraftAttachment> = {}): StoredDraftAttachment {
  return {
    sessionId: SESSION,
    draftId: 'draft-1',
    name: 'a.txt',
    mimeType: 'text/plain',
    size: 5,
    blob: new Blob(['hello'], { type: 'text/plain' }),
    ...overrides,
  }
}

afterEach(() => {
  setDraftAttachmentStorageForTests(null)
})

describe('draft-attachments: in-memory реализация', () => {
  it('put/list/patch сохраняют и обновляют записи', async () => {
    const storage = createMemoryDraftAttachmentStorage()

    await storage.put(stored())
    await storage.put(stored({ draftId: 'draft-2', name: 'b.png', mimeType: 'image/png' }))
    await storage.put(stored({ sessionId: 'other' }))

    const list = await storage.list(SESSION)
    expect(list).toHaveLength(2)
    expect(list.map((item) => item.name).sort()).toEqual(['a.txt', 'b.png'])

    await storage.patch(SESSION, 'draft-1', { partId: 'srv_1', blobPath: 'attachments/ab/1', size: 9 })
    const patched = (await storage.list(SESSION)).find((item) => item.draftId === 'draft-1')!
    expect(patched.partId).toBe('srv_1')
    expect(patched.blobPath).toBe('attachments/ab/1')
    expect(patched.size).toBe(9)
    expect(patched.name).toBe('a.txt')
  })

  it('patch неизвестной записи — no-op', async () => {
    const storage = createMemoryDraftAttachmentStorage()
    await storage.patch(SESSION, 'missing', { partId: 'x' })
    expect(await storage.list(SESSION)).toEqual([])
  })

  it('remove удаляет одну запись, removeSession — все записи сессии', async () => {
    const storage = createMemoryDraftAttachmentStorage()
    await storage.put(stored())
    await storage.put(stored({ draftId: 'draft-2' }))
    await storage.put(stored({ sessionId: 'other' }))

    await storage.remove(SESSION, 'draft-1')
    expect((await storage.list(SESSION)).map((item) => item.draftId)).toEqual(['draft-2'])

    await storage.removeSession(SESSION)
    expect(await storage.list(SESSION)).toEqual([])
    expect(await storage.list('other')).toHaveLength(1)
  })
})

describe('draft-attachments: IndexedDB недоступен (jsdom)', () => {
  it('put/list — тихий no-op, без ошибок', async () => {
    setDraftAttachmentStorageForTests(null)
    expect(typeof indexedDB).toBe('undefined')

    const storage = getDraftAttachmentStorage()
    await expect(storage.put(stored())).resolves.toBeUndefined()
    await expect(storage.list(SESSION)).resolves.toEqual([])
    await expect(storage.patch(SESSION, 'draft-1', { partId: 'x' })).resolves.toBeUndefined()
    await expect(storage.remove(SESSION, 'draft-1')).resolves.toBeUndefined()
    await expect(storage.removeSession(SESSION)).resolves.toBeUndefined()
  })

  it('инъекция тестовой реализации подменяет хранилище', async () => {
    const memory = createMemoryDraftAttachmentStorage()
    setDraftAttachmentStorageForTests(memory)
    expect(getDraftAttachmentStorage()).toBe(memory)

    await getDraftAttachmentStorage().put(stored())
    expect(await memory.list(SESSION)).toHaveLength(1)
  })
})
