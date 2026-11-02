// Тесты домена вложений (ADR-115, B2b): raw XHR-загрузка, chunked-протокол,
// откат на raw у старого сервера, прогресс и разбор ошибок.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CHUNKED_UPLOAD_THRESHOLD_BYTES,
  MAX_UPLOAD_CHUNK_BYTES,
  attachmentContentUrl,
  attachmentContentUrlFromThumb,
  attachmentThumbnailUrl,
  parseUploadError,
  shouldUseChunkedUpload,
  uploadSessionAttachment,
  type UploadedAttachment,
} from './attachments'

const META: UploadedAttachment = {
  id: 'srv_1',
  blobPath: 'attachments/ab/sha',
  sha256: 'sha',
  mime: 'text/plain',
  size: 5,
  name: 'file.txt',
}

type ProgressHandler = (event: { loaded: number; total: number }) => void

/** Минимальный XHR-двойник: тест сам управляет прогрессом и ответом. */
class FakeXhr {
  static instances: FakeXhr[] = []

  upload: { onprogress: ProgressHandler | null } = { onprogress: null }
  status = 0
  responseText = ''
  withCredentials = false
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown
  aborted = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor() {
    FakeXhr.instances.push(this)
  }

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  send(body: unknown): void {
    this.body = body
  }

  abort(): void {
    this.aborted = true
    this.onabort?.()
  }

  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ loaded, total })
  }

  respond(status: number, payload: unknown): void {
    this.status = status
    this.responseText = typeof payload === 'string' ? payload : JSON.stringify(payload)
    this.onload?.()
  }
}

function fileOf(name: string, type = 'text/plain', content = 'hello'): File {
  return new File([content], name, { type })
}

/**
 * Файл с заявленным размером больше порога, но без реального выделения памяти:
 * `slice` подменён, тест видит только запрошенные границы частей.
 */
function slicedFile(
  name: string,
  size: number,
): { file: File; slices: Array<{ start: number; end: number; size: number }> } {
  const file = fileOf(name, 'video/mp4')
  Object.defineProperty(file, 'size', { value: size })
  const slices: Array<{ start: number; end: number; size: number }> = []
  Object.defineProperty(file, 'slice', {
    value: (start: number, end: number) => {
      const size = end - start
      slices.push({ start, end, size })
      return { size, type: 'video/mp4' }
    },
  })
  return { file, slices }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function stubFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const call: FetchCall = {
        url: String(input),
        method: init.method ?? 'GET',
        body: init.body,
      }
      calls.push(call)
      return handler(call)
    }),
  )
  return calls
}

