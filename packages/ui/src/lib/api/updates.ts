// updates: каналы обновлений и проверка обновлений (ADR-133).
//
// Контракт API v2: `GET /updates/check?channel&force` (ADR-133 §2/§3),
// `GET/PUT/DELETE /settings/updates` (канал выводится из установленной версии,
// автопроверка по умолчанию выключена) и `POST /updates/apply` — SSE-поток
// установки (`start`/`progress`/`stderr`/`done`/`error`).
//
// Типы объявлены локально: бизнес-типы живут в core, но тянуть core в
// браузерный бандл нельзя (см. `packages/ui/AGENTS.md`).

import { BASE_URL, fetchJSON } from './base'

/** Канал обновлений в настройках: `auto` — по установленной версии. */
export type UpdateChannel = 'auto' | 'stable' | 'beta'

/** Разрешённый канал проверки (в ответе `auto` уже сведён к одному из них). */
export type ResolvedUpdateChannel = 'stable' | 'beta'

/** Источник эффективного значения настройки (env > runtime > config > default). */
export type UpdatesSettingsSource = 'env' | 'runtime' | 'config' | 'default'

/** `GET/PUT/DELETE /api/v2/settings/updates`. */
export interface UpdatesSettings {
  /** Автопроверка обновлений (по умолчанию выключена). */
  check: boolean
  source: UpdatesSettingsSource
  /** Значение зафиксировано переменной окружения — мутация вернёт 409. */
  envLocked: boolean
  channel: UpdateChannel
  /** Интервал автопроверки, часы. */
  intervalHours: number
  /** Реестр стабильного канала. */
  stableRegistry: string
  /** Реестр бета-канала (Gitea). */
  betaRegistry: string
  restartRequired: boolean
}

/** `GET /api/v2/updates/check` — результат явной проверки. */
export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  /** Канал, по которому шла проверка (`auto` уже разрешён). */
  channel: ResolvedUpdateChannel
  /** Целевая версия — пре-релиз. */
  prerelease: boolean
  /** Реестр, из которого читались dist-теги. */
  registry: string
  hasUpdate: boolean
  checkedAt: string
  /** Причина неудачи проверки (явная проверка возвращает её в теле). */
  error?: string
}

/** События SSE-потока `POST /api/v2/updates/apply`. */
export type UpdateApplyEvent =
  | { type: 'start'; message?: string }
  | { type: 'progress'; data?: string; message?: string }
  | { type: 'stderr'; data?: string; message?: string }
  | { type: 'done'; version?: string; restartScheduled?: boolean; message?: string }
  | { type: 'error'; message?: string }

/** Тело `POST /api/v2/updates/apply`. */
export interface ApplyUpdateInput {
  /** Точная версия; без неё сервер берёт последнюю в канале. */
  version?: string
  channel?: ResolvedUpdateChannel
  /** Перезапустить инстанс после установки (graceful shutdown, exit 75). */
  restart?: boolean
}

/** Тип события `done` (для обработчика успеха). */
export type UpdateDoneEvent = Extract<UpdateApplyEvent, { type: 'done' }>

const CHANNELS: readonly UpdateChannel[] = ['auto', 'stable', 'beta']
const SOURCES: readonly UpdatesSettingsSource[] = ['env', 'runtime', 'config', 'default']

const isChannel = (value: unknown): value is UpdateChannel =>
  typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)

const isSource = (value: unknown): value is UpdatesSettingsSource =>
  typeof value === 'string' && (SOURCES as readonly string[]).includes(value)

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback

function normalizeSettings(raw: unknown): UpdatesSettings {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const interval = typeof body.intervalHours === 'number' ? body.intervalHours : Number(body.intervalHours)
  return {
    check: body.check === true,
    source: isSource(body.source) ? body.source : 'default',
    envLocked: body.envLocked === true,
    channel: isChannel(body.channel) ? body.channel : 'auto',
    intervalHours: Number.isFinite(interval) && interval > 0 ? interval : 24,
    stableRegistry: asString(body.stableRegistry, 'https://registry.npmjs.org'),
    betaRegistry: asString(body.betaRegistry, ''),
    restartRequired: body.restartRequired === true,
  }
}

/** Код машиночитаемой ошибки (`UPDATE_UNSUPPORTED`, `UPDATE_CHECK_FAILED`, …). */
export function updateErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' ? code : undefined
}

/** HTTP-статус ошибки (409 — self-update недоступен, 502 — реестр не ответил). */
export function updateErrorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status
  return typeof status === 'number' ? status : undefined
}

/** Текст ошибки, пригодный для показа пользователю (без «сырого» JSON). */
export function updateErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message
  return fallback
}

