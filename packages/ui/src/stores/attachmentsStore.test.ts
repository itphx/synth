import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  uploadSessionAttachment: vi.fn(),
}))

vi.mock('@/lib/api/attachments', () => ({
  uploadSessionAttachment: mocks.uploadSessionAttachment,
  attachmentContentUrl: (sessionId: string, partId: string) =>
    `/api/v2/sessions/${sessionId}/attachments/${partId}`,
}))

import {
  MAX_FILES_PER_MESSAGE,
  MAX_FILE_BYTES,
  useAttachmentsStore,
} from './attachmentsStore'
import { DEFAULT_ATTACHMENT_LIMITS } from '@/lib/attachments/limits'
import {
  createMemoryDraftAttachmentStorage,
  setDraftAttachmentStorageForTests,
  type DraftAttachmentStorage,
} from '@/lib/draft-attachments'

const SESSION = 's1'

let memoryStorage: DraftAttachmentStorage

function makeFile(name: string, type = 'text/plain', content = 'hello'): File {
  return new File([content], name, { type })
}

/** Файл с подменённым размером — создавать 100 МиБ в памяти незачем. */
function oversizedFile(name: string, type = 'application/pdf'): File {
  const file = makeFile(name, type)
  Object.defineProperty(file, 'size', { value: MAX_FILE_BYTES + 1 })
  return file
}

