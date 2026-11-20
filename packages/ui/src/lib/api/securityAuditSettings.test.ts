import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `security-audit-settings` (`lib/api/securityAuditSettings.ts`):
 * runtime-настройки журнала решений по правам (`/api/v2/settings/audit`).
 * Ценно — пути/методы/**тело** запроса: `PUT` принимает только вложенную форму
 * `{ permission: { … } }` (частичный патч), иначе ядро отвечает `400`.
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

const VIEW = {
  permission: { mode: 'decisions', retentionDays: 30 },
  source: 'default',
  sources: { mode: 'default', retentionDays: 'default' },
  defaults: { mode: 'decisions', retentionDays: 30 },
  envLocked: false,
  envLockedFields: [],
}

describe('securityAuditSettingsApi — журнал решений по правам', () => {
  it('getSecurityAuditSettings: GET /settings/audit', async () => {
    fetchMock.mockResolvedValue(jsonResponse(VIEW))

    await expect(synthApi.getSecurityAuditSettings()).resolves.toEqual(VIEW)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/audit',
      expect.objectContaining({}),
    )
  })

  it('saveSecurityAuditSettings: PUT с вложенным телом {permission: {…}}', async () => {
    const body = {
      ...VIEW,
      permission: { mode: 'all', retentionDays: 60 },
      source: 'runtime',
      sources: { mode: 'runtime', retentionDays: 'runtime' },
    }
    fetchMock.mockResolvedValue(jsonResponse(body))

    const patch = { permission: { mode: 'all' as const, retentionDays: 60 } }
    await expect(synthApi.saveSecurityAuditSettings(patch)).resolves.toEqual(body)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/audit',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ permission: { mode: 'all', retentionDays: 60 } }),
      }),
    )
  })

  it('resetSecurityAuditSettings: DELETE /settings/audit', async () => {
    fetchMock.mockResolvedValue(jsonResponse(VIEW))

    await expect(synthApi.resetSecurityAuditSettings()).resolves.toEqual(VIEW)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/audit',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('нормализует мусорные поля и отбрасывает неизвестные env-фиксации', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        permission: { mode: 'nonsense', retentionDays: 'x' },
        source: 'env',
        sources: { mode: 'env', retentionDays: 'whatever' },
        defaults: { mode: 'all', retentionDays: 7 },
        envLocked: true,
        envLockedFields: ['mode', 'nope'],
      }),
    )

    const res = await synthApi.getSecurityAuditSettings()

    expect(res.permission).toEqual({ mode: 'decisions', retentionDays: 30 })
    expect(res.defaults).toEqual({ mode: 'all', retentionDays: 7 })
    // Неизвестное значение `retentionDays` в `sources` падает на общий `source`.
    expect(res.sources).toEqual({ mode: 'env', retentionDays: 'env' })
    expect(res.envLockedFields).toEqual(['mode'])
  })

  it('прокидывает код и список полей 409 ENV_LOCKED', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'ENV_LOCKED',
            message: 'audit.permission: fixed by env',
            fields: ['mode'],
          },
        },
        409,
      ),
    )

    await expect(
      synthApi.saveSecurityAuditSettings({ permission: { mode: 'all' } }),
    ).rejects.toMatchObject({
      message: 'audit.permission: fixed by env',
      status: 409,
      code: 'ENV_LOCKED',
      fields: ['mode'],
    })
  })
})
