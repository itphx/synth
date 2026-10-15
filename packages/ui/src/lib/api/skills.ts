// skills: домен API v2 (ADR-095) — объект `skillsApi` и его DTO.

import type {
  SkillDetail,
  SkillDiagnostic,
  SkillLevel,
  SkillScope,
  SkillSummary,
  SkillsDisabledRequest,
} from '@itphx/synth-shared'
import type { ToolsPolicy } from '@itphx/synth-shared/types'
import { BASE_URL, encodeFilePath, fetchJSON } from './base'

// --- Скиллы и slash-команды (ADR-046) ---

/** ADR-046 §9.1: ответ GET /api/v2/skills. */
export interface SkillsListResponse {
  skills: SkillSummary[]
  workspace?: string
  diagnostics?: SkillDiagnostic[]
}

/** ADR-046 §9.1: список supporting-файлов скилла. */
export interface SkillFilesResponse {
  name: string
  files: string[]
}

/** ADR-046 §9.1: содержимое supporting-файла скилла. */
export interface SkillFileResponse {
  name: string
  path: string
  content: string
}

/**
 * ADR-046 §4.5: эффективная запись скилла в сессии/проекте (уровень, trust,
 * доступность, включён/отключён с причиной).
 */
export interface EffectiveSkillEntry {
  name: string
  description: string
  level: SkillLevel
  scope: SkillScope
  trusted: boolean
  available: boolean
  unavailableReason?: string
  enabled: boolean
  disabled: boolean
  disabledReason?: 'session' | 'system' | 'project'
}

/** ADR-046 §4.5: ответ GET/PUT /api/v2/sessions/:id/skills. */
export interface SessionSkillsResponse {
  session_id: string
  skills: EffectiveSkillEntry[]
  enabled: string[]
  disabled: string[]
}

/** ADR-046 §4.5: ответ GET/PUT /api/v2/projects/:id/skills. */
export interface ProjectSkillsResponse {
  project_id: string
  skills: EffectiveSkillEntry[]
  enabled: string[]
  defaultOn: string[]
}

/** ADR-046 §4.5: ответ GET/PUT /api/v2/settings/skills. */
export interface SkillsSettingsResponse {
  /** Мастер-гейт: скиллы, недоступные нигде. */
  disabled: SkillsDisabledRequest
  /** Сид новых проектов: что не включать по умолчанию. */
  disabledForNewProjects: SkillsDisabledRequest
  policy: ToolsPolicy
}

