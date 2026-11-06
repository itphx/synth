// ssh: режим работы инстанса с SSH-ключами (`ssh.mode`) — PROP-124.
//
// `GET/PUT/DELETE /api/v2/settings/ssh`: чтение, runtime-override (применяется
// без рестарта) и сброс к env/config/default. При env-фиксации
// (`SYNTH_SSH_MODE`) сервер отвечает 409.

import { BASE_URL, fetchJSON } from './base'

/** Режим инстанса: `tools` (адресные тулы) | `agent` (эфемерный ssh-agent). */
export type SshMode = 'tools' | 'agent'

/** Источник эффективного значения (env > runtime > config > default). */
export type SshModeSource = 'env' | 'runtime' | 'config' | 'default'

export interface SshSettings {
  /** Эффективный режим инстанса. */
  mode: SshMode
  /** Сохранённое runtime-значение (`null` — не задано). */
  saved: SshMode | null
  /** База без runtime/env. */
  defaults: SshMode
  source: SshModeSource
  envLocked: boolean
  restartRequired: boolean
}

const MODES: readonly SshMode[] = ['tools', 'agent']
const SOURCES: readonly SshModeSource[] = ['env', 'runtime', 'config', 'default']

function isMode(value: unknown): value is SshMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

function isSource(value: unknown): value is SshModeSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

function normalize(raw: unknown): SshSettings {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    mode: isMode(body.mode) ? body.mode : 'tools',
    saved: isMode(body.saved) ? body.saved : null,
    defaults: isMode(body.defaults) ? body.defaults : 'tools',
    source: isSource(body.source) ? body.source : 'default',
    envLocked: body.envLocked === true,
    restartRequired: body.restartRequired === true,
  }
}

export const sshSettingsApi = {
  async getSshSettings(): Promise<SshSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/ssh`)
    return normalize(raw)
  },

  async setSshMode(mode: SshMode): Promise<SshSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/ssh`, {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    })
    return normalize(raw)
  },

  async resetSshMode(): Promise<SshSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/ssh`, {
      method: 'DELETE',
    })
    return normalize(raw)
  },
}
