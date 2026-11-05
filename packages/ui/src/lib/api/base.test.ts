import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BASE_URL, fetchJSON, encodeFilePath } from './base'

/**
 * Контракт общей обёртки API v2 (`lib/api/base.ts`, ADR-095). Это единственная
 * точка формирования заголовков и разбора ошибок для всех доменов — ошибка здесь
 * ломает весь HTTP-слой. Тесты герметичны: `fetch` замокан, сети нет.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('base.fetchJSON — запрос и разбор ответа', () => {
  it('базовый URL API v2', () => {
    expect(BASE_URL).toBe('/api/v2')
  })

  it('GET: credentials=include, Content-Type=json, тело разобрано', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: 1 }))

    const result = await fetchJSON<{ ok: number }>('/api/v2/thing')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/thing',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    )
    expect(result).toEqual({ ok: 1 })
  })

  it('сливает пользовательские заголовки, сохраняя Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))

    await fetchJSON('/api/v2/thing', { method: 'POST', headers: { 'X-Trace': 'abc' } })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/thing',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace': 'abc' },
      }),
    )
  })

  it('пользователь может переопределить Content-Type (напр. text/plain)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))

    await fetchJSON('/api/v2/thing', { headers: { 'Content-Type': 'text/plain' } })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/thing',
      expect.objectContaining({ headers: { 'Content-Type': 'text/plain' } }),
    )
  })

  it('204 No Content → undefined без разбора тела (DELETE)', async () => {
    const json = vi.fn()
    fetchMock.mockResolvedValue({ ok: true, status: 204, json } as unknown as Response)

    await expect(fetchJSON('/api/v2/thing', { method: 'DELETE' })).resolves.toBeUndefined()
    expect(json).not.toHaveBeenCalled()
  })
})

describe('base.fetchJSON — формат ошибок проекта', () => {
  it('body.detail → текст ошибки', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'Сессия не найдена' }, 404))

    await expect(fetchJSON('/api/v2/x')).rejects.toThrow('Сессия не найдена')
  })

  it('body.error.error → текст ошибки (приоритет над error.message)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { error: 'ENQUEUE_FAILED', message: 'fallback' } }, 400),
    )

    await expect(fetchJSON('/api/v2/x')).rejects.toThrow('ENQUEUE_FAILED')
  })

  it('body.error.message → текст ошибки, если нет detail/error.error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Плохой запрос' } }, 400))

    await expect(fetchJSON('/api/v2/x')).rejects.toThrow('Плохой запрос')
  })

  it('тело без detail/error → фоллбек HTTP <status>', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500))

    await expect(fetchJSON('/api/v2/x')).rejects.toThrow('HTTP 500')
  })

  it('не-JSON тело ошибки → фоллбек "Request failed"', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    } as unknown as Response)

    await expect(fetchJSON('/api/v2/x')).rejects.toThrow('Request failed')
  })

  it('пробрасывает status и code (ADR-075: 409-подтверждение)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED', message: 'нужно подтверждение' } },
        409,
      ),
    )

    await expect(fetchJSON('/api/v2/x')).rejects.toMatchObject({
      message: 'нужно подтверждение',
      status: 409,
      code: 'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED',
    })
  })

  it('code отсутствует в теле → code === undefined', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'boom' } }, 400))

    await expect(fetchJSON('/api/v2/x')).rejects.toMatchObject({ status: 400, code: undefined })
  })

  it('пробрасывает details (ADR-076: 409 «путь занят» — occupied)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'git.repo_exists',
            error: 'Репозиторий занят',
            details: { path: 'taken', occupied: 'repo' },
          },
        },
        409,
      ),
    )

    await expect(fetchJSON('/api/v2/git/repos/clone')).rejects.toMatchObject({
      status: 409,
      code: 'git.repo_exists',
      details: { path: 'taken', occupied: 'repo' },
    })
  })

  it('details отсутствуют в теле → details === undefined', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'boom' } }, 409))

    await expect(fetchJSON('/api/v2/x')).rejects.toMatchObject({ status: 409, details: undefined })
  })
})

describe('base.fetchJSON — дедлайн и внешний signal', () => {
  it('без внешнего signal ставит собственный AbortSignal (дедлайн)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: 1 }))

    await fetchJSON('/api/v2/thing')

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('внешний signal без timeoutMs уходит в fetch как есть (отмена клона)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: 1 }))
    const controller = new AbortController()

    await fetchJSON('/api/v2/thing', { signal: controller.signal })

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.signal).toBe(controller.signal)
  })

  it('внешний signal + timeoutMs → комбинированный signal, внешняя отмена срабатывает', async () => {
    const controller = new AbortController()
    let sawAbort = false
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          sawAbort = true
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }
        if (init.signal?.aborted) onAbort()
        else init.signal?.addEventListener('abort', onAbort)
      })
    })

    const pending = fetchJSON('/api/v2/thing', { signal: controller.signal, timeoutMs: 5_000 }).catch(
      (err: unknown) => err,
    )
    controller.abort()

    await expect(pending).resolves.toMatchObject({ name: 'AbortError' })
    expect(sawAbort).toBe(true)
  })

  it('POST без timeoutMs дефолтным дедлайном не обрывается (долгие мутации)', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(() => resolve(jsonResponse({ ok: 1 })), 20_000)
      })
    })

    let settled = false
    const pending = fetchJSON<{ ok: number }>('/api/v2/thing', { method: 'POST' }).then((value) => {
      settled = true
      return value
    })
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.signal).toBeUndefined()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toEqual({ ok: 1 })
  })

  it('явный timeoutMs работает и для POST', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    })

    const pending = fetchJSON('/api/v2/thing', { method: 'POST', timeoutMs: 3_000 }).catch(
      (err: unknown) => err,
    )
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(pending).resolves.toMatchObject({ name: 'AbortError' })
  })

  it('дедлайн обрывает зависший запрос (AbortError до ответа)', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    })

    const pending = fetchJSON('/api/v2/thing', { timeoutMs: 5_000 }).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(pending).resolves.toMatchObject({ name: 'AbortError' })
  })
})

describe('base.encodeFilePath — кодирование пути supporting-файла', () => {
  it('кодирует сегменты, сохраняя разделители /', () => {
    expect(encodeFilePath('scripts/my file.sh')).toBe('scripts/my%20file.sh')
  })

  it('кодирует пробелы/спецсимволы в каждом сегменте', () => {
    expect(encodeFilePath('a b/c&d/e#f')).toBe('a%20b/c%26d/e%23f')
  })

  it('пустая строка не ломается', () => {
    expect(encodeFilePath('')).toBe('')
  })

  it('вложенные каталоги и юникод', () => {
    expect(encodeFilePath('docs/файл.md')).toBe('docs/%D1%84%D0%B0%D0%B9%D0%BB.md')
  })
})