export const skillsApi = {
  // --- Скиллы (ADR-046 §9.1) ---
  /** GET /skills — реестр скиллов; `diagnostics` добавляет discovery-диагностику. */
  async getSkills(params?: { projectId?: string; diagnostics?: boolean }): Promise<SkillsListResponse> {
    const q = new URLSearchParams()
    if (params?.projectId) q.set('project_id', params.projectId)
    if (params?.diagnostics) q.set('diagnostics', '1')
    const qs = q.toString()
    return fetchJSON<SkillsListResponse>(`${BASE_URL}/skills${qs ? `?${qs}` : ''}`)
  },

  /** GET /skills/:name — деталь скилла (тело + supporting-файлы; для недоверенных тело пустое). */
  async getSkill(name: string, opts?: { projectId?: string }): Promise<SkillDetail> {
    const q = opts?.projectId ? `?project_id=${encodeURIComponent(opts.projectId)}` : ''
    return fetchJSON<SkillDetail>(`${BASE_URL}/skills/${encodeURIComponent(name)}${q}`)
  },

  /** POST /skills — создание instance-скилла. */
  async createSkill(input: {
    name: string
    description: string
    body?: string
    files?: Record<string, string>
  }): Promise<SkillDetail> {
    return fetchJSON<SkillDetail>(`${BASE_URL}/skills`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /** PATCH /skills/:name — правка description/body/metadata instance-скилла. */
  async updateSkill(
    name: string,
    patch: { description?: string; body?: string; metadata?: Record<string, unknown> },
  ): Promise<SkillDetail> {
    return fetchJSON<SkillDetail>(`${BASE_URL}/skills/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  /** DELETE /skills/:name — удаление instance-скилла. */
  async deleteSkill(name: string): Promise<void> {
    await fetchJSON<{ status: string }>(`${BASE_URL}/skills/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
  },

  /** GET /skills/:name/files — список supporting-файлов. */
  async getSkillFiles(name: string): Promise<SkillFilesResponse> {
    return fetchJSON<SkillFilesResponse>(`${BASE_URL}/skills/${encodeURIComponent(name)}/files`)
  },

  /** GET /skills/:name/files/* — содержимое supporting-файла. */
  async getSkillFile(name: string, path: string): Promise<SkillFileResponse> {
    return fetchJSON<SkillFileResponse>(`${BASE_URL}/skills/${encodeURIComponent(name)}/files/${encodeFilePath(path)}`)
  },

  /** PUT /skills/:name/files/* — запись supporting-файла (instance). */
  async putSkillFile(name: string, path: string, content: string): Promise<{ name: string; path: string }> {
    return fetchJSON<{ name: string; path: string }>(
      `${BASE_URL}/skills/${encodeURIComponent(name)}/files/${encodeFilePath(path)}`,
      { method: 'PUT', body: JSON.stringify({ content }) },
    )
  },

  /** DELETE /skills/:name/files/* — удаление supporting-файла (instance). */
  async deleteSkillFile(name: string, path: string): Promise<void> {
    await fetchJSON<{ status: string }>(
      `${BASE_URL}/skills/${encodeURIComponent(name)}/files/${encodeFilePath(path)}`,
      { method: 'DELETE' },
    )
  },

  /** POST /skills/reload — принудительный ре-скан реестра (ADR-046 §8.3). */
  async reloadSkills(): Promise<void> {
    await fetchJSON<{ status: string }>(`${BASE_URL}/skills/reload`, { method: 'POST' })
  },

  // --- Scope-API скиллов (ADR-046 §4.5, аналог MCP) ---
  /** GET /sessions/:id/skills — эффективный per-session набор (включая отключённые с причиной). */
  async getSessionSkills(sessionId: string): Promise<SessionSkillsResponse> {
    return fetchJSON<SessionSkillsResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/skills`)
  },

  /** GET /sessions/:id/skills/effective — синоним `getSessionSkills` (как у MCP). */
  async getSessionSkillsEffective(sessionId: string): Promise<SessionSkillsResponse> {
    return fetchJSON<SessionSkillsResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/skills/effective`)
  },

  /** PUT /sessions/:id/skills — точечный toggle `{ name, enabled }` либо замена списков. */
  async updateSessionSkills(
    sessionId: string,
    body: { name?: string; enabled?: boolean; skills?: string[]; skillsDisabled?: string[] },
  ): Promise<SessionSkillsResponse> {
    return fetchJSON<SessionSkillsResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/skills`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  },

  /** GET /projects/:id/skills — проектный скоуп скиллов (owner/lead). */
  async getProjectSkills(projectId: string): Promise<ProjectSkillsResponse> {
    return fetchJSON<ProjectSkillsResponse>(`${BASE_URL}/projects/${encodeURIComponent(projectId)}/skills`)
  },

  /** PUT /projects/:id/skills — проектный скоуп (owner/lead). */
  async updateProjectSkills(
    projectId: string,
    body: { enabled?: string[]; defaultOn?: string[] },
  ): Promise<ProjectSkillsResponse> {
    return fetchJSON<ProjectSkillsResponse>(`${BASE_URL}/projects/${encodeURIComponent(projectId)}/skills`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  },

  // --- Скиллы: instance-wide настройки (ADR-046 §4.5) ---
  /** GET /settings/skills — мастер-гейт, сид новых проектов и политика. */
  async getSkillsSettings(): Promise<SkillsSettingsResponse> {
    return fetchJSON<SkillsSettingsResponse>(`${BASE_URL}/settings/skills`)
  },

  /** PUT /settings/skills — сохранить мастер-гейт, сид новых проектов и (опционально) политику. */
  async updateSkillsSettings(input: {
    disabled: SkillsDisabledRequest
    disabledForNewProjects?: SkillsDisabledRequest
    policy?: ToolsPolicy
  }): Promise<SkillsSettingsResponse> {
    return fetchJSON<SkillsSettingsResponse>(`${BASE_URL}/settings/skills`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  },

  /** DELETE /settings/skills — сброс к дефолту. */
  async resetSkillsSettings(): Promise<void> {
    await fetchJSON<{ status: string }>(`${BASE_URL}/settings/skills`, { method: 'DELETE' })
  },
}
