import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sessionsApi } from './sessions'

/**
 * Домен `sessions` — точечные операции с ToDo (PROP-054): пути/методы и тела
 * мутаций (порядок, очистка, смена статуса/приоритета/связи с планом).
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

const TODOS = [{ id: 't1', content: 'задача', status: 'pending', priority: 'medium' }]

describe('sessionsApi — ToDo сессии (PROP-054)', () => {
  it('getSessionTodos: GET /sessions/:id/todos', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ todos: TODOS }))

    await expect(sessionsApi.getSessionTodos('s 1')).resolves.toEqual({ todos: TODOS })

    expect(urlOf(0)).toBe('/api/v2/sessions/s%201/todos')
    expect(methodOf(0)).toBe('GET')
  })

  it('createSessionTodo: POST .../todos с телом', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ todos: TODOS }, 201))

    await sessionsApi.createSessionTodo('s1', { content: 'задача', priority: 'high' })

    expect(urlOf(0)).toBe('/api/v2/sessions/s1/todos')
    expect(methodOf(0)).toBe('POST')
    expect(bodyOf(0)).toEqual({ content: 'задача', priority: 'high' })
  })

  it('updateSessionTodo: PATCH .../todos/:todoId (связь с планом можно снять)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ todos: TODOS }))

    await sessionsApi.updateSessionTodo('s1', 't1', { status: 'completed', planItemId: null })

    expect(urlOf(0)).toBe('/api/v2/sessions/s1/todos/t1')
    expect(methodOf(0)).toBe('PATCH')
    expect(bodyOf(0)).toEqual({ status: 'completed', planItemId: null })
  })

  it('deleteSessionTodo: DELETE .../todos/:todoId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ todos: [] }))

    await sessionsApi.deleteSessionTodo('s1', 't1')

    expect(urlOf(0)).toBe('/api/v2/sessions/s1/todos/t1')
    expect(methodOf(0)).toBe('DELETE')
  })

  it('reorderSessionTodos: PUT .../todos/order со списком id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ todos: TODOS }))

    await sessionsApi.reorderSessionTodos('s1', ['t2', 't1'])

    expect(urlOf(0)).toBe('/api/v2/sessions/s1/todos/order')
    expect(methodOf(0)).toBe('PUT')
    expect(bodyOf(0)).toEqual({ ids: ['t2', 't1'] })
  })

  it('clearSessionTodos: POST .../todos/clear без статусов — пустое тело', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ todos: [] }))

    await sessionsApi.clearSessionTodos('s1')

    expect(urlOf(0)).toBe('/api/v2/sessions/s1/todos/clear')
    expect(methodOf(0)).toBe('POST')
    expect(bodyOf(0)).toEqual({})
  })

  it('clearSessionTodos: статусы передаются списком', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ todos: [] }))

    await sessionsApi.clearSessionTodos('s1', { statuses: ['completed'] })

    expect(bodyOf(0)).toEqual({ statuses: ['completed'] })
  })
})
