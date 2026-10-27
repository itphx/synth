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

const SESSION = 's1'

function makeFile(name: string, type = 'text/plain', content = 'hello'): File {
  return new File([content], name, { type })
}

/** Файл с подменённым размером — создавать 25 МиБ в памяти незачем. */
function oversizedFile(name: string, type = 'application/pdf'): File {
  const file = makeFile(name, type)
  Object.defineProperty(file, 'size', { value: MAX_FILE_BYTES + 1 })
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
  useAttachmentsStore.setState({ bySession: {} })
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
  useAttachmentsStore.setState({ bySession: {} })
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
