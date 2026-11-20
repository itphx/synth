import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'
import { PERMISSION_ASK_TIMEOUT_FALLBACK_MS } from './permissionSettings'

/**
 * Домен `permission-settings` (`lib/api/permissionSettings.ts`): правила
 * подтверждений **по умолчанию** (`/api/v2/settings/permissions`).
 *
 * Ценно — пути/методы/**тело** запроса (`PUT` заменяет карту целиком, а не
 * патчит) и нормализация ответа: мусор в правиле не должен ломать форму.
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
  rules: { read_file: 'allow', execute_shell: { 'git status *': 'allow' } },
  source: 'runtime',
  defaults: { rules: { read_file: 'allow' } },
  askTimeoutMs: 300_000,
}

describe('permissionSettingsApi — правила подтверждений по умолчанию', () => {
  it('getPermissionSettings: GET /settings/permissions', async () => {
    fetchMock.mockResolvedValue(jsonResponse(VIEW))

    await expect(synthApi.getPermissionSettings()).resolves.toEqual(VIEW)

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/settings/permissions', expect.objectContaining({}))
  })

  it('savePermissionSettings: PUT с телом {rules: {…}} целиком', async () => {
    fetchMock.mockResolvedValue(jsonResponse(VIEW))

    const rules = {
      read_file: 'allow' as const,
      execute_shell: { 'git status *': 'allow' as const },
    }
    await expect(synthApi.savePermissionSettings({ rules })).resolves.toEqual(VIEW)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/permissions',
      expect.objectContaining({
        method: 'PUT',
        // Тело — ровно карта правил: без обёрток и без патч-семантики.
        body: JSON.stringify({ rules: { read_file: 'allow', execute_shell: { 'git status *': 'allow' } } }),
      }),
    )
  })

  it('resetPermissionSettings: DELETE /settings/permissions', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...VIEW, source: 'config' }))

    const res = await synthApi.resetPermissionSettings()

    expect(res.source).toBe('config')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/permissions',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('нормализует мусор: невалидные правила отбрасываются, источник — default', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        rules: {
          read_file: 'allow',
          broken_action: 'maybe',
          nested: [{ pattern: '*.env', action: 'deny' }],
          empty_key_pattern: '',
          mixed: { '*.env': 'deny', '*.key': 'nonsense', '': 'allow' },
        },
        source: 'nonsense',
        defaults: { rules: { shell: 'deny' } },
        askTimeoutMs: 'soon',
      }),
    )

    const res = await synthApi.getPermissionSettings()

    expect(res.rules).toEqual({ read_file: 'allow', mixed: { '*.env': 'deny' } })
    expect(res.source).toBe('default')
    expect(res.defaults.rules).toEqual({ shell: 'deny' })
    expect(res.askTimeoutMs).toBe(PERMISSION_ASK_TIMEOUT_FALLBACK_MS)
  })

  it('пустой ответ не роняет форму: пустая карта и дефолтный таймаут', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))

    const res = await synthApi.getPermissionSettings()

    expect(res).toEqual({
      rules: {},
      source: 'default',
      defaults: { rules: {} },
      askTimeoutMs: PERMISSION_ASK_TIMEOUT_FALLBACK_MS,
    })
  })

  it('прокидывает 400 VALIDATION_ERROR текстом ошибки', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'permission.rules: невалидные правила ("shell")',
          },
        },
        400,
      ),
    )

    await expect(synthApi.savePermissionSettings({ rules: { shell: 'allow' } })).rejects.toMatchObject({
      message: 'permission.rules: невалидные правила ("shell")',
      status: 400,
      code: 'VALIDATION_ERROR',
    })
  })
})
