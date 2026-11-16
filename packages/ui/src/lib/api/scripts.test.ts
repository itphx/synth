import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { scriptsApi } from './scripts'

/**
 * Домен `scripts` (`lib/api/scripts.ts`, ADR-126 §5): реестр скриптов сессии и
 * `!`-запуск. Ценно — путь и метод, кодирование id/имени, `?diagnostics=1` и
 * тело запуска (аргументы не переиспользуются при повторе).
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
  vi.unstubAllGlobals()
})

const urlOf = (call: number): string => String(fetchMock.mock.calls[call]?.[0])
const initOf = (call: number): RequestInit => (fetchMock.mock.calls[call]?.[1] ?? {}) as RequestInit
const methodOf = (call: number): string => initOf(call).method ?? 'GET'
const bodyOf = (call: number): unknown => JSON.parse(String(initOf(call).body ?? 'null'))

describe('scriptsApi — реестр скриптов и `!`-запуск (ADR-126 §5)', () => {
  it('listSessionScripts: GET /sessions/:id/scripts, id кодируется', async () => {
    const scripts = [
      {
        name: 'dev',
        description: 'Поднять backend и UI',
        origin: 'project',
        available: true,
        trusted: true,
        background: true,
      },
    ]
    fetchMock.mockResolvedValue(jsonResponse({ scripts }))

    await expect(scriptsApi.listSessionScripts('s 1')).resolves.toEqual({ scripts })

    expect(urlOf(0)).toBe('/api/v2/sessions/s%201/scripts')
    expect(methodOf(0)).toBe('GET')
  })

  it('listSessionScripts: без диагностики query не добавляется', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ scripts: [] }))

    await scriptsApi.listSessionScripts('s1')

    expect(urlOf(0)).toBe('/api/v2/sessions/s1/scripts')
  })

  it('listSessionScripts: diagnostics=1 запрашивает диагностику реестра', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ scripts: [], diagnostics: [] }))

    await scriptsApi.listSessionScripts('s1', { diagnostics: true })

    expect(urlOf(0)).toBe('/api/v2/sessions/s1/scripts?diagnostics=1')
  })

  it('listSessionScripts: ответ проходит как есть (пустой реестр — без поля scripts)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))

    await expect(scriptsApi.listSessionScripts('s1')).resolves.toEqual({})
  })

  it('runSessionScript: POST /sessions/:id/scripts/:name/run, имя кодируется', async () => {
    const response = {
      run_id: 'bgr_1',
      process_id: 'proc_1',
      log_path: 'processes/bgr_1.log',
      status: 'running',
    }
    fetchMock.mockResolvedValue(jsonResponse(response, 202))

    await expect(scriptsApi.runSessionScript('s1', 'dev')).resolves.toEqual(response)

    expect(urlOf(0)).toBe('/api/v2/sessions/s1/scripts/dev/run')
    expect(methodOf(0)).toBe('POST')
    // Повторный запуск идёт без аргументов.
    expect(bodyOf(0)).toEqual({})
  })

  it('runSessionScript: аргументы уходят в теле запроса строкой', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ run_id: 'bgr_1' }, 202))

    await scriptsApi.runSessionScript('s1', 'dev', '--fast')

    expect(bodyOf(0)).toEqual({ arguments: '--fast' })
  })

  it('runSessionScript: без аргументов тело пустое (arguments не требуется)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ run_id: 'bgr_1' }, 202))

    await scriptsApi.runSessionScript('s1', 'dev')

    expect(bodyOf(0)).toEqual({})
  })

  it('runSessionScript: пустая строка аргументов не отправляется', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ run_id: 'bgr_1' }, 202))

    await scriptsApi.runSessionScript('s1', 'dev', '   ')

    expect(bodyOf(0)).toEqual({})
  })

  it('ошибка запуска несёт status и code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'SCRIPT_DENIED', message: 'denied' } }, 403),
    )

    const err = await scriptsApi
      .runSessionScript('s1', 'dev')
      .then(() => null)
      .catch((e: unknown) => e as Error & { status?: number; code?: string })

    expect(err).toBeTruthy()
    expect(err!.message).toBe('denied')
    expect(err!.status).toBe(403)
    expect(err!.code).toBe('SCRIPT_DENIED')
  })
})
