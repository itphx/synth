import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createTerminalFrameParser,
  terminalsApi,
  toTerminalDto,
  toTerminalPatch,
} from './terminals'

/**
 * Домен `terminals` (`lib/api/terminals.ts`, PROP-132): реальный контракт
 * ядра (`server/routes/terminals.ts`, `engine/terminal/types.ts`).
 *
 * Ценно — snake_case фильтры списка, постраничный ответ, разбор DTO
 * (сервер отдаёт запись реестра в camelCase, добавленные поля — в
 * snake_case) и NDJSON-поток вывода.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** Ответ-поток: тело отдаётся кусками (строки могут быть разрезаны). */
function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let index = 0
  const body = {
    getReader: () => ({
      read: async () => {
        if (index >= chunks.length) return { done: true, value: undefined }
        const value = encoder.encode(chunks[index]!)
        index += 1
        return { done: false, value }
      },
      cancel: async () => undefined,
    }),
  }
  return { ok: true, status: 200, body } as unknown as Response
}

/** DTO так, как его отдаёт сервер (запись — camelCase, добавленные — snake). */
function serverDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'term_1',
    projectId: 'p1',
    sessionId: 's1',
    ownerId: 'local',
    cwd: '/work',
    shell: '/bin/bash',
    status: 'running',
    cols: 80,
    rows: 24,
    title: 'Логи',
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_001_000,
    can_write: true,
    attached_clients: 1,
    ...overrides,
  }
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

describe('terminalsApi — список терминалов', () => {
  it('фильтры уходят в snake_case (project_id/session_id)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ terminals: [], total: 0, offset: 0, limit: 50, next_offset: null }),
    )

    await terminalsApi.list({ projectId: 'p1', sessionId: 's1' })

    expect(urlOf(0)).toBe('/api/v2/terminals?project_id=p1&session_id=s1')
  })

  it('ответ — страница: terminals/total/offset/limit/next_offset', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        terminals: [serverDto()],
        total: 3,
        offset: 10,
        limit: 50,
        next_offset: 60,
      }),
    )

    const page = await terminalsApi.list()

    expect(page.terminals).toHaveLength(1)
    expect(page.terminals[0]?.id).toBe('term_1')
    expect(page.total).toBe(3)
    expect(page.offset).toBe(10)
    expect(page.limit).toBe(50)
    expect(page.nextOffset).toBe(60)
  })

  it('старый сервер с «голым» массивом — приводим к странице', async () => {
    fetchMock.mockResolvedValue(jsonResponse([serverDto()]))

    const page = await terminalsApi.list()

    expect(page.terminals).toHaveLength(1)
    expect(page.nextOffset).toBeNull()
  })
})

describe('terminalsApi — DTO терминала', () => {
  it('camelCase записи сервера маппится в DTO', () => {
    const dto = toTerminalDto(serverDto())

    expect(dto.id).toBe('term_1')
    expect(dto.projectId).toBe('p1')
    expect(dto.sessionId).toBe('s1')
    expect(dto.can_write).toBe(true)
    expect(dto.attached_clients).toBe(1)
    expect(dto.createdAt).toBe(1_700_000_000_000)
    expect(dto.lastActivityAt).toBe(1_700_000_001_000)
    expect(dto.exitCode).toBeNull()
  })

  it('snake_case DTO маппится так же (сервер может перейти на snake_case)', () => {
    const dto = toTerminalDto({
      id: 'term_2',
      project_id: 'p2',
      session_id: null,
      status: 'exited',
      cols: 100,
      rows: 40,
      exit_code: 3,
      created_at: '2026-11-14T00:00:00.000Z',
      last_activity_at: '2026-11-14T00:00:01.000Z',
      can_write: false,
      attached_clients: 2,
    })

    expect(dto.id).toBe('term_2')
    expect(dto.projectId).toBe('p2')
    expect(dto.sessionId).toBeNull()
    expect(dto.status).toBe('exited')
    expect(dto.cols).toBe(100)
    expect(dto.rows).toBe(40)
    expect(dto.exitCode).toBe(3)
    expect(dto.can_write).toBe(false)
    expect(dto.attached_clients).toBe(2)
    expect(dto.createdAt).toBe(Date.parse('2026-11-14T00:00:00.000Z'))
  })

  it('патч события несёт только присутствующие поля', () => {
    const patch = toTerminalPatch({
      terminal_id: 'term_3',
      project_id: 'p3',
      status: 'exited',
      cols: 120,
      rows: 30,
      exit_code: 7,
    })

    expect(patch.id).toBe('term_3')
    expect(patch.projectId).toBe('p3')
    expect(patch.status).toBe('exited')
    expect(patch.cols).toBe(120)
    expect(patch.rows).toBe(30)
    expect(patch.exitCode).toBe(7)
    // Не присланные поля в патче отсутствуют — событие не затирает запись.
    expect('cwd' in patch).toBe(false)
    expect('shell' in patch).toBe(false)
  })

  it('get разбирает обёртку { terminal }', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ terminal: serverDto() }))

    const dto = await terminalsApi.get('term_1')

    expect(urlOf(0)).toBe('/api/v2/terminals/term_1')
    expect(dto.id).toBe('term_1')
    expect(dto.projectId).toBe('p1')
  })
})