/** Файл с заданным размером (без реального выделения памяти). */
function sizedFile(name: string, size: number, type = 'application/pdf'): File {
  const file = makeFile(name, type)
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function uploaded(id: string) {
  return {
    id,
    blobPath: `attachments/ab/${id}`,
    sha256: `sha-${id}`,
    mime: 'text/plain',
    size: 5,
  }
}

function items(sessionId = SESSION) {
  return useAttachmentsStore.getState().bySession[sessionId] ?? []
}

beforeEach(() => {
  vi.clearAllMocks()
  // `dispose` снимает и guard гидратации: тесты hydrate не должны зависеть от порядка.
  useAttachmentsStore.getState().dispose(SESSION)
  useAttachmentsStore.setState({ bySession: {}, limits: DEFAULT_ATTACHMENT_LIMITS })
  memoryStorage = createMemoryDraftAttachmentStorage()
  setDraftAttachmentStorageForTests(memoryStorage)
  mocks.uploadSessionAttachment.mockImplementation(async (_sessionId: string, file: File) =>
    uploaded(`srv_${file.name}`),
  )
  // jsdom не реализует object URL — подменяем, чтобы проверить жизненный цикл превью.
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:mock-preview'),
    configurable: true,
    writable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  useAttachmentsStore.setState({ bySession: {}, limits: DEFAULT_ATTACHMENT_LIMITS })
  setDraftAttachmentStorageForTests(null)
})

describe('attachmentsStore: добавление и загрузка', () => {
  it('добавляет файл и доводит его до ready с partId', async () => {
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt')])

    const list = items()
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('a.txt')
    expect(list[0]!.upload).toBe('ready')
    expect(list[0]!.partId).toBe('srv_a.txt')
    expect(list[0]!.blobPath).toBe('attachments/ab/srv_a.txt')
    expect(mocks.uploadSessionAttachment).toHaveBeenCalledTimes(1)
    expect(useAttachmentsStore.getState().readyPartIds(SESSION)).toEqual(['srv_a.txt'])
    expect(useAttachmentsStore.getState().hasPending(SESSION)).toBe(false)
  })

  it('превью создаётся только для изображений и освобождается при удалении', async () => {
    await useAttachmentsStore.getState().addFiles(SESSION, [
      makeFile('photo.png', 'image/png'),
      makeFile('doc.txt'),
    ])

    const [image, doc] = items()
    expect(image!.previewUrl).toBe('blob:mock-preview')
    expect(doc!.previewUrl).toBe('')

    useAttachmentsStore.getState().remove(SESSION, image!.id)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-preview')
    expect(items()).toHaveLength(1)
  })

  it('не добавляет дубликат с тем же именем и размером', async () => {
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt')])
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt')])

    expect(items()).toHaveLength(1)
    expect(mocks.uploadSessionAttachment).toHaveBeenCalledTimes(1)
  })

  it('допускает один и тот же размер с другим именем', async () => {
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt'), makeFile('b.txt')])
    expect(items()).toHaveLength(2)
  })
})

describe('attachmentsStore: лимиты', () => {
  it('слишком большой файл не загружается и получает причину too_large', async () => {
    await useAttachmentsStore.getState().addFiles(SESSION, [oversizedFile('big.pdf')])

    const list = items()
    expect(list).toHaveLength(1)
    expect(list[0]!.upload).toBe('error')
    expect(list[0]!.error).toBe('too_large')
    expect(mocks.uploadSessionAttachment).not.toHaveBeenCalled()
    expect(useAttachmentsStore.getState().readyPartIds(SESSION)).toEqual([])
  })

  it('сверх лимита файлов — too_many и без загрузки', async () => {
    const files = Array.from({ length: MAX_FILES_PER_MESSAGE + 2 }, (_, i) => makeFile(`f${i}.txt`))
    await useAttachmentsStore.getState().addFiles(SESSION, files)

    const list = items()
    expect(list).toHaveLength(MAX_FILES_PER_MESSAGE + 2)
    expect(list.filter((item) => item.upload === 'ready')).toHaveLength(MAX_FILES_PER_MESSAGE)
    expect(list.filter((item) => item.error === 'too_many')).toHaveLength(2)
    expect(mocks.uploadSessionAttachment).toHaveBeenCalledTimes(MAX_FILES_PER_MESSAGE)
  })
})

describe('attachmentsStore: ошибки и повтор', () => {
  it('ошибка загрузки даёт upload_failed, retry доводит до ready', async () => {
    mocks.uploadSessionAttachment.mockRejectedValueOnce(new Error('boom'))
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt')])

    const failed = items()[0]!
    expect(failed.upload).toBe('error')
    expect(failed.error).toBe('upload_failed')
    expect(useAttachmentsStore.getState().hasPending(SESSION)).toBe(false)

    await useAttachmentsStore.getState().retry(SESSION, failed.id)

    const retried = items()[0]!
    expect(retried.upload).toBe('ready')
    expect(retried.error).toBeUndefined()
    expect(retried.partId).toBe('srv_a.txt')
    expect(mocks.uploadSessionAttachment).toHaveBeenCalledTimes(2)
  })

  it('retry не запускает загрузку для слишком большого файла', async () => {
    await useAttachmentsStore.getState().addFiles(SESSION, [oversizedFile('big.pdf')])
    const draft = items()[0]!

    await useAttachmentsStore.getState().retry(SESSION, draft.id)

    expect(items()[0]!.error).toBe('too_large')
    expect(mocks.uploadSessionAttachment).not.toHaveBeenCalled()
  })
})

describe('attachmentsStore: восстановление из истории', () => {
  it('restore добавляет ready-элементы, readyPartIds отдаёт blobPath', () => {
    useAttachmentsStore.getState().restore(SESSION, [
      {
        blobPath: 'attachments/ab/one',
        mimeType: 'image/png',
        size: 100,
        name: 'photo.png',
        partId: 'part-1',
        previewUrl: '/api/v2/sessions/s1/attachments/part-1',
      },
      { blobPath: 'attachments/ab/two', mimeType: 'text/plain', size: 10, partId: 'part-2' },
    ])

    const list = items()
    expect(list).toHaveLength(2)
    expect(list.every((item) => item.upload === 'ready')).toBe(true)
    expect(list[0]!.blobPath).toBe('attachments/ab/one')
    expect(list[0]!.partId).toBe('attachments/ab/one')
    expect(list[0]!.previewUrl).toBe('/api/v2/sessions/s1/attachments/part-1')
    expect(list[0]!.file).toBeUndefined()
    expect(list[1]!.name).toBe('two')
    expect(useAttachmentsStore.getState().readyPartIds(SESSION)).toEqual([
      'attachments/ab/one',
      'attachments/ab/two',
    ])
  })

  it('не добавляет дубликат с тем же blobPath', () => {
    const item = { blobPath: 'attachments/ab/one', mimeType: 'image/png', size: 1, partId: 'p' }
    useAttachmentsStore.getState().restore(SESSION, [item])
    useAttachmentsStore.getState().restore(SESSION, [item])

    expect(items()).toHaveLength(1)
  })

  it('соблюдает MAX_FILES_PER_MESSAGE и не трогает существующие элементы', async () => {
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('existing.txt')])
    const existingId = items()[0]!.id

    const restored = Array.from({ length: MAX_FILES_PER_MESSAGE + 2 }, (_, i) => ({
      blobPath: `attachments/ab/${i}`,
      mimeType: 'text/plain',
      size: 1,
      partId: `p${i}`,
    }))
    useAttachmentsStore.getState().restore(SESSION, restored)

    const list = items()
    expect(list).toHaveLength(MAX_FILES_PER_MESSAGE)
    expect(list[0]!.id).toBe(existingId)
  })

  it('retry без исходного File ничего не делает', async () => {
    useAttachmentsStore.getState().restore(SESSION, [
      { blobPath: 'attachments/ab/one', mimeType: 'text/plain', size: 1, partId: 'p' },
    ])
    const draft = items()[0]!
    useAttachmentsStore.setState({
      bySession: { [SESSION]: [{ ...draft, upload: 'error', error: 'upload_failed' }] },
    })

    await useAttachmentsStore.getState().retry(SESSION, draft.id)

    expect(items()[0]!.upload).toBe('error')
    expect(mocks.uploadSessionAttachment).not.toHaveBeenCalled()
  })

  it('dispose не отзывает http-превью восстановленных вложений', () => {
    useAttachmentsStore.getState().restore(SESSION, [
      {
        blobPath: 'attachments/ab/one',
        mimeType: 'image/png',
        size: 1,
        partId: 'p',
        previewUrl: '/api/v2/sessions/s1/attachments/p',
      },
    ])

    useAttachmentsStore.getState().dispose(SESSION)

    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(useAttachmentsStore.getState().bySession[SESSION]).toBeUndefined()
  })
})