beforeEach(() => {
  FakeXhr.instances = []
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('shouldUseChunkedUpload', () => {
  it('граница 16 МиБ: меньше — raw, ровно и больше — chunked', () => {
    expect(CHUNKED_UPLOAD_THRESHOLD_BYTES).toBe(16 * 1024 * 1024)
    expect(shouldUseChunkedUpload(CHUNKED_UPLOAD_THRESHOLD_BYTES - 1)).toBe(false)
    expect(shouldUseChunkedUpload(CHUNKED_UPLOAD_THRESHOLD_BYTES)).toBe(true)
    expect(shouldUseChunkedUpload(CHUNKED_UPLOAD_THRESHOLD_BYTES + 1)).toBe(true)
    expect(shouldUseChunkedUpload(Number.NaN)).toBe(false)
  })
})

describe('uploadSessionAttachment: raw', () => {
  it('POST с ?name=, Content-Type файла, send(File) и прогрессом', async () => {
    const file = fileOf('my file.txt', 'text/plain')
    const progress: Array<[number, number]> = []
    const promise = uploadSessionAttachment('s1', file, {
      onProgress: (loaded, total) => progress.push([loaded, total]),
    })

    const xhr = FakeXhr.instances.at(-1)!
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('/api/v2/sessions/s1/attachments?name=my%20file.txt')
    expect(xhr.headers['Content-Type']).toBe('text/plain')
    expect(xhr.withCredentials).toBe(true)
    expect(xhr.body).toBe(file)

    xhr.progress(50, 100)
    xhr.respond(201, META)

    await expect(promise).resolves.toEqual(META)
    expect(progress).toEqual([[50, 100]])
  })

  it('без MIME файла шлёт application/octet-stream', async () => {
    const file = fileOf('unknown.bin', '')
    const promise = uploadSessionAttachment('s1', file)
    const xhr = FakeXhr.instances.at(-1)!
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream')
    xhr.respond(201, META)
    await expect(promise).resolves.toEqual(META)
  })

  it('413 отдаёт статус, код и details.maxBytesPerFile', async () => {
    const promise = uploadSessionAttachment('s1', fileOf('big.bin', 'application/pdf'))
    const xhr = FakeXhr.instances.at(-1)!
    xhr.respond(413, {
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'too big',
        details: { maxBytesPerFile: 12345 },
      },
    })

    const error = await promise.catch((err: unknown) => err)
    expect(error).toMatchObject({
      message: 'too big',
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      details: { maxBytesPerFile: 12345 },
    })
  })

  it('abort по сигналу отменяет XHR и отклоняет с AbortError', async () => {
    const controller = new AbortController()
    const promise = uploadSessionAttachment('s1', fileOf('a.txt'), {
      signal: controller.signal,
    })
    const xhr = FakeXhr.instances.at(-1)!

    controller.abort()

    const error = await promise.catch((err: unknown) => err)
    expect(xhr.aborted).toBe(true)
    expect(error).toMatchObject({ name: 'AbortError' })
  })
})

describe('uploadSessionAttachment: chunked', () => {
  it('шлёт части по 8 МиБ, агрегирует прогресс и завершает сессию', async () => {
    const total = CHUNKED_UPLOAD_THRESHOLD_BYTES + 1024 * 1024 // 17 МиБ
    const { file, slices } = slicedFile('big.mp4', total)
    const progress: Array<[number, number]> = []

    const calls = stubFetch(({ method, url, body }) => {
      if (method === 'POST' && url.endsWith('/attachments/uploads')) {
        return jsonResponse({ uploadId: 'u1', maxChunkBytes: MAX_UPLOAD_CHUNK_BYTES }, 201)
      }
      if (method === 'PUT') {
        const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'))
        const size = (body as { size: number }).size
        return jsonResponse({ received: offset + size, nextOffset: offset + size })
      }
      if (method === 'POST' && url.endsWith('/complete')) return jsonResponse(META, 201)
      return new Response(null, { status: 404 })
    })

    await expect(
      uploadSessionAttachment('s1', file, {
        onProgress: (loaded, totalBytes) => progress.push([loaded, totalBytes]),
      }),
    ).resolves.toEqual(META)

    expect(slices.map((slice) => slice.size)).toEqual([
      MAX_UPLOAD_CHUNK_BYTES,
      MAX_UPLOAD_CHUNK_BYTES,
      total - 2 * MAX_UPLOAD_CHUNK_BYTES,
    ])
    expect(progress[0]).toEqual([0, total])
    expect(progress.at(-1)).toEqual([total, total])
    expect(progress.map(([loaded]) => loaded)).toContain(MAX_UPLOAD_CHUNK_BYTES)
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(3)
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/complete'))).toBe(
      true,
    )
  })

  it('не превышает серверный maxChunkBytes, если он меньше потолка', async () => {
    const total = CHUNKED_UPLOAD_THRESHOLD_BYTES + 1024 * 1024
    const { file, slices } = slicedFile('big.mp4', total)
    const serverChunk = 4 * 1024 * 1024

    stubFetch(({ method, url, body }) => {
      if (method === 'POST' && url.endsWith('/attachments/uploads')) {
        return jsonResponse({ uploadId: 'u1', maxChunkBytes: serverChunk }, 201)
      }
      if (method === 'PUT') {
        const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'))
        const size = (body as { size: number }).size
        return jsonResponse({ received: offset + size, nextOffset: offset + size })
      }
      if (method === 'POST' && url.endsWith('/complete')) return jsonResponse(META, 201)
      return new Response(null, { status: 404 })
    })

    await expect(uploadSessionAttachment('s1', file)).resolves.toEqual(META)

    expect(slices).toHaveLength(Math.ceil(total / serverChunk))
    for (const slice of slices) {
      expect(slice.size).toBeLessThanOrEqual(serverChunk)
    }
    expect(slices[0]!.size).toBe(serverChunk)
  })

  it('при ошибке завершения отменяет сессию (DELETE)', async () => {
    const total = CHUNKED_UPLOAD_THRESHOLD_BYTES
    const { file } = slicedFile('big.mp4', total)
    const calls = stubFetch(({ method, url, body }) => {
      if (method === 'POST' && url.endsWith('/attachments/uploads')) {
        return jsonResponse({ uploadId: 'u1', maxChunkBytes: MAX_UPLOAD_CHUNK_BYTES }, 201)
      }
      if (method === 'PUT') {
        const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'))
        const size = (body as { size: number }).size
        return jsonResponse({ received: offset + size, nextOffset: offset + size })
      }
      if (method === 'POST' && url.endsWith('/complete')) {
        return jsonResponse(
          { error: { code: 'INTERNAL', message: 'publish failed' } },
          500,
        )
      }
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(null, { status: 404 })
    })

    const error = await uploadSessionAttachment('s1', file).catch((err: unknown) => err)

    expect(error).toMatchObject({ message: 'publish failed', status: 500 })
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/uploads/u1'))).toBe(
      true,
    )
  })

  it('404 на инициализации (старый сервер) — прозрачный откат на raw', async () => {
    const total = CHUNKED_UPLOAD_THRESHOLD_BYTES
    const { file } = slicedFile('big.mp4', total)
    stubFetch(() => new Response(null, { status: 404 }))

    const promise = uploadSessionAttachment('s1', file)
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1))

    const xhr = FakeXhr.instances.at(-1)!
    expect(xhr.url).toBe('/api/v2/sessions/s1/attachments?name=big.mp4')
    xhr.respond(201, META)

    await expect(promise).resolves.toEqual(META)
  })
})

describe('URL-хелперы', () => {
  it('content и thumb кодируют id сессии/части', () => {
    expect(attachmentContentUrl('s 1', 'p/1')).toBe('/api/v2/sessions/s%201/attachments/p%2F1')
    expect(attachmentThumbnailUrl('s 1', 'p/1')).toBe(
      '/api/v2/sessions/s%201/attachments/p%2F1?variant=thumb',
    )
  })

  it('фоллбек-URL: оригинал по миниатюре, прочие URL — undefined', () => {
    expect(attachmentContentUrlFromThumb('/api/v2/sessions/s1/attachments/p1?variant=thumb')).toBe(
      '/api/v2/sessions/s1/attachments/p1',
    )
    expect(attachmentContentUrlFromThumb('/api/v2/sessions/s1/attachments/p1')).toBeUndefined()
    expect(attachmentContentUrlFromThumb('blob:http://localhost/abc')).toBeUndefined()
    expect(attachmentContentUrlFromThumb('')).toBeUndefined()
  })

  it('parseUploadError терпит не-JSON тело и пустой ответ', () => {
    expect(parseUploadError(500, 'boom')).toMatchObject({ message: 'boom', status: 500 })
    expect(parseUploadError(502, '')).toMatchObject({ message: 'HTTP 502', status: 502 })
  })
})
