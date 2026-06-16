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
    const msg = error.detail || error.error?.error || error.error?.message || `HTTP ${response.status}`
    throw new Error(msg)
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
  repos: GitRepoConfigData[] | null
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
  sticky_notes: StickyNoteData[]
  summarization_pending: boolean
  can_summarize: boolean
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  processor_running: boolean | null
  created_at: string
  updated_at: string
}

export interface StickyNoteData {
  id: string
  content: string
  created_at: string
  updated_at: string
  disabled: boolean
}

export type { FileEntry, DirectoryListResult, FileReadResult } from '@synth/shared'

import type { DirectoryListResult, FileReadResult, FileEntry, RepoStatus, CommitInfo, CommitDetail } from '@synth/shared'

export interface GitRepoConfigData {
  path: string
  defaultBranch?: string
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
  agent_mode: 'primary' | 'subagent' | 'all' | null
  subagent_prompt: string | null
  max_steps: number | null
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
    repos?: GitRepoConfigData[] | null
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

  async retryMessage(sessionId: string, messageIndex: number): Promise<{ content: string; success: boolean }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${messageIndex}/retry`, {
      method: 'POST',
    })
  },

  async clearSession(sessionId: string): Promise<SessionData> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/clear`, {
      method: 'POST',
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

  // API v2: отправить отладочное системное сообщение
  async sendDebugSystemMessage(sessionId: string): Promise<{ status: string; stream_id: string }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/debug-system-message`, {
      method: 'POST',
    })
  },

  // Очередь (API v2 — /queue/:sessionId)
  async clearQueue(sessionId: string): Promise<void> {
    return fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/clear`, {
      method: 'POST',
    })
  },

  async returnQueue(sessionId: string, index?: number): Promise<{ texts: string[] }> {
    const base = `${BASE_URL}/queue/${encodeURIComponent(sessionId)}/return`
    const url = index !== undefined ? `${base}?index=${index}` : base
    return fetchJSON(url, {
      method: 'POST',
    })
  },

  async resumeQueue(sessionId: string): Promise<void> {
    return fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/resume`, {
      method: 'POST',
    })
  },

  // Файловая система (API v2 — /fs?project_id=&path=)
  async listDirectory(projectId: string, path?: string, includeHidden?: boolean): Promise<DirectoryListResult> {
    const params = new URLSearchParams({ project_id: projectId })
    if (path) params.set('path', path)
    if (includeHidden) params.set('includeHidden', 'true')
    return fetchJSON<DirectoryListResult>(`${BASE_URL}/fs?${params.toString()}`)
  },

  async readFile(projectId: string, path: string): Promise<FileReadResult> {
    const params = new URLSearchParams({ project_id: projectId, path })
    return fetchJSON<FileReadResult>(`${BASE_URL}/fs/read?${params.toString()}`)
  },

  async writeFile(projectId: string, path: string, content: string): Promise<FileReadResult> {
    return fetchJSON<FileReadResult>(`${BASE_URL}/fs/write`, {
      method: 'POST',
      body: JSON.stringify({ projectId, path, content }),
    })
  },

  async uploadFile(projectId: string, dirPath: string, file: File): Promise<{ path: string; name: string }> {
    const formData = new FormData()
    formData.append('project_id', projectId)
    formData.append('path', dirPath)
    formData.append('file', file)
    const response = await fetch(`${BASE_URL}/fs/upload`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Upload failed' }))
      throw new Error(error.detail || error.error?.error || `HTTP ${response.status}`)
    }
    return response.json()
  },

  downloadFile(projectId: string, path: string): string {
    const params = new URLSearchParams({ project_id: projectId, path })
    return `${BASE_URL}/fs/download?${params.toString()}`
  },

  async createDirectory(projectId: string, path: string): Promise<{ created: boolean; path: string }> {
    return fetchJSON(`${BASE_URL}/fs/mkdir`, {
      method: 'POST',
      body: JSON.stringify({ projectId, path }),
    })
  },

  async deleteEntry(projectId: string, path: string): Promise<{ deleted: boolean; path: string }> {
    const params = new URLSearchParams({ project_id: projectId, path })
    return fetchJSON(`${BASE_URL}/fs?${params.toString()}`, {
      method: 'DELETE',
    })
  },

  async getWorkspaceRoot(includeHidden = false): Promise<{ root: string; entries: FileEntry[] }> {
    const params = new URLSearchParams({ includeHidden: String(includeHidden) })
    return fetchJSON(`${BASE_URL}/fs/workspace-root?${params.toString()}`)
  },

  async browseWorkspaceRoot(
    path: string,
    includeHidden = false,
  ): Promise<{ root: string; path: string; entries: FileEntry[] }> {
    const params = new URLSearchParams({ path, includeHidden: String(includeHidden) })
    return fetchJSON(`${BASE_URL}/fs/workspace-root/browse?${params.toString()}`)
  },

  async createWorkspaceDirectory(rePath: string): Promise<{ created: boolean; path: string }> {
    return fetchJSON(`${BASE_URL}/fs/workspace-root/mkdir`, {
      method: 'POST',
      body: JSON.stringify({ path: rePath }),
    })
  },

  async moveEntry(
    projectId: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<{ moved: boolean; sourcePath: string; targetPath: string }> {
    return fetchJSON(`${BASE_URL}/fs/move`, {
      method: 'POST',
      body: JSON.stringify({ projectId, sourcePath, targetPath }),
    })
  },

  // Git
  async scanGitRepos(projectId: string): Promise<{ repos: RepoStatus[] }> {
    return fetchJSON(`${BASE_URL}/git/scan`, {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    })
  },

  async initGitRepo(projectId: string, path: string, defaultBranch?: string): Promise<RepoStatus> {
    return fetchJSON(`${BASE_URL}/git/repos/init`, {
      method: 'POST',
      body: JSON.stringify({ projectId, path, defaultBranch }),
    })
  },

  async cloneGitRepo(projectId: string, url: string, path?: string, branch?: string): Promise<RepoStatus> {
    return fetchJSON(`${BASE_URL}/git/repos/clone`, {
      method: 'POST',
      body: JSON.stringify({ projectId, url, path, branch }),
    })
  },

  async getCommitLog(projectId: string, repoPath?: string, maxCount?: number): Promise<{ commits: CommitInfo[] }> {
    const params = new URLSearchParams({ project_id: projectId, repo_path: repoPath || '' })
    if (maxCount) params.set('max_count', String(maxCount))
    return fetchJSON(`${BASE_URL}/git/log?${params.toString()}`)
  },

  async getCommitDetail(projectId: string, repoPath: string, hash: string): Promise<{ commit: CommitDetail }> {
    const params = new URLSearchParams({ project_id: projectId, repo_path: repoPath, hash })
    return fetchJSON(`${BASE_URL}/git/commit?${params.toString()}`)
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

  // Оптимизация контекста
  async getOptimization(sessionId: string): Promise<{
    context_optimization: string
    sliding_window_mode: string
    sliding_window_message_limit: number
    sliding_window_token_threshold: number
    summarization_enabled: boolean
    summarization_trigger_mode: string
    summarize_after_n: number
    summarize_token_threshold: number
    summarization_head_messages: number
    summarization_tail_messages: number
  }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/optimization`)
  },

  async updateOptimization(
    sessionId: string,
    data: {
      context_optimization?: string
      sliding_window_mode?: string
      sliding_window_message_limit?: number
      sliding_window_token_threshold?: number
      summarization_enabled?: boolean
      summarization_trigger_mode?: string
      summarize_after_n?: number
      summarize_token_threshold?: number
      summarization_head_messages?: number
      summarization_tail_messages?: number
    },
  ): Promise<SessionData> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/optimization`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  async summarizeSession(sessionId: string): Promise<{
    status: string
    stream_id: string
  }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/summarize`, {
      method: 'POST',
    })
  },

  async checkOptimization(sessionId: string): Promise<{
    sliding_window: { triggered: boolean; reason: string }
    summarization: { triggered: boolean; reason: string }
    summarization_pending: boolean
  }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/optimization/check`, {
      method: 'POST',
    })
  },

  async cancelSummarization(sessionId: string): Promise<{ success: boolean }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/optimization/cancel-summarization`, {
      method: 'POST',
    })
  },

  // Sticky notes
  async addStickyNote(sessionId: string, content: string): Promise<{
    note: StickyNoteData
    notes: StickyNoteData[]
  }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/notes`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
  },

  async getStickyNotes(sessionId: string): Promise<{ notes: StickyNoteData[] }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/notes`)
  },

  async updateStickyNote(sessionId: string, noteId: string, data: {
    content?: string
    disabled?: boolean
  }): Promise<{ notes: StickyNoteData[] }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(noteId)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  async deleteStickyNote(sessionId: string, noteId: string): Promise<{ notes: StickyNoteData[] }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(noteId)}`, {
      method: 'DELETE',
    })
  },

  // --- MCP ---
  async getMcpServers(): Promise<Record<string, McpServerEntry>> {
    return fetchJSON(`${BASE_URL}/mcp/servers`)
  },

  async addMcpServer(name: string, config: McpServerConfig): Promise<McpServerEntry> {
    return fetchJSON(`${BASE_URL}/mcp/servers`, {
      method: 'POST',
      body: JSON.stringify({ name, config }),
    })
  },

  async updateMcpServer(name: string, config: McpServerConfig): Promise<McpServerEntry> {
    return fetchJSON(`${BASE_URL}/mcp/servers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    })
  },

  async deleteMcpServer(name: string): Promise<{ success: boolean }> {
    return fetchJSON(`${BASE_URL}/mcp/servers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
  },

  async testMcpServer(name: string, config?: McpServerConfig): Promise<{ success: boolean; toolCount?: number; tools?: Array<{ name: string; description: string }>; error?: string }> {
    return fetchJSON(`${BASE_URL}/mcp/servers/${encodeURIComponent(name)}/test`, {
      method: 'POST',
      body: config ? JSON.stringify({ config }) : undefined,
    })
  },

  async getSessionMcp(sessionId: string): Promise<{ mcpServers: string[]; allServers: Array<{ name: string; active: boolean }> }> {
    return fetchJSON(`${BASE_URL}/mcp/session/${encodeURIComponent(sessionId)}`)
  },

  async setSessionMcp(sessionId: string, mcpServers: string[]): Promise<{ mcpServers: string[]; allServers: Array<{ name: string; active: boolean }> }> {
    return fetchJSON(`${BASE_URL}/mcp/session/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      body: JSON.stringify({ mcpServers }),
    })
  },
}

export interface McpServerConfig {
  type: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled?: boolean
  enabledByDefault?: boolean
  timeout?: number
  connectTimeout?: number
}

export interface McpServerEntry {
  name: string
  config: McpServerConfig
  connected: boolean
}
