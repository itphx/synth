import type { MessageData } from '@/stores/chatStore'
import type { TodoItem, ProjectPlan } from '@itphx/synth-shared'
import { normalizeModelInfo } from './modelNormalize'

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
  log?: { id: string; text: string; created_at: string; session_id?: string | null; author?: string | null }[] | null
  plan: ProjectPlan | null
  created_at: string
  updated_at: string
}

export interface SessionData {
  id: string
  name: string | null
  parent_id?: string | null
  branch_point?: string | null
  /** Флаг «план утверждён через plan_exit» (AD-039), сериализуется как plan_approved. */
  plan_approved?: boolean | null
  /** Todo-список сессии (тул todo_write), сериализуется как todos. */
  todos?: TodoItem[] | null
  session_origin?: string | null
  /** Текущий runtime-режим сессии (AD-025): 'plan' — только чтение, 'act' — полный доступ, 'yolo' — автоподтверждение. */
  mode?: SessionMode
  /** Применим ли переключатель режимов к агенту сессии (AD-025). false для read-only агентов. undefined → считается true. */
  mode_applicable?: boolean
  user_id: string | null
  owner_id: string | null
  project_id: string | null
  engine: string
  messages: Array<{
    index: number
    id?: string
    seq?: number
    origin?: string
    source_msg_id?: string | null
    parts?: Array<{ id: string; type: string; data: unknown }> | null
    role: string
    content: string
    author: string | null
    disabled: boolean
    pinned: boolean
    usage: Record<string, number> | null
    timestamp: string
    tool_calls?: unknown
    tool_call_id?: string | null
    reasoning?: string | null
    reasoning_blocks?: unknown | null
    intermediate_text_blocks?: unknown | null
    source?: string | null
    agent_role?: string | null
    summary_of?: number[] | null
    debug_data?: Record<string, unknown> | null
    metadata?: Record<string, unknown> | null
  }>
  pending_messages: unknown[]
  status: {
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

export type { FileEntry, DirectoryListResult, FileReadResult } from '@itphx/synth-shared'

import type { DirectoryListResult, FileReadResult, FileEntry, RepoStatus, CommitInfo, CommitDetail, SessionMode } from '@itphx/synth-shared'

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

export type AgentMode = 'primary' | 'subagent' | 'system'

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
  agent_mode: AgentMode[] | null
  reasoning_level?: string | null
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

  // Plan/Act режим сессии (AD-025)
  async patchSessionMode(sessionId: string, mode: SessionMode): Promise<SessionData> {
    return fetchJSON<SessionData>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ mode }),
    })
  },

  async deleteSession(sessionId: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    })
  },

  async forkSession(sessionId: string, options?: { message_id?: string; message_index?: number; title?: string }): Promise<SessionData> {
    return fetchJSON<SessionData>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/fork`, {
      method: 'POST',
      body: JSON.stringify(options || {}),
    })
  },

  async getSessionChildren(sessionId: string): Promise<SessionData[]> {
    return fetchJSON<SessionData[]>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/children`)
  },

  async getSessionReferences(sessionId: string): Promise<{ references: Array<{ sessionId: string; label: string; messageRange: [number, number]; autoSummary?: string; createdAt: string }> }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/references`)
  },

  async addSessionReference(sessionId: string, sourceSessionId: string, options?: { 
    label?: string; 
    messageRange?: [number, number]; 
    autoSummarize?: boolean;
    position?: 'after' | 'before';
  }): Promise<{ reference: Record<string, unknown> }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/references`, {
      method: 'POST',
      body: JSON.stringify({ source_session_id: sourceSessionId, ...options }),
    })
  },

  async removeSessionReference(sessionId: string, refSessionId: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/references/${encodeURIComponent(refSessionId)}`, {
      method: 'DELETE',
    })
  },

  async mergeMessages(sessionId: string, sourceSessionId: string, options: { sourceRange: [number, number]; position?: 'after' | 'before'; anchorMessageId?: string; summarize?: boolean }): Promise<{ messages: unknown[] }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/messages/merge`, {
      method: 'POST',
      body: JSON.stringify({ source_session_id: sourceSessionId, source_range: options.sourceRange, ...options }),
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

  async batchMessages(sessionId: string, action: 'pin' | 'toggle' | 'delete', indices: number[], state?: boolean): Promise<{ results: Array<{ index: number; success: boolean; state?: boolean }> }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/batch`, {
      method: 'POST',
      body: JSON.stringify({ action, indices, ...(state !== undefined ? { state } : {}) }),
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

  // API v2: возобновить прерванную/ошибочную дочернюю сессию саб-агента (202, выполнение фоновое)
  async resumeSubagent(childSessionId: string): Promise<{
    status: string
    child_session_id: string
    parent_session_id: string
    stream_id: string
  }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(childSessionId)}/resume-subagent`, {
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

  // API v2: немедленный повтор при backoff (без ожидания паузы)
  async retryQueueNow(sessionId: string): Promise<void> {
    await fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/retry-now`, {
      method: 'POST',
    })
  },

  // API v2: отменить повторные попытки (снять pending, разблокировать)
  async cancelQueueRetry(sessionId: string): Promise<void> {
    await fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/cancel-retry`, {
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

  // Рабочий каталог по умолчанию (settings)
  async getWorkspaceSetting(): Promise<{ workspace: string }> {
    return fetchJSON<{ workspace: string }>(`${BASE_URL}/settings/workspace`)
  },

  async setWorkspaceSetting(workspace: string): Promise<{ workspace: string }> {
    return fetchJSON<{ workspace: string }>(`${BASE_URL}/settings/workspace`, {
      method: 'PUT',
      body: JSON.stringify({ workspace }),
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

  // Все агенты (для админки, GET /agents/all)
  async getAllAgents(): Promise<AgentsListResponse> {
    return fetchJSON<AgentsListResponse>(`${BASE_URL}/agents/all`)
  },

  // Провайдеры и модели
  async getProviders(): Promise<{ providers: ProviderInfo[]; default_provider: string }> {
    const data = await fetchJSON<{ providers: ProviderInfo[]; default_provider: string }>(`${BASE_URL}/providers`)
    return { providers: data.providers || [], default_provider: data.default_provider }
  },

  async getModels(): Promise<ModelGroup[]> {
    const data = await fetchJSON<{
      groups: Array<{ provider: ProviderGroupInfo; models: Array<Record<string, unknown>> }>
    }>(`${BASE_URL}/models`)
    return (data.groups || []).map((g) => ({
      provider: g.provider,
      models: g.models.map((m) => normalizeModelInfo(m) as unknown as ModelInfo),
    }))
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

  async checkUpdate(): Promise<{ currentVersion: string; latestVersion: string; hasUpdate: boolean; checkedAt: string }> {
    return fetchJSON(`${BASE_URL}/updates/check`)
  },

  // --- MCP: доступность инструментов по режимам (W4c) ---
  async getMcpToolSettings(): Promise<McpSettingsPayload> {
    return fetchJSON(`${BASE_URL}/settings/mcp`)
  },

  async saveMcpToolSettings(servers: Record<string, McpServerToolsSettings>): Promise<McpSettingsPayload> {
    return fetchJSON(`${BASE_URL}/settings/mcp`, {
      method: 'PUT',
      body: JSON.stringify({ servers }),
    })
  },

  async probeMcpServer(name: string): Promise<{ name: string; tools: McpProbedTool[] }> {
    return fetchJSON(`${BASE_URL}/mcp/probe`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  },

  // --- LLM Gateway (AD-036) ---
  async getLlmGatewaySettings(): Promise<LlmGatewaySettings> {
    return fetchJSON<{ llmGateway: LlmGatewaySettings }>(`${BASE_URL}/settings/llm-gateway`).then((r) => r.llmGateway)
  },

  async saveLlmGatewaySettings(config: LlmGatewaySettings): Promise<LlmGatewaySettings> {
    return fetchJSON<{ llmGateway: LlmGatewaySettings }>(`${BASE_URL}/settings/llm-gateway`, {
      method: 'PUT',
      body: JSON.stringify({ llmGateway: config }),
    }).then((r) => r.llmGateway)
  },

  // --- LLM Gateway: паттерны обфускации (AD-036) ---
  async getGatewayPatterns(): Promise<{ patterns: SecretPattern[]; isOverridden: boolean; defaultPatterns: SecretPattern[] }> {
    return fetchJSON<{ patterns: SecretPattern[]; is_overridden: boolean; default_patterns: SecretPattern[] }>(`${BASE_URL}/gateway/patterns`).then((r) => ({
      patterns: r.patterns,
      isOverridden: r.is_overridden,
      defaultPatterns: r.default_patterns,
    }))
  },

  async saveGatewayPatterns(patterns: SecretPattern[]): Promise<{ patterns: SecretPattern[]; isOverridden: boolean; saved: boolean }> {
    return fetchJSON<{ patterns: SecretPattern[]; is_overridden: boolean; saved: boolean }>(`${BASE_URL}/gateway/patterns`, {
      method: 'PUT',
      body: JSON.stringify({ patterns }),
    }).then((r) => ({
      patterns: r.patterns,
      isOverridden: r.is_overridden,
      saved: r.saved,
    }))
  },

  async resetGatewayPatterns(): Promise<{ status: string }> {
    return fetchJSON<{ status: string }>(`${BASE_URL}/gateway/patterns`, {
      method: 'DELETE',
    })
  },

  // --- Безопасность: секция «Защищённые пути» ---
  async getSecuritySettings(): Promise<SecuritySettings> {
    return fetchJSON<{ security: SecuritySettings }>(`${BASE_URL}/settings/security`).then((r) => r.security)
  },

  async saveSecuritySettings(cfg: SecuritySettings): Promise<SecuritySettings> {
    return fetchJSON<{ security: SecuritySettings }>(`${BASE_URL}/settings/security`, {
      method: 'PUT',
      body: JSON.stringify({ security: cfg }),
    }).then((r) => r.security)
  },

  async getProtectedPaths(): Promise<ProtectedPathsRaw> {
    const r = await fetchJSON<{ policy: ProtectedPathsPolicy; base: ProtectedPathsPolicy; is_overridden: boolean }>(`${BASE_URL}/settings/protected-paths`)
    return { policy: r.policy, base: r.base, isOverridden: r.is_overridden }
  },

  async saveProtectedPaths(policy: ProtectedPathsPolicy): Promise<ProtectedPathsPolicy> {
    return fetchJSON<{ policy: ProtectedPathsPolicy }>(`${BASE_URL}/settings/protected-paths`, {
      method: 'PUT',
      body: JSON.stringify({ policy }),
    }).then((r) => r.policy)
  },

  async resetProtectedPaths(): Promise<{ status: string }> {
    return fetchJSON<{ status: string }>(`${BASE_URL}/settings/protected-paths`, {
      method: 'DELETE',
    })
  },

  /** Полная карта обфускации сессии (AD-036): плейсхолдер → реальное значение. Доступ ADMIN/AUDITOR. */
  async getSessionSecrets(sessionId: string): Promise<SessionSecretsResponse> {
    return fetchJSON<SessionSecretsResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/secrets`)
  },

  /** Логирование раскрытия секрета (AD-036, тип 'revealed'). Эндпоинт может отсутствовать — fire-and-forget. */
  async auditRevealed(sessionId: string | undefined, placeholder: string): Promise<void> {
    await fetchJSON<void>(`${BASE_URL}/audit/revealed`, {
      method: 'POST',
      body: JSON.stringify({ sessionId, placeholder }),
    })
  },

  // --- Логи сервисов (GET /api/v2/logs/:name) ---
  async getLogs(name: string, params?: { tail?: number; search?: string }): Promise<LogsResponse> {
    const q = new URLSearchParams()
    if (params?.tail !== undefined) q.set('tail', String(params.tail))
    if (params?.search) q.set('search', params.search)
    const qs = q.toString()
    return fetchJSON<LogsResponse>(`${BASE_URL}/logs/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`)
  },

  // --- Аудит LLM Gateway (GET /api/v2/audit) ---
  async getAudit(params?: {
    userId?: string
    sessionId?: string
    since?: string
    until?: string
    limit?: number
  }): Promise<AuditListResponse> {
    const q = new URLSearchParams()
    if (params?.userId) q.set('userId', params.userId)
    if (params?.sessionId) q.set('sessionId', params.sessionId)
    if (params?.since) q.set('since', params.since)
    if (params?.until) q.set('until', params.until)
    if (params?.limit !== undefined) q.set('limit', String(params.limit))
    const qs = q.toString()
    return fetchJSON<AuditListResponse>(`${BASE_URL}/audit${qs ? `?${qs}` : ''}`)
  },

  // --- Полный лог запросов/ответов LLM (GET /api/v2/logs/llm) ---
  async getLlmPayloads(params?: { sessionId?: string; limit?: number }): Promise<LlmPayloadListResponse> {
    const q = new URLSearchParams()
    if (params?.sessionId) q.set('sessionId', params.sessionId)
    if (params?.limit !== undefined) q.set('limit', String(params.limit))
    const qs = q.toString()
    return fetchJSON<LlmPayloadListResponse>(`${BASE_URL}/logs/llm${qs ? `?${qs}` : ''}`)
  },
}

export interface LlmGatewaySettings {
  enabled: boolean
  inputMode: 'obfuscate' | 'block'
  logPayloads?: boolean
  rateLimit: {
    userPerMinute: number
    providerPerMinute: number
  }
}

/** Паттерн детекции секретов (AD-036): type — название, regex — source без слешей и флагов (компилируется с 'g'). */
export interface SecretPattern {
  type: string
  regex: string
}

/** Runtime-настройки секции «Безопасность» (тумблер защищённых путей + таймаут подтверждения). */
export interface SecuritySettings {
  protectedPaths: {
    enabled: boolean
  }
  /** Глобальный дефолт таймаута подтверждения ask (мс). */
  askTimeoutMs?: number
}

/** Эффективная политика защищённых путей (списки строк). */
export interface ProtectedPathsPolicy {
  deniedPaths: string[]
  deniedPrefixes: string[]
  approvalPaths: string[]
  deniedCommandPrefixes: string[]
}

/** Ответ GET /api/v2/settings/protected-paths. */
export interface ProtectedPathsRaw {
  policy: ProtectedPathsPolicy
  base: ProtectedPathsPolicy
  isOverridden: boolean
}

export interface SessionSecretsResponse {
  sessionId: string
  secrets: Record<string, string>
}

/** Ответ GET /api/v2/logs/:name — хвост лог-файла сервиса. */
export interface LogsResponse {
  name: string
  file: string
  total: number
  tail: number
  lines: string[]
}

/** Запись журнала аудита LLM Gateway (AD-036). */
export interface AuditEntry {
  ts: string
  type: string
  sessionId?: string
  userId?: string
  provider?: string
  model?: string
  secretsFound?: string[]
  placeholders?: string[]
  placeholder?: string
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  reason?: string
}

/** Ответ GET /api/v2/audit. */
export interface AuditListResponse {
  entries: AuditEntry[]
  total: number
}

/** Запись полного лога запросов/ответов LLM (после обфускации). */
export interface LlmPayloadEntry {
  ts: string
  sessionId?: string
  userId?: string
  provider?: string
  model?: string
  request: {
    messages: Array<{
      id?: string
      role: string
      content: string
      [key: string]: unknown
    }>
    systemPrompt?: string
  }
  response: {
    content: string
    usage?: {
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
    }
  }
}

/** Ответ GET /api/v2/logs/llm. */
export interface LlmPayloadListResponse {
  entries: LlmPayloadEntry[]
  total: number
}

export interface McpProbedTool {
  name: string
  description: string
}

export interface McpModeAvailability {
  plan: boolean
  act: boolean
}

export interface McpServerToolsSettings {
  default: McpModeAvailability
  tools: Record<string, McpModeAvailability>
}

export interface McpSettingsPayload {
  servers: Record<string, McpServerToolsSettings>
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
