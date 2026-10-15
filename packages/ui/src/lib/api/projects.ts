// projects: домен API v2 (ADR-095) — объект `projectsApi` и его DTO.

import type { ProjectMcpSettings, ProjectPlan } from '@itphx/synth-shared'
import type { EntityOrigin } from './common'
import type { GitRepoConfigData } from './git'
import { BASE_URL, fetchJSON } from './base'

/** ADR-075: тело создания проекта; `confirmOutsideRoot` — согласие на путь вне `workspacesRoot`. */
export interface CreateProjectBody {
  name: string
  description?: string
  icon?: string | null
  color?: string | null
  workspace?: string | null
  repos?: GitRepoConfigData[] | null
  origin?: EntityOrigin
  confirmOutsideRoot?: boolean
}

/** ADR-075: тело обновления проекта; `confirmOutsideRoot` — согласие на путь вне `workspacesRoot`. */
export interface UpdateProjectBody {
  name?: string
  description?: string
  current_task?: string
  invariants?: string
  icon?: string | null
  color?: string | null
  workspace?: string | null
  repos?: GitRepoConfigData[] | null
  confirmOutsideRoot?: boolean
}

export interface ProjectData {
  id: string
  /** Происхождение сущности (гибридный режим): local — локальный мир, remote — удалённый backend. */
  origin?: EntityOrigin
  name: string
  owner_id: string
  members: Record<string, string>
  description: string
  current_task: string
  invariants: string
  icon: string | null
  color: string | null
  workspace: string | null
  repos: GitRepoConfigData[] | null
  status_messages: Array<{
    id: string
    text: string
    type: string
    timestamp: string
  }>
  log?: { id: string; text: string; created_at: string; session_id?: string | null; author?: string | null }[] | null
  plan: ProjectPlan | null
  /** ADR-071 §2.4: проектный скоуп MCP (owner/lead). */
  mcp?: ProjectMcpSettings | null
  created_at: string
  updated_at: string
}

export interface ProjectStats {
  total_sessions: number
  total_input_tokens: number
  total_output_tokens: number
  total_tokens: number
  total_messages: number
  total_cache_read_tokens: number
  total_cache_write_tokens: number
  total_reasoning_tokens: number
}

/** Ответ POST /projects/:id/publish — перенос локального проекта на сервер. */
export interface PublishProjectResult {
  ok: boolean
  /** id удалённого проекта в remote-форме ('remote:<uuid>'). */
  project_id: string
  created: boolean
  sessions_imported: number
  files_uploaded: number
}

/** ADR-071 §2.4: ответ GET/PUT /projects/:id/mcp — проектный MCP-скоуп. */
export interface ProjectMcpResponse {
  enabled: string[]
  defaultOn: string[]
  knownServers: string[]
}

export const projectsApi = {
  // Проекты
  async getProjects(): Promise<ProjectData[]> {
    return fetchJSON<ProjectData[]>(`${BASE_URL}/projects`)
  },

  async getProject(id: string): Promise<ProjectData> {
    return fetchJSON<ProjectData>(`${BASE_URL}/projects/${encodeURIComponent(id)}`)
  },

  async createProject(data: CreateProjectBody): Promise<ProjectData> {
    return fetchJSON<ProjectData>(`${BASE_URL}/projects`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async updateProject(id: string, data: UpdateProjectBody): Promise<ProjectData> {
    return fetchJSON<ProjectData>(`${BASE_URL}/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async deleteProject(id: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  /** ADR-071 §2.4: проектный MCP-скоуп (owner/lead/admin). */
  async getProjectMcp(projectId: string): Promise<ProjectMcpResponse> {
    return fetchJSON<ProjectMcpResponse>(`${BASE_URL}/projects/${encodeURIComponent(projectId)}/mcp`)
  },

  /** ADR-071 §2.4: задать проектный MCP-скоуп (owner/lead/admin). */
  async updateProjectMcp(
    projectId: string,
    body: { enabled?: string[]; defaultOn?: string[] },
  ): Promise<ProjectMcpResponse> {
    return fetchJSON<ProjectMcpResponse>(`${BASE_URL}/projects/${encodeURIComponent(projectId)}/mcp`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  },

  // Перенос проектов между мирами (гибрид): publish — локальный проект на сервер,
  // fork-local — удалённый проект в локальный мир. Сессии и файлы переносятся всегда.
  async publishProject(id: string, opts?: { remote_project_id?: string }): Promise<PublishProjectResult> {
    return fetchJSON<PublishProjectResult>(`${BASE_URL}/projects/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      body: JSON.stringify(opts || {}),
    })
  },

  async forkRemoteProject(id: string, opts?: { local_name?: string }): Promise<ProjectData> {
    return fetchJSON<ProjectData>(`${BASE_URL}/projects/${encodeURIComponent(id)}/fork-local`, {
      method: 'POST',
      body: JSON.stringify(opts || {}),
    })
  },

  async getProjectStats(id: string): Promise<ProjectStats> {
    return fetchJSON<ProjectStats>(`${BASE_URL}/projects/${encodeURIComponent(id)}/stats`)
  },
}