describe('attachmentsStore: группы, clear и dispose', () => {
  it('удаление элемента с groupId убирает всю группу', async () => {
    await useAttachmentsStore
      .getState()
      .addFiles(SESSION, [makeFile('one.txt'), makeFile('two.txt')], { groupId: 'g1' })
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('single.txt')])

    const group = items().filter((item) => item.groupId === 'g1')
    expect(group).toHaveLength(2)
    expect(group[0]!.groupSize).toBe(2)

    useAttachmentsStore.getState().remove(SESSION, group[0]!.id)

    const rest = items()
    expect(rest).toHaveLength(1)
    expect(rest[0]!.name).toBe('single.txt')
  })

  it('clear прерывает активные загрузки и очищает список', async () => {
    let signal: AbortSignal | undefined
    mocks.uploadSessionAttachment.mockImplementation((_sessionId: string, _file: File, opts?: { signal?: AbortSignal }) => {
      signal = opts?.signal
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    })

    const pending = useAttachmentsStore.getState().addFiles(SESSION, [makeFile('slow.txt')])
    // Даём загрузке стартовать, затем очищаем композер.
    await Promise.resolve()
    expect(useAttachmentsStore.getState().hasPending(SESSION)).toBe(true)

    useAttachmentsStore.getState().clear(SESSION)
    await pending

    expect(signal?.aborted).toBe(true)
    expect(items()).toHaveLength(0)
  })

  it('dispose освобождает превью и забывает сессию', async () => {
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('photo.png', 'image/png')])

    useAttachmentsStore.getState().dispose(SESSION)

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-preview')
    expect(useAttachmentsStore.getState().bySession[SESSION]).toBeUndefined()
  })
})

describe('attachmentsStore: персист байтов вложений', () => {
  it('addFiles сразу сохраняет байты, upload патчит результат', async () => {
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt')])

    const list = items()
    expect(list).toHaveLength(1)
    const saved = await memoryStorage.list(SESSION)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.draftId).toBe(list[0]!.id)
    expect(saved[0]!.name).toBe('a.txt')
    expect(saved[0]!.mimeType).toBe('text/plain')
    expect(saved[0]!.blob).toBeInstanceOf(Blob)
    // Загрузка завершилась до возврата addFiles — в записи уже есть partId.
    expect(saved[0]!.partId).toBe('srv_a.txt')
    expect(saved[0]!.blobPath).toBe('attachments/ab/srv_a.txt')
  })

  it('413 при загрузке → too_large и в стейте, и в хранилище', async () => {
    mocks.uploadSessionAttachment.mockRejectedValueOnce(
      Object.assign(new Error('too big'), { status: 413 }),
    )
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('big.txt')])

    const draft = items()[0]!
    expect(draft.upload).toBe('error')
    expect(draft.error).toBe('too_large')
    expect((await memoryStorage.list(SESSION))[0]!.error).toBe('too_large')
  })

  it('прочие ошибки загрузки → upload_failed в хранилище', async () => {
    mocks.uploadSessionAttachment.mockRejectedValueOnce(new Error('boom'))
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt')])

    expect(items()[0]!.error).toBe('upload_failed')
    expect((await memoryStorage.list(SESSION))[0]!.error).toBe('upload_failed')
  })

  it('remove удаляет запись, clear — всю сессию', async () => {
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt'), makeFile('b.txt')])
    const [first, second] = items()

    useAttachmentsStore.getState().remove(SESSION, first!.id)
    expect((await memoryStorage.list(SESSION)).map((item) => item.draftId)).toEqual([second!.id])

    useAttachmentsStore.getState().clear(SESSION)
    expect(await memoryStorage.list(SESSION)).toEqual([])
  })
})