/** `true` — самообновление недоступно в этом окружении (Docker/Helm/managed). */
export function isUpdateUnsupported(err: unknown): boolean {
  return updateErrorCode(err) === 'UPDATE_UNSUPPORTED'
}

/** Ошибка не-2xx ответа потока: `{error:{code, message}}` → `Error` с `status`/`code`. */
async function toStreamError(response: Response): Promise<Error> {
  const raw = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string }
    detail?: string
  } | null
  const message = raw?.error?.message ?? raw?.detail ?? `HTTP ${response.status}`
  return Object.assign(new Error(message), {
    status: response.status,
    code: raw?.error?.code,
  })
}

/** Разбор одного SSE-кадра (`data: {...}`); служебные/битые кадры игнорируются. */
function parseFrame(frame: string): UpdateApplyEvent | null {
  const payload = frame
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!payload) return null
  try {
    const parsed = JSON.parse(payload) as { type?: unknown }
    if (parsed && typeof parsed.type === 'string') return parsed as UpdateApplyEvent
  } catch {
    // Обрывок кадра (недочитанный JSON) — событие не доставляется.
  }
  return null
}

/** Вынимает из буфера завершённые кадры (разделитель — пустая строка). */
function drainFrames(buffer: string, onEvent: (event: UpdateApplyEvent) => void): string {
  let rest = buffer
  for (;;) {
    const match = /\r?\n\r?\n/.exec(rest)
    if (!match || match.index === undefined) return rest
    const frame = rest.slice(0, match.index)
    rest = rest.slice(match.index + match[0].length)
    const event = parseFrame(frame)
    if (event) onEvent(event)
  }
}

export const updatesApi = {
  /** GET /settings/updates — канал, автопроверка и реестры. */
  async getUpdatesSettings(): Promise<UpdatesSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/updates`)
    return normalizeSettings(raw)
  },

  /** PUT /settings/updates — переключает автопроверку (`{check}`). */
  async putUpdatesSettings(patch: { check: boolean }): Promise<UpdatesSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/updates`, {
      method: 'PUT',
      body: JSON.stringify({ check: patch.check }),
    })
    return normalizeSettings(raw)
  },

  /** DELETE /settings/updates — сброс к env/config/default. */
  async resetUpdatesSettings(): Promise<UpdatesSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/updates`, {
      method: 'DELETE',
    })
    return normalizeSettings(raw)
  },

  /**
   * GET /updates/check — проверка обновлений.
   * `force: true` игнорирует серверный кэш (кнопка «Проверить» в UI).
   */
  async checkUpdates(opts: { channel?: UpdateChannel; force?: boolean } = {}): Promise<UpdateCheckResult> {
    const params = new URLSearchParams()
    if (opts.channel) params.set('channel', opts.channel)
    if (opts.force) params.set('force', '1')
    const qs = params.toString()
    const raw = await fetchJSON<Partial<UpdateCheckResult>>(
      `${BASE_URL}/updates/check${qs ? `?${qs}` : ''}`,
    )
    const channel: ResolvedUpdateChannel = raw.channel === 'beta' ? 'beta' : 'stable'
    return {
      currentVersion: asString(raw.currentVersion, ''),
      latestVersion: asString(raw.latestVersion, ''),
      channel,
      prerelease: raw.prerelease === true,
      registry: asString(raw.registry, ''),
      hasUpdate: raw.hasUpdate === true,
      checkedAt: asString(raw.checkedAt, ''),
      error: typeof raw.error === 'string' ? raw.error : undefined,
    }
  },

  /**
   * POST /updates/apply — SSE-поток установки. Кадры `data: {...}` читаются
   * построчно; отмена — через внешний `AbortSignal` (поток и установка на
   * сервере обрываются по разрыву соединения).
   */
  async applyUpdate(
    input: ApplyUpdateInput,
    onEvent: (event: UpdateApplyEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${BASE_URL}/updates/apply`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        ...(input.version ? { version: input.version } : {}),
        ...(input.channel ? { channel: input.channel } : {}),
        restart: input.restart === true,
      }),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) throw await toStreamError(response)
    if (!response.body) {
      throw Object.assign(new Error('Streaming unavailable'), { status: response.status })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const cancelReader = () => {
      void reader.cancel().catch(() => undefined)
    }
    signal?.addEventListener('abort', cancelReader, { once: true })
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        buffer = drainFrames(buffer, onEvent)
      }
      buffer += decoder.decode()
      const tail = buffer.trim()
      if (tail) {
        const event = parseFrame(tail)
        if (event) onEvent(event)
      }
    } finally {
      signal?.removeEventListener('abort', cancelReader)
    }
  },
}
