import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `sessions` (`lib/api/sessions.ts`, ADR-095): сессии, ссылки/merge,
 * очередь промпта, sticky notes, оптимизация контекста. Проверяются пути,
 * методы, тела (snake_case-контракт + проброс camelCase-опций) и кодирование id.
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

describe('sessionsApi — список и карточка сессии', () => {
  it('getSessions(): без query, когда projectId не задан', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]))
    await synthApi.getSessions()
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/sessions', expect.objectContaining({}))

    await synthApi.getSessions(null)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/sessions', expect.objectContaining({}))
  })

  it('getSessions(projectId): добавляет project_id с кодированием', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]))
    await synthApi.getSessions('p/1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/sessions?project_id=p%2F1',
      expect.objectContaining({}),
    )
  })

  it('getSession: id кодируется (пробел → %20)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'a b' }))
    await synthApi.getSession('a b')
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/sessions/a%20b', expect.objectContaining({}))
  })

  it('getSessionPrompt / getSessionStats: подпути /prompt и /stats', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    await synthApi.getSessionPrompt('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/prompt',
      expect.objectContaining({}),
    )

    await synthApi.getSessionStats('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/stats',
      expect.objectContaining({}),
    )
  })

  it('createSession / updateSession: POST и PATCH с телом', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 's1' }))

    await synthApi.createSession({ name: 'N', project_id: 'p1' })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'N', project_id: 'p1' }) }),
    )

    await synthApi.updateSession('s1', { name: 'M', color: null })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'M', color: null }) }),
    )
  })

  it('patchSessionMode: PATCH {mode} (ADR-025)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 's1' }))
    await synthApi.patchSessionMode('s1', 'plan')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/sessions/s1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ mode: 'plan' }) }),
    )
  })

  it('deleteSession: DELETE /sessions/:id', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as unknown as Response)
    await expect(synthApi.deleteSession('s1')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/sessions/s1', expect.objectContaining({ method: 'DELETE' }))
  })

  it('forkSession: POST /fork, тело по умолчанию "{}"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 's2' }))
    await synthApi.forkSession('s1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/sessions/s1/fork',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    )

    await synthApi.forkSession('s1', { message_index: 3, title: 'T' })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/fork',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ message_index: 3, title: 'T' }) }),
    )
  })
})

describe('sessionsApi — ссылки и merge (snake_case + проброс опций)', () => {
  it('addSessionReference: source_session_id + camelCase-опции', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ reference: {} }))

    await synthApi.addSessionReference('s1', 'src-1', { label: 'L', messageRange: [1, 5] })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/sessions/s1/references',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source_session_id: 'src-1', label: 'L', messageRange: [1, 5] }),
      }),
    )
  })

  it('getSessionReferences / removeSessionReference: кодирование id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ references: [] }))
    await synthApi.getSessionReferences('s 1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s%201/references',
      expect.objectContaining({}),
    )

    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as unknown as Response)
    await synthApi.removeSessionReference('s1', 'ref/2')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/references/ref%2F2',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('mergeMessages: source_session_id + source_range', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [] }))

    await synthApi.mergeMessages('s1', 'src', { sourceRange: [2, 4], position: 'after' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/sessions/s1/messages/merge',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source_session_id: 'src', source_range: [2, 4], sourceRange: [2, 4], position: 'after' }),
      }),
    )
  })
})

describe('sessionsApi — очередь промпта (прямой fetch)', () => {
  it('enqueueMessage: POST /prompt с телом content/stream/agent/messageId', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => ({}) } as unknown as Response)

    await synthApi.enqueueMessage('s1', 'привет', { agentRole: 'assistant', streamId: 'sid-1' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/sessions/s1/prompt',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'привет', stream: true, agent: 'assistant', messageId: 'sid-1' }),
      }),
    )
  })

  it('enqueueMessage: provider/model попадают в тело, пустые опции отброшены', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => ({}) } as unknown as Response)

    await synthApi.enqueueMessage('s1', 'hi', { streamId: 'sid-2', provider: 'itphx', model: 'm1' })

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body).toEqual({
      content: 'hi',
      stream: true,
      provider: 'itphx',
      model: 'm1',
      messageId: 'sid-2',
    })
    expect('agent' in body).toBe(false)
  })

  it('enqueueMessage: mode=steer уходит в тело, mode=queue не уходит (PROP-098)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => ({}) } as unknown as Response)

    await synthApi.enqueueMessage('s1', 'вмешательство', { streamId: 'sid-3', mode: 'steer' })
    let body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.mode).toBe('steer')

    fetchMock.mockClear()
    await synthApi.enqueueMessage('s1', 'в очередь', { streamId: 'sid-4', mode: 'queue' })
    body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect('mode' in body).toBe(false)
  })

  it('enqueueMessage: ошибка → Error из detail', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'сессия занята' }, 409))

    await expect(synthApi.enqueueMessage('s1', 'x')).rejects.toThrow('сессия занята')
  })

  it('stopGeneration / resumeSubagent: POST /abort и /resume-subagent', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response)
    await synthApi.stopGeneration('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/abort',
      expect.objectContaining({ method: 'POST' }),
    )

    fetchMock.mockResolvedValue(jsonResponse({ status: 'running' }))
    await synthApi.resumeSubagent('child-1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/child-1/resume-subagent',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})

describe('sessionsApi — sticky notes и оптимизация контекста', () => {
  it('sticky notes: add/get/patch/delete с кодированием noteId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ notes: [] }))

    await synthApi.addStickyNote('s1', 'текст')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/notes',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ content: 'текст' }) }),
    )

    await synthApi.updateStickyNote('s1', 'n/1', { disabled: true })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/notes/n%2F1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ disabled: true }) }),
    )

    await synthApi.deleteStickyNote('s1', 'n1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/notes/n1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('getOptimization / updateOptimization: GET и PATCH /optimization', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ context_optimization: 'none' }))
    await synthApi.getOptimization('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/optimization',
      expect.objectContaining({}),
    )

    fetchMock.mockResolvedValue(jsonResponse({ id: 's1' }))
    await synthApi.updateOptimization('s1', { summarization_enabled: true })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/optimization',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ summarization_enabled: true }),
      }),
    )
  })

  it('summarizeSession / cancelSummarization: POST-подпути', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'started' }))
    await synthApi.summarizeSession('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/summarize',
      expect.objectContaining({ method: 'POST' }),
    )

    await synthApi.cancelSummarization('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/optimization/cancel-summarization',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
