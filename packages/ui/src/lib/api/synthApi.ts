import type { MessageData } from '@/stores/chatStore'

const BASE_URL = '/api/v2'

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(error.detail || `HTTP ${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export interface ProjectData {
  id: string
  name: string
  owner_id: string
  members: Record<string, string>
  description: string
  current_task: string
  invariants: string
  icon: string | null
  color: string | null
  workspace: string | null
  status_messages: Array<{
    id: string
    text: string
    type: string
    timestamp: string
  }>
  created_at: string
  updated_at: string
}

export interface SessionData {
  id: string
  name: string | null
  user_id: string | null
  owner_id: string | null
  project_id: string | null
  engine: string
  messages: Array<{
    index: number
    role: string
    content: string
    author: string | null
    disabled: boolean
    pinned: boolean
    usage: Record<string, number> | null
    timestamp: string
  }>
  pending_messages: unknown[]
  status: {
    state: string
    blocked: string | null
  }
  settings: Record<string, unknown>
  input_tokens: number
  output_tokens: number
  total_tokens: number
  processor_running: boolean | null
  created_at: string
  updated_at: string
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number
}

export interface DirectoryListResult {
  path: string
  entries: FileEntry[]
}

export interface FileReadResult {
  path: string
  content: string
  size: number
}

export interface ProjectStats {
  total_sessions: number
  total_input_tokens: number
  total_output_tokens: number
  total_tokens: number
  total_messages: number
}

export interface UserInfo {
  id: string
  username: string
  email: string | null
  roles: string[]
  team_roles: string[]
  display_name: string | null
  is_active: boolean
  notes: string
  preferences: Record<string, unknown>
  created_at: string
  updated_at: string
  last_login: string | null
}

export interface UsersListResponse {
  users: UserInfo[]
}

export interface AgentInfo {
  id: string
  display_name: string
  capabilities: string[]
  enabled: boolean
  icon: string | null
  color: string | null
  description: string | null
  available: boolean
  mode: 'simple' | 'orchestrator'
  provider: string | null
  model: string | null
  context_file: string | null
  is_builtin: boolean
  is_overridden: boolean
}

export interface AgentsListResponse {
  agents: AgentInfo[]
  default_agent: string | null
}

export interface MessageListResponse {
  messages: MessageData[]
  session_id: string
  engine: string
}

export interface ChatStatusResponse {
  blocked: boolean
  pending_count: number
}

export interface ProviderInfo {
  name: string
  type: string
  icon: string
  url: string
  model: string
  enabled: boolean
  is_default?: boolean
}

export interface ModelInfo {
  id: string
  name: string
  provider: string
  description?: string
  enabled: boolean
  isDefault: boolean
  context_window?: number
  context_source?: string
  max_tokens?: number
  input_price?: number
  output_price?: number
  cache_read_price?: number
  cache_write_price?: number
}

export interface ProviderGroupInfo {
  name: string
  type: string
  icon: string
  defaultModel: string
}

export interface ModelGroup {
  provider: ProviderGroupInfo
  models: ModelInfo[]
}

export const synthApi = {
  async fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
    return fetchJSON<T>(url, options)
  },

  // Проекты
  async getProjects(): Promise<ProjectData[]> {
    return fetchJSON<ProjectData[]>(`${BASE_URL}/projects`)
  },

  async getProject(id: string): Promise<ProjectData> {
    return fetchJSON<ProjectData>(`${BASE_URL}/projects/${encodeURIComponent(id)}`)
  },

  async createProject(data: {
    name: string
    description?: string
    icon?: string | null
    color?: string | null
    workspace?: string | null
  }): Promise<ProjectData> {
    return fetchJSON<ProjectData>(`${BASE_URL}/projects`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async updateProject(id: string, data: {
    name?: string
    description?: string
    current_task?: string
    invariants?: string
    icon?: string | null
    color?: string | null
    workspace?: string | null
  }): Promise<ProjectData> {
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

  async getProjectStats(id: string): Promise<ProjectStats> {
    return fetchJSON<ProjectStats>(`${BASE_URL}/projects/${encodeURIComponent(id)}/stats`)
  },

  // Сессии
  async getSessions(projectId?: string | null): Promise<SessionData[]> {
    const params = new URLSearchParams()
    if (projectId !== undefined && projectId !== null) {
      params.set('project_id', projectId)
    }
    const qs = params.toString()
    return fetchJSON<SessionData[]>(`${BASE_URL}/sessions${qs ? `?${qs}` : ''}`)
  },

  async getSession(sessionId: string): Promise<SessionData> {
    return fetchJSON<SessionData>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`)
  },

  async createSession(data: {
    name?: string
    project_id?: string | null
    engine?: string
    settings?: Record<string, unknown>
  }): Promise<SessionData> {
    return fetchJSON<SessionData>(`${BASE_URL}/sessions`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  // move/rename объединены в PATCH (API v2)
  async updateSession(sessionId: string, data: {
    name?: string
    project_id?: string | null
    engine?: string
    settings?: Record<string, unknown>
  }): Promise<SessionData> {
    return fetchJSON<SessionData>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  async deleteSession(sessionId: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    })
  },

  // Сообщения (API v2 — путь /messages/:sessionId/:index)
  async getSessionMessages(sessionId: string): Promise<MessageListResponse> {
    return fetchJSON<MessageListResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/messages`)
  },

  async toggleMessage(sessionId: string, messageIndex: number): Promise<{ disabled: boolean; success: boolean }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${messageIndex}/toggle`, {
      method: 'PATCH',
    })
  },

  async pinMessage(sessionId: string, messageIndex: number): Promise<{ pinned: boolean; success: boolean }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${messageIndex}/pin`, {
      method: 'PATCH',
    })
  },

  async deleteMessage(sessionId: string, messageIndex: number): Promise<{ success: boolean }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${messageIndex}`, {
      method: 'DELETE',
    })
  },

  async getMessageDebug(sessionId: string, messageIndex: number): Promise<Record<string, unknown>> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${messageIndex}/debug`)
  },

  // Чат (API v2 — POST /sessions/:id/prompt)
  async streamMessage(sessionId: string, message: string, options?: {
    agentRole?: string
    streamId?: string
    provider?: string
    model?: string
    author?: string
    metadata?: Record<string, unknown>
  }): Promise<ReadableStream<Uint8Array> | null> {
    const streamId = options?.streamId || `stream-${Date.now()}`
    const body: Record<string, unknown> = {
      content: message,
      stream: true,
      agent: options?.agentRole,
      provider: options?.provider,
      model: options?.model,
      messageId: streamId,
      metadata: options?.metadata,
    }

    const response = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Stream failed' }))
      throw new Error(error.detail || `HTTP ${response.status}`)
    }

    return response.body
  },

  // API v2: отправить сообщение без чтения SSE-стрима (для SSE-режима)
  async enqueueMessage(sessionId: string, message: string, options?: {
    agentRole?: string
    streamId?: string
    provider?: string
    model?: string
  }): Promise<void> {
    const body: Record<string, unknown> = {
      content: message,
      stream: true,
      agent: options?.agentRole,
      provider: options?.provider,
      model: options?.model,
      messageId: options?.streamId || `stream-${Date.now()}`,
    }

    const response = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Enqueue failed' }))
      throw new Error(error.detail || `HTTP ${response.status}`)
    }
  },

  // API v2: abort
  async stopGeneration(sessionId: string): Promise<void> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/abort`, {
      method: 'POST',
    })
  },

  // API v2: status
  async getChatStatus(sessionId: string): Promise<ChatStatusResponse> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/status`)
  },

  // Очередь (API v2 — /queue/:sessionId)
  async clearQueue(sessionId: string): Promise<void> {
    return fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/clear`, {
      method: 'POST',
    })
  },

  async returnQueue(sessionId: string): Promise<{ texts: string[] }> {
    return fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/return`, {
      method: 'POST',
    })
  },

  async resumeQueue(sessionId: string): Promise<void> {
    return fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/resume`, {
      method: 'POST',
    })
  },

  // Файловая система (API v2 — /fs?project_id=&path=)
  async listDirectory(projectId: string, path?: string): Promise<DirectoryListResult> {
    const params = new URLSearchParams({ project_id: projectId })
    if (path) params.set('path', path)
    return fetchJSON<DirectoryListResult>(`${BASE_URL}/fs?${params.toString()}`)
  },

  async readFile(projectId: string, path: string): Promise<FileReadResult> {
    const params = new URLSearchParams({ project_id: projectId, path })
    return fetchJSON<FileReadResult>(`${BASE_URL}/fs/read?${params.toString()}`)
  },

  // Агенты
  async getAgents(sessionId?: string): Promise<AgentsListResponse> {
    const params = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
    return fetchJSON<AgentsListResponse>(`${BASE_URL}/agents${params}`)
  },

  // Провайдеры и модели
  async getProviders(): Promise<{ providers: ProviderInfo[]; default_provider: string }> {
    const data = await fetchJSON<{ providers: ProviderInfo[]; default_provider: string }>(`${BASE_URL}/providers`)
    return { providers: data.providers || [], default_provider: data.default_provider }
  },

  async getModels(): Promise<ModelGroup[]> {
    const data = await fetchJSON<{ groups: ModelGroup[] }>(`${BASE_URL}/models`)
    return data.groups || []
  },

  // Пользователи (admin)
  async getUsers(): Promise<UsersListResponse> {
    return fetchJSON<UsersListResponse>(`${BASE_URL}/users`)
  },

  async getUser(id: string): Promise<UserInfo> {
    return fetchJSON<UserInfo>(`${BASE_URL}/users/${encodeURIComponent(id)}`)
  },

  async createUser(data: Record<string, unknown>): Promise<UserInfo> {
    return fetchJSON<UserInfo>(`${BASE_URL}/users`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async updateUser(id: string, data: Record<string, unknown>): Promise<UserInfo> {
    return fetchJSON<UserInfo>(`${BASE_URL}/users/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async deleteUser(id: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },
}