describe('attachmentsStore: hydrate после reload', () => {
  it('восстанавливает ready/pending/error, pending дозагружается', async () => {
    await memoryStorage.put({
      sessionId: SESSION,
      draftId: 'ready',
      name: 'ready.txt',
      mimeType: 'text/plain',
      size: 3,
      blob: new Blob(['abc']),
      partId: 'srv_ready',
      blobPath: 'attachments/ab/ready',
    })
    await memoryStorage.put({
      sessionId: SESSION,
      draftId: 'failed',
      name: 'failed.txt',
      mimeType: 'text/plain',
      size: 3,
      blob: new Blob(['bad']),
      error: 'upload_failed',
    })

    let release: (() => void) | undefined
    mocks.uploadSessionAttachment.mockImplementation(async (_sessionId: string, file: File) => {
      if (file.name === 'pending.txt') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return uploaded(`srv_${file.name}`)
    })
    await memoryStorage.put({
      sessionId: SESSION,
      draftId: 'pending',
      name: 'pending.txt',
      mimeType: 'text/plain',
      size: 3,
      blob: new Blob(['xyz']),
    })

    await useAttachmentsStore.getState().hydrate(SESSION)

    const list = items()
    expect(list.map((item) => item.id)).toEqual(['ready', 'failed', 'pending'])
    expect(list[0]!.upload).toBe('ready')
    expect(list[0]!.partId).toBe('srv_ready')
    expect(list[0]!.file).toBeInstanceOf(File)
    expect(list[1]!.upload).toBe('error')
    expect(list[1]!.error).toBe('upload_failed')
    // pending сразу ушёл в повторную загрузку (uploading).
    expect(list[2]!.upload).toBe('uploading')
    expect(useAttachmentsStore.getState().hasPending(SESSION)).toBe(true)
    expect(useAttachmentsStore.getState().hasFailed(SESSION)).toBe(true)
    expect(mocks.uploadSessionAttachment).toHaveBeenCalledWith(
      SESSION,
      expect.any(File),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    release?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(items().find((item) => item.id === 'pending')!.upload).toBe('ready')
    expect(useAttachmentsStore.getState().hasPending(SESSION)).toBe(false)
  })

  it('восстанавливает превью только для изображений', async () => {
    await memoryStorage.put({
      sessionId: SESSION,
      draftId: 'img',
      name: 'photo.png',
      mimeType: 'image/png',
      size: 1,
      blob: new Blob(['x'], { type: 'image/png' }),
      partId: 'srv_img',
    })
    await memoryStorage.put({
      sessionId: SESSION,
      draftId: 'doc',
      name: 'doc.txt',
      mimeType: 'text/plain',
      size: 1,
      blob: new Blob(['y'], { type: 'text/plain' }),
      partId: 'srv_doc',
    })

    await useAttachmentsStore.getState().hydrate(SESSION)

    const [image, doc] = items()
    expect(image!.previewUrl).toBe('blob:mock-preview')
    expect(doc!.previewUrl).toBe('')
  })

  it('идемпотентен и не дублирует уже существующие вложения', async () => {
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt')])

    await useAttachmentsStore.getState().hydrate(SESSION)
    await useAttachmentsStore.getState().hydrate(SESSION)

    expect(items()).toHaveLength(1)
  })

  it('hasFailed ложен без ошибок', async () => {
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt')])
    expect(useAttachmentsStore.getState().hasFailed(SESSION)).toBe(false)
  })
})

describe('attachmentsStore: серверные лимиты инстанса', () => {
  const TWENTY_FIVE_MB = 25 * 1024 * 1024

  it('предпроверка идёт по лимитам инстанса, а не по UX-фоллбеку', async () => {
    useAttachmentsStore.getState().setLimits({
      ...DEFAULT_ATTACHMENT_LIMITS,
      maxBytesPerFile: TWENTY_FIVE_MB,
      maxFilesPerMessage: 2,
    })

    await useAttachmentsStore.getState().addFiles(SESSION, [
      sizedFile('big.pdf', 30 * 1024 * 1024),
      sizedFile('ok.pdf', 20 * 1024 * 1024),
    ])

    const [big, ok] = items()
    expect(big!.upload).toBe('error')
    expect(big!.error).toBe('too_large')
    expect(ok!.upload).toBe('ready')
    expect(ok!.partId).toBe('srv_ok.pdf')
    expect(mocks.uploadSessionAttachment).toHaveBeenCalledTimes(1)
    expect(mocks.uploadSessionAttachment).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ name: 'ok.pdf' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('лимит файлов в сообщении берётся из инстанса', async () => {
    useAttachmentsStore
      .getState()
      .setLimits({ ...DEFAULT_ATTACHMENT_LIMITS, maxFilesPerMessage: 2 })

    await useAttachmentsStore
      .getState()
      .addFiles(SESSION, [makeFile('a.txt'), makeFile('b.txt'), makeFile('c.txt')])

    const list = items()
    expect(list.filter((item) => item.upload === 'ready')).toHaveLength(2)
    expect(list.filter((item) => item.error === 'too_many')).toHaveLength(1)
    expect(mocks.uploadSessionAttachment).toHaveBeenCalledTimes(2)
  })

  it('413 с details.maxBytesPerFile кладёт фактический предел в элемент', async () => {
    mocks.uploadSessionAttachment.mockRejectedValueOnce(
      Object.assign(new Error('too big'), {
        status: 413,
        details: { maxBytesPerFile: TWENTY_FIVE_MB },
      }),
    )

    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('big.txt')])

    const draft = items()[0]!
    expect(draft.upload).toBe('error')
    expect(draft.error).toBe('too_large')
    expect(draft.maxBytes).toBe(TWENTY_FIVE_MB)
    // Runtime-only: в IndexedDB предел не персистится.
    expect('maxBytes' in ((await memoryStorage.list(SESSION))[0]!)).toBe(false)
  })

  it('успешная повторная загрузка очищает maxBytes', async () => {
    mocks.uploadSessionAttachment.mockRejectedValueOnce(
      Object.assign(new Error('too big'), { status: 413, details: { maxBytesPerFile: TWENTY_FIVE_MB } }),
    )
    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt')])
    const draft = items()[0]!
    expect(draft.maxBytes).toBe(TWENTY_FIVE_MB)

    await useAttachmentsStore.getState().retry(SESSION, draft.id)

    const retried = items()[0]!
    expect(retried.upload).toBe('ready')
    expect(retried.maxBytes).toBeUndefined()
  })
})

describe('attachmentsStore: прогресс загрузки', () => {
  it('обновляет progress/uploadedBytes во время загрузки и сбрасывает после ready', async () => {
    let midProgress: number | undefined
    let midUploaded: number | undefined
    mocks.uploadSessionAttachment.mockImplementationOnce(
      async (
        _sessionId: string,
        file: File,
        opts?: { onProgress?: (loaded: number, total: number) => void },
      ) => {
        opts?.onProgress?.(50, 100)
        midProgress = items()[0]!.progress
        midUploaded = items()[0]!.uploadedBytes
        return uploaded(`srv_${file.name}`)
      },
    )

    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt')])

    expect(midProgress).toBe(0.5)
    expect(midUploaded).toBe(50)
    const draft = items()[0]!
    expect(draft.upload).toBe('ready')
    // Прогресс — runtime-подпись `uploading`, у готового элемента её нет.
    expect(draft.progress).toBeUndefined()
    expect(draft.uploadedBytes).toBeUndefined()
  })

  it('финальный прогресс эмитится всегда, промежуточный — с троттлингом', async () => {
    const seen: Array<number | undefined> = []
    mocks.uploadSessionAttachment.mockImplementationOnce(
      async (
        _sessionId: string,
        file: File,
        opts?: { onProgress?: (loaded: number, total: number) => void },
      ) => {
        // Первый кадр — сразу; второй (в пределах 100 мс) — только потому, что файл отправлен.
        opts?.onProgress?.(10, 100)
        seen.push(items()[0]!.progress)
        opts?.onProgress?.(20, 100)
        seen.push(items()[0]!.progress)
        opts?.onProgress?.(100, 100)
        seen.push(items()[0]!.progress)
        return uploaded(`srv_${file.name}`)
      },
    )

    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt')])

    expect(seen).toEqual([0.1, 0.1, 1])
  })

  it('при ошибке прогресс сбрасывается', async () => {
    mocks.uploadSessionAttachment.mockImplementationOnce(
      async (
        _sessionId: string,
        _file: File,
        opts?: { onProgress?: (loaded: number, total: number) => void },
      ) => {
        opts?.onProgress?.(25, 100)
        throw Object.assign(new Error('network'), { status: 500 })
      },
    )

    await useAttachmentsStore.getState().addFiles(SESSION, [makeFile('a.txt')])

    const draft = items()[0]!
    expect(draft.upload).toBe('error')
    expect(draft.error).toBe('upload_failed')
    expect(draft.progress).toBeUndefined()
    expect(draft.uploadedBytes).toBeUndefined()
  })
})
