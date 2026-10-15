import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `events` (`lib/api/events.ts`, ADR-089/ADR-052): биндинги, API-ключи
 * привязок, правила маршрутизации, журнал и runtime-настройки. Ценно — тела
 * upsert/patch (в т.ч. `null`, сбрасывающий поле), кодирование id и `limit`.
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

describe('eventsApi — биндинги', () => {
  it('listEventBindings: GET /events/bindings', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ bindings: [] }))
    await synthApi.listEventBindings()
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/events/bindings', expect.objectContaining({}))
  })

  it('upsertEventBinding: POST /events/bindings с телом входа', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'b1' }))
    const input = { source: 'telegram', chatKey: 'c1', sessionId: 's1' }

    await synthApi.upsertEventBinding(input as never)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/events/bindings',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    )
  })

  it('deleteEventBinding: DELETE с кодированием id', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as unknown as Response)
    await synthApi.deleteEventBinding('b/1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/events/bindings/b%2F1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

describe('eventsApi — API-ключи привязки', () => {
  it('getEventBindingKeys: GET /events/bindings/:id/keys', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ keys: [] }))
    await synthApi.getEventBindingKeys('b1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/events/bindings/b1/keys',
      expect.objectContaining({}),
    )
  })

  it('createEventBindingKey: POST .../keys с телами label/description/expiresAt/rateLimit', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ key: 'synth_evt_x' }))
    const input = { label: 'tg', rateLimitPerMinute: 5 }

    await synthApi.createEventBindingKey('b1', input)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/events/bindings/b1/keys',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    )
  })

  it('updateEventBindingKey: PATCH с null (сброс поля) сохраняется в теле', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'k1' }))

    await synthApi.updateEventBindingKey('b1', 'k/1', { description: null, rateLimitPerMinute: 0 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/events/bindings/b1/keys/k%2F1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ description: null, rateLimitPerMinute: 0 }),
      }),
    )
  })

  it('revokeEventBindingKey: POST .../revoke; deleteEventBindingKey: DELETE', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'k1' }))
    await synthApi.revokeEventBindingKey('b1', 'k1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/events/bindings/b1/keys/k1/revoke',
      expect.objectContaining({ method: 'POST' }),
    )

    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as unknown as Response)
    await synthApi.deleteEventBindingKey('b1', 'k1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/events/bindings/b1/keys/k1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

describe('eventsApi — runtime-настройки и журнал', () => {
  it('getEventsSettings: GET /settings/events', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ events: {}, defaults: {}, isOverridden: false }))
    await synthApi.getEventsSettings()
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/settings/events', expect.objectContaining({}))
  })

  it('updateEventsSettings: PUT /settings/events оборачивает в { events }', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ events: { enabled: true } }))
    const settings = { enabled: true, identityMap: { 'tg:1': 'u1' } }

    await synthApi.updateEventsSettings(settings as never)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/events',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ events: settings }) }),
    )
  })

  it('resetEventsSettings: DELETE /settings/events', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ events: {}, defaults: {}, isOverridden: false }))
    await synthApi.resetEventsSettings()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/events',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('getEventJournal: limit добавляется в query только при задании', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [] }))

    await synthApi.getEventJournal()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/events/journal', expect.objectContaining({}))

    await synthApi.getEventJournal(25)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/events/journal?limit=25', expect.objectContaining({}))
  })
})

describe('eventsApi — правила маршрутизации', () => {
  it('getEventRoutes / createEventRoute(id) / deleteEventRoute', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ rules: [] }))
    await synthApi.getEventRoutes()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/events/routes', expect.objectContaining({}))

    const rule = { id: 'r1', match: { source: 'x' }, target: { kind: 'bound' } }
    fetchMock.mockResolvedValue(jsonResponse({ id: 'r1' }))
    await synthApi.createEventRoute(rule as never)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/events/routes',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(rule) }),
    )

    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as unknown as Response)
    await synthApi.deleteEventRoute('r1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/events/routes/r1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
