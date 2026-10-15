// commands: домен API v2 (ADR-095) — объект `commandsApi` и его DTO.

import type { CommandDiagnostic, CommandSummary } from '@itphx/synth-shared'
import { BASE_URL, fetchJSON } from './base'

/** ADR-046 §7/§9.1: ответ GET /api/v2/commands. */
export interface CommandsListResponse {
  commands: CommandSummary[]
  workspace?: string
  diagnostics?: CommandDiagnostic[]
}

export const commandsApi = {
  // --- Slash-команды (ADR-046 §7/§9.1) ---
  /** GET /commands — встроенные + шаблонные + скиллы + bundles; `diagnostics` — shadowed/collision. */
  async getCommands(params?: { projectId?: string; diagnostics?: boolean }): Promise<CommandsListResponse> {
    const q = new URLSearchParams()
    if (params?.projectId) q.set('project_id', params.projectId)
    if (params?.diagnostics) q.set('diagnostics', '1')
    const qs = q.toString()
    return fetchJSON<CommandsListResponse>(`${BASE_URL}/commands${qs ? `?${qs}` : ''}`)
  },
}