describe('terminalsApi — снимок вывода', () => {
  it('разбирает next_seq/truncated/total_bytes/dropped_bytes', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: 'hello',
        seq: 3,
        next_seq: 5,
        truncated: true,
        total_bytes: 1024,
        dropped_bytes: 64,
        chunks: [{ seq: 3, data: 'hello', bytes: 5 }],
      }),
    )

    const snapshot = await terminalsApi.outputSince('term_1', 2)

    expect(urlOf(0)).toBe('/api/v2/terminals/term_1/output?since=2')
    expect(snapshot.data).toBe('hello')
    expect(snapshot.seq).toBe(3)
    expect(snapshot.nextSeq).toBe(5)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.totalBytes).toBe(1024)
    expect(snapshot.droppedBytes).toBe(64)
  })
})

describe('парсер NDJSON потока', () => {
  it('держит неполную строку до следующего куска', () => {
    const frames: Array<{ seq: number; data: string }> = []
    const parser = createTerminalFrameParser((frame) => {
      frames.push({ seq: frame.seq, data: frame.data })
    })

    parser.push('{"seq":1,"dat')
    expect(frames).toHaveLength(0)

    parser.push('a":"x"}\n')
    expect(frames).toEqual([{ seq: 1, data: 'x' }])
  })

  it('разбирает несколько кадров в одном куске', () => {
    const frames: Array<{ seq: number; data: string }> = []
    const parser = createTerminalFrameParser((frame) => {
      frames.push({ seq: frame.seq, data: frame.data })
    })

    parser.push('{"seq":1,"data":"a"}\n{"seq":2,"data":"b"}\n')

    expect(frames).toEqual([
      { seq: 1, data: 'a' },
      { seq: 2, data: 'b' },
    ])
  })

  it('кадр выхода несёт exit_code', () => {
    const frames: Array<{ seq: number; data: string; exitCode?: number }> = []
    const parser = createTerminalFrameParser((frame) => {
      frames.push(frame)
    })

    parser.push('{"seq":4,"data":"","exit_code":0}\n')

    expect(frames).toEqual([{ seq: 4, data: '', exitCode: 0 }])
  })

  it('битый кадр не роняет разбор', () => {
    const frames: Array<{ seq: number; data: string }> = []
    const parser = createTerminalFrameParser((frame) => {
      frames.push({ seq: frame.seq, data: frame.data })
    })

    parser.push('не json\n{"seq":2,"data":"b"}\n')

    expect(frames).toEqual([{ seq: 2, data: 'b' }])
  })
})

describe('terminalsApi — поток вывода', () => {
  it('читает NDJSON-поток и отдаёт кадры и выход', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        '{"seq":6,"data":"he',
        'llo"}\n{"seq":7,"data":"!"}\n{"seq":7,"data":"","exit_code":0}\n',
      ]),
    )

    const chunks: Array<{ seq: number; data: string }> = []
    const exits: Array<{ exitCode?: number; signal?: string }> = []
    await terminalsApi.streamTerminal('term_1', {
      since: 5,
      onChunk: (chunk) => chunks.push(chunk),
      onExit: (info) => exits.push(info),
    })

    expect(urlOf(0)).toBe('/api/v2/terminals/term_1/stream?since=5')
    expect(chunks).toEqual([
      { seq: 6, data: 'hello' },
      { seq: 7, data: '!' },
    ])
    expect(exits).toEqual([{ exitCode: 0 }])
  })

  it('последняя строка без перевода строки дочитывается на flush', async () => {
    fetchMock.mockResolvedValue(streamResponse(['{"seq":1,"data":"tail"}']))

    const chunks: Array<{ seq: number; data: string }> = []
    await terminalsApi.streamTerminal('term_1', {
      onChunk: (chunk) => chunks.push(chunk),
    })

    expect(chunks).toEqual([{ seq: 1, data: 'tail' }])
  })

  it('ошибка ответа: status и машинный код', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'TERMINAL_NOT_FOUND', message: 'нет терминала' } }, 404),
    )

    const err = await terminalsApi
      .streamTerminal('term_1', { onChunk: () => undefined })
      .then(() => null)
      .catch((e: unknown) => e as Error & { status?: number; code?: string })

    expect(err?.message).toBe('нет терминала')
    expect(err?.status).toBe(404)
    expect(err?.code).toBe('TERMINAL_NOT_FOUND')
  })
})
