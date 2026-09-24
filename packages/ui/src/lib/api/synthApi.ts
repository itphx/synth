import type { MessageData } from '@/stores/chatStore'
import type { TodoItem, ProjectPlan, PromptManifest, PromptHistoryInfo, PromptState, PromptMeta, PromptToolDetail, McpServerEffective, SessionStats, McpRegistryEntry, McpNetworkPolicy, ProjectMcpSettings, ToolsDisabledConfig, McpServerConfig, SkillSummary, SkillDetail, SkillDiagnostic, SkillLevel, SkillScope, CommandSummary, CommandDiagnostic, SkillBundle, SkillsDisabledRequest } from '@itphx/synth-shared'
import type { ToolsPolicy, WorkspaceOutsideRootPolicy, FileEntry } from '@itphx/synth-shared/types'

// Реэкспорт общих контрактов (AD-071): без локальных дублей.
export type { McpServerConfig, ToolsPolicy }
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
    // `code` (AD-075) нужен вызывающему, чтобы отличать 409-подтверждение от прочих 409/403.
    const code = error.error?.code
    throw Object.assign(new Error(msg), { status: response.status, code })
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

/** Кодирует относительный путь supporting-файла, сохраняя разделители `/`. */
function encodeFilePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export type EntityOrigin = 'local' | 'remote'

/** AD-075: тело создания проекта; `confirmOutsideRoot` — согласие на путь вне `workspacesRoot`. */
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

/** AD-075: тело обновления проекта; `confirmOutsideRoot` — согласие на путь вне `workspacesRoot`. */
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
  /** AD-071 §2.4: проектный скоуп MCP (owner/lead). */
  mcp?: ProjectMcpSettings | null
  created_at: string
  updated_at: string
}

export interface SessionData {
  id: string
  /** Происхождение сущности (гибридный режим): local — локальный мир, remote — удалённый backend. */
  origin?: EntityOrigin
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
  cache_hit_rate?: number
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

import type { DirectoryListResult, FileReadResult, RepoStatus, CommitInfo, CommitDetail, SessionMode } from '@itphx/synth-shared'

/**
 * AD-076: запись реестра git-репозиториев проекта. Полная форма
 * (`GitRepoConfig` из shared); `path` — относительный путь внутри workspace.
 */
export interface GitRepoConfigData {
  id?: string
  name?: string
  url?: string
  type?: 'https' | 'ssh'
  /** Относительный путь внутри `project.workspace`; `''`/`.` — корень workspace. */
  path: string
  defaultBranch?: string
  sshKeyId?: string
  lastFetch?: string
}

/** AD-076: публичная форма SSH-ключа (секреты `privateKey`/`passphrase` API не отдаёт). */
export interface SSHKeyMetaData {
  id: string
  name: string
  /** Метка типа ключа, дефолт `'user'`. */
  type?: string
  agentIds: string[]
  createdAt: string
  updatedAt?: string
}

/** AD-076: тело создания SSH-ключа (`POST /ssh-keys`). */
export interface SSHKeyCreateBody {
  name: string
  type?: string
  privateKey: string
  passphrase?: string
  agentIds?: string[]
}

/** AD-076: тело обновления SSH-ключа (partial; без `privateKey` секрет не меняется). */
export type SSHKeyUpdateBody = Partial<SSHKeyCreateBody>

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

/** AD-070 §2.5: ответ GET /sessions/:id/prompt — состав системного промпта. */
export interface PromptInfoResponse {
  manifest: PromptManifest
  history: PromptHistoryInfo
  promptState: PromptState | null
  lastPromptMeta: PromptMeta | null
  /** AD-071 §2.6: per-tool данные встроенных инструментов (аддитивно). */
  toolsDetail?: PromptToolDetail[]
}

/** AD-071 §2.4/§2.6: ответ GET /sessions/:id/mcp — эффективный MCP-скоуп сессии. */
export interface SessionMcpEffectiveResponse {
  servers: McpServerEffective[]
  enabled: string[]
  disabled: string[]
  mcpServers: string[]
  mcpDisabledServers: string[]
}

export interface ProviderInfo {
  name: string
  type: string
  icon: string
  url: string
  model: string
  enabled: boolean
  is_default?: boolean
  /** Валюта по умолчанию для моделей провайдера. */
  currency?: string
}

/** Результат `POST /providers/fetch-icon` (admin). */
export interface ProviderFetchIconResult {
  icon?: string | null
  error?: string
  source?: string
}

/** Элемент файла контекста (admin: `GET /context/files`). */
export interface ContextFileEntry {
  name: string
  category: string
  is_system: boolean
  is_overridden: boolean
  enabled: boolean
  size: number
  content?: string
}

/** Конфиг debug-логов (admin: `GET/POST /admin/debug/config`). */
export interface DebugConfigData {
  groups: Record<string, string>
  available_levels: string[]
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
  /** Валюта цен модели; отсутствует → валюта провайдера → USD. */
  currency?: string
}

export interface ProviderGroupInfo {
  name: string
  type: string
  icon: string
  defaultModel: string
  currency?: string
}

export interface ModelGroup {
  provider: ProviderGroupInfo
  models: ModelInfo[]
}

// --- Workspace root: выбор/создание каталога (AD-075) ---

/** AD-075: ответ `GET /fs/workspace-root` — корень workspace (`workspacesRoot`) и его подкаталоги. */
export interface WorkspaceRootResponse {
  root: string
  entries: FileEntry[]
}

/** AD-075: ответ `GET /fs/workspace-root/browse` — навигация по каталогам. */
export interface WorkspaceBrowseResponse {
  root: string
  /** Канонический путь сервера: относительный внутри root, абсолютный — вне. */
  path: string
  entries: FileEntry[]
}

/** AD-075: результат `POST /fs/workspace-root/mkdir`. */
export interface WorkspaceMkdirResult {
  created: boolean
  path: string
}

/** AD-075: политика абсолютных путей вне `workspacesRoot` (runtime override + defaults). */
export interface WorkspacePolicyInfo {
  outsideRoot: WorkspaceOutsideRootPolicy
  isOverridden: boolean
  defaults: WorkspaceOutsideRootPolicy
  /** Managed-развёртывание: политика задаётся деплоем, менять/обходить нельзя. */
  readOnly?: boolean
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

  /** AD-071 §2.4: проектный MCP-скоуп (owner/lead/admin). */
  async getProjectMcp(projectId: string): Promise<ProjectMcpResponse> {
    return fetchJSON<ProjectMcpResponse>(`${BASE_URL}/projects/${encodeURIComponent(projectId)}/mcp`)
  },

  /** AD-071 §2.4: задать проектный MCP-скоуп (owner/lead/admin). */
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

  /** AD-070 §2.5: манифест промпта + состояние активного агента + последний promptMeta. */
  async getSessionPrompt(sessionId: string): Promise<PromptInfoResponse> {
    return fetchJSON<PromptInfoResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/prompt`)
  },

  /**
   * AD-069 §9.3: снимок проектных инструкций сессии (read-only прозрачность).
   * Сессия без проекта → пустой снимок с диагностикой `no-project`.
   */
  async getSessionInstructions(sessionId: string): Promise<InstructionsInfo> {
    return fetchJSON<InstructionsInfo>(
      `${BASE_URL}/context/instructions?session_id=${encodeURIComponent(sessionId)}`,
    )
  },

  /** AD-071 §2.4/§2.6: эффективный MCP-скоуп сессии (включая отключённые с причиной). */
  async getSessionMcpEffective(sessionId: string): Promise<SessionMcpEffectiveResponse> {
    return fetchJSON<SessionMcpEffectiveResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/mcp`)
  },

  /**
   * AD-071 §2.4: переключение MCP-сервера в сессии. Точечный toggle `{ name, enabled }`
   * (в т.ч. opt-out системного) либо полная замена `{ mcpServers, mcpDisabledServers }`.
   */
  async updateSessionMcp(
    sessionId: string,
    body: { name?: string; enabled?: boolean; mcpServers?: string[]; mcpDisabledServers?: string[] },
  ): Promise<SessionMcpEffectiveResponse> {
    return fetchJSON<SessionMcpEffectiveResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/mcp`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  },

  /** AD-070 §2.6: статистика сессии по агентам и авторам сообщений. */
  async getSessionStats(sessionId: string): Promise<SessionStats> {
    return fetchJSON<SessionStats>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/stats`)
  },

  async createSession(data: {
    name?: string
    project_id?: string | null
    engine?: string
    settings?: Record<string, unknown>
    origin?: EntityOrigin
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

  // --- Корень workspace: выбор/создание каталога (AD-075) ---
  /** GET /fs/workspace-root — корень `workspacesRoot` и его подкаталоги. */
  async getWorkspaceRoot(includeHidden = false): Promise<WorkspaceRootResponse> {
    const qs = includeHidden ? '?includeHidden=true' : ''
    return fetchJSON<WorkspaceRootResponse>(`${BASE_URL}/fs/workspace-root${qs}`)
  },

  /** GET /fs/workspace-root/browse — навигация по каталогам (вне root — по политике). */
  async browseWorkspaceRoot(path = '', includeHidden = false): Promise<WorkspaceBrowseResponse> {
    const params = new URLSearchParams()
    if (path) params.set('path', path)
    if (includeHidden) params.set('includeHidden', 'true')
    const qs = params.toString()
    return fetchJSON<WorkspaceBrowseResponse>(`${BASE_URL}/fs/workspace-root/browse${qs ? `?${qs}` : ''}`)
  },

  /**
   * POST /fs/workspace-root/mkdir — создание каталога.
   * `confirmOutsideRoot` — явное подтверждение создания вне `workspacesRoot`
   * (без него сервер отвечает 409 `WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`).
   */
  async mkdirWorkspaceRoot(path: string, confirmOutsideRoot = false): Promise<WorkspaceMkdirResult> {
    return fetchJSON<WorkspaceMkdirResult>(`${BASE_URL}/fs/workspace-root/mkdir`, {
      method: 'POST',
      body: JSON.stringify(confirmOutsideRoot ? { path, confirmOutsideRoot: true } : { path }),
    })
  },

  /** GET /settings/workspace-policy — политика путей вне `workspacesRoot`. */
  async getWorkspacePolicy(): Promise<WorkspacePolicyInfo> {
    return fetchJSON<WorkspacePolicyInfo>(`${BASE_URL}/settings/workspace-policy`)
  },

  /** PUT /settings/workspace-policy — сохранить политику (live-применение). */
  async setWorkspacePolicy(
    policy: { outsideRoot: WorkspaceOutsideRootPolicy },
  ): Promise<{ outsideRoot: WorkspaceOutsideRootPolicy }> {
    return fetchJSON<{ outsideRoot: WorkspaceOutsideRootPolicy }>(`${BASE_URL}/settings/workspace-policy`, {
      method: 'PUT',
      body: JSON.stringify(policy),
    })
  },

  /** DELETE /settings/workspace-policy — сброс к config/env-дефолту. */
  async clearWorkspacePolicy(): Promise<WorkspacePolicyInfo & { status: string }> {
    return fetchJSON<WorkspacePolicyInfo & { status: string }>(`${BASE_URL}/settings/workspace-policy`, {
      method: 'DELETE',
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

  async initGitRepo(
    projectId: string,
    path: string,
    defaultBranch?: string,
    name?: string,
    sshKeyId?: string,
  ): Promise<RepoStatus> {
    return fetchJSON(`${BASE_URL}/git/repos/init`, {
      method: 'POST',
      body: JSON.stringify({ projectId, path, defaultBranch, name, sshKeyId }),
    })
  },

  async cloneGitRepo(
    projectId: string,
    url: string,
    path?: string,
    branch?: string,
    name?: string,
    sshKeyId?: string,
  ): Promise<RepoStatus> {
    return fetchJSON(`${BASE_URL}/git/repos/clone`, {
      method: 'POST',
      body: JSON.stringify({ projectId, url, path, branch, name, sshKeyId }),
    })
  },

  /** AD-076: upsert записи реестра (идемпотентно по `path`). */
  async registerGitRepo(
    projectId: string,
    entry: { path: string; name?: string; url?: string; type?: 'https' | 'ssh'; defaultBranch?: string; sshKeyId?: string },
  ): Promise<GitRepoConfigData> {
    return fetchJSON(`${BASE_URL}/git/repos/register`, {
      method: 'POST',
      body: JSON.stringify({ projectId, ...entry }),
    })
  },

  /** AD-076: удаление записи реестра; `deleteLocal` — удалить и локальные файлы. */
  async removeGitRepo(
    projectId: string,
    opts: { id?: string; path?: string; deleteLocal?: boolean },
  ): Promise<{ removed: GitRepoConfigData; deletedLocal: boolean }> {
    return fetchJSON(`${BASE_URL}/git/repos/remove`, {
      method: 'POST',
      body: JSON.stringify({ projectId, ...opts }),
    })
  },

  /** AD-076: fetch репозитория реестра (обновление `lastFetch`). */
  async fetchGitRepo(
    projectId: string,
    opts: { id?: string; path?: string },
  ): Promise<{ path: string; lastFetch: string }> {
    return fetchJSON(`${BASE_URL}/git/repos/fetch`, {
      method: 'POST',
      body: JSON.stringify({ projectId, ...opts }),
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

  // SSH-ключи (AD-076). Секреты API не возвращает — только SSHKeyMeta.
  async listSshKeys(agentId?: string): Promise<SSHKeyMetaData[]> {
    const params = agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''
    return fetchJSON(`${BASE_URL}/ssh-keys${params}`)
  },

  /** AD-076: создание ключа (write — ADMIN). */
  async createSshKey(body: SSHKeyCreateBody): Promise<SSHKeyMetaData> {
    return fetchJSON(`${BASE_URL}/ssh-keys`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  /** AD-076: частичное обновление; без `privateKey` в теле секрет не меняется. */
  async updateSshKey(id: string, body: SSHKeyUpdateBody): Promise<SSHKeyMetaData> {
    return fetchJSON(`${BASE_URL}/ssh-keys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
  },

  /** AD-076: удаление ключа целиком. */
  async deleteSshKey(id: string): Promise<void> {
    return fetchJSON(`${BASE_URL}/ssh-keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  /** AD-076 (nested): ключи агента. */
  async listAgentSshKeys(agentId: string): Promise<SSHKeyMetaData[]> {
    return fetchJSON(`${BASE_URL}/agents/${encodeURIComponent(agentId)}/ssh-keys`)
  },

  /** AD-076 (nested): создание ключа с привязкой к агенту. */
  async createAgentSshKey(agentId: string, body: SSHKeyCreateBody): Promise<SSHKeyMetaData> {
    return fetchJSON(`${BASE_URL}/agents/${encodeURIComponent(agentId)}/ssh-keys`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  /** AD-076 (nested): отвязка ключа от агента (ключ НЕ удаляется). */
  async unlinkAgentSshKey(agentId: string, keyId: string): Promise<SSHKeyMetaData> {
    return fetchJSON(
      `${BASE_URL}/agents/${encodeURIComponent(agentId)}/ssh-keys/${encodeURIComponent(keyId)}`,
      { method: 'DELETE' },
    )
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

  // Гибридный режим: статус подключения к удалённому backend (без auth, как /health)
  async getHybridStatus(): Promise<HybridStatus> {
    return fetchJSON<HybridStatus>(`${BASE_URL}/hybrid/status`)
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

  // Модели (admin)
  async fetchModels(providerName?: string): Promise<{
    fetched: number
    new: number
    enriched: number
    priced?: number
    limited?: number
    errors?: string[]
  }> {
    const params = providerName ? `?provider=${encodeURIComponent(providerName)}` : ''
    return fetchJSON(`${BASE_URL}/models/fetch${params}`, { method: 'POST' })
  },

  async saveModel(data: Record<string, unknown>): Promise<ModelInfo> {
    return fetchJSON<ModelInfo>(`${BASE_URL}/models`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async deleteModel(modelId: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/models/${encodeURIComponent(modelId)}`, {
      method: 'DELETE',
    })
  },

  // Провайдеры (admin)
  async createProvider(data: Record<string, unknown>): Promise<ProviderInfo> {
    return fetchJSON<ProviderInfo>(`${BASE_URL}/providers`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async updateProvider(name: string, data: Record<string, unknown>): Promise<ProviderInfo> {
    return fetchJSON<ProviderInfo>(`${BASE_URL}/providers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async deleteProvider(name: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/providers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
  },

  async testProvider(name: string): Promise<{
    status: string
    error?: string
    models?: string[]
    message?: string
  }> {
    return fetchJSON(`${BASE_URL}/providers/${encodeURIComponent(name)}/test`, {
      method: 'POST',
    })
  },

  async fetchProviderIcon(url: string): Promise<ProviderFetchIconResult> {
    return fetchJSON<ProviderFetchIconResult>(`${BASE_URL}/providers/fetch-icon`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    })
  },

  // Агенты (admin)
  async getAgentDetail(id: string): Promise<Record<string, unknown>> {
    return fetchJSON<Record<string, unknown>>(`${BASE_URL}/agents/${encodeURIComponent(id)}`)
  },

  async saveAgent(data: Record<string, unknown>): Promise<AgentInfo> {
    return fetchJSON<AgentInfo>(`${BASE_URL}/agents`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async toggleAgent(id: string, enabled: boolean): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/agents/${encodeURIComponent(id)}/enabled`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
  },

  async deleteAgent(id: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  // Контекст (admin)
  async getContextFiles(category: string): Promise<{ files: ContextFileEntry[] }> {
    return fetchJSON(`${BASE_URL}/context/files?category=${encodeURIComponent(category)}`)
  },

  async getContextFile(name: string, category: string): Promise<{ name: string; content: string }> {
    return fetchJSON(
      `${BASE_URL}/context/files/${encodeURIComponent(name)}?category=${encodeURIComponent(category)}`,
    )
  },

  async saveContextFile(name: string, content: string, category: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/context/files/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ content, category }),
    })
  },

  async toggleContextFile(name: string): Promise<{ name: string; enabled: boolean }> {
    return fetchJSON(`${BASE_URL}/context/files/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'toggle' }),
    })
  },

  async deleteContextFile(name: string, category: string): Promise<void> {
    return fetchJSON<void>(
      `${BASE_URL}/context/files/${encodeURIComponent(name)}?category=${encodeURIComponent(category)}`,
      { method: 'DELETE' },
    )
  },

  async resetContextFile(name: string, category: string): Promise<void> {
    return fetchJSON<void>(
      `${BASE_URL}/context/files/${encodeURIComponent(name)}/restore_to_default?category=${encodeURIComponent(category)}`,
      { method: 'POST' },
    )
  },

  // Debug (admin)
  async getDebugConfig<T = DebugConfigData>(): Promise<T> {
    return fetchJSON<T>(`${BASE_URL}/admin/debug/config`)
  },

  async saveDebugConfig(groups: Record<string, string>): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/admin/debug/config`, {
      method: 'POST',
      body: JSON.stringify({ groups }),
    })
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

  /** DELETE /settings/mcp — сброс runtime-настроек доступности MCP к дефолту (пусто). */
  async resetMcpSettings(): Promise<McpSettingsPayload> {
    return fetchJSON<McpSettingsPayload>(`${BASE_URL}/settings/mcp`, {
      method: 'DELETE',
    }).then((r) => ({ servers: r.servers }))
  },

  async probeMcpServer(name: string): Promise<{ name: string; tools: McpProbedTool[] }> {
    return fetchJSON(`${BASE_URL}/mcp/probe`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  },

  // --- MCP: единый реестр (AD-071 §2.5) ---
  async getMcpRegistry(): Promise<{ entries: McpRegistryEntry[] }> {
    return fetchJSON(`${BASE_URL}/mcp/registry`)
  },

  async addMcpRegistryEntry(input: McpRegistryAddInput): Promise<McpRegistryEntry> {
    return fetchJSON(`${BASE_URL}/mcp/registry`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  async updateMcpRegistryEntry(id: string, patch: McpRegistryUpdateInput): Promise<McpRegistryEntry> {
    return fetchJSON(`${BASE_URL}/mcp/registry/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
  },

  async deleteMcpRegistryEntry(id: string): Promise<{ success: boolean }> {
    return fetchJSON(`${BASE_URL}/mcp/registry/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  // --- MCP: политика сетевого доступа (AD-071 §2.3.1) ---
  async getMcpNetworkPolicyInfo(): Promise<{
    policy: McpNetworkPolicy
    isOverridden: boolean
    defaults: McpNetworkPolicy
  }> {
    return fetchJSON<{ policy: McpNetworkPolicy; isOverridden: boolean; defaults: McpNetworkPolicy }>(
      `${BASE_URL}/settings/mcp-network-policy`,
    ).then((r) => ({ policy: r.policy, isOverridden: r.isOverridden, defaults: r.defaults }))
  },

  async saveMcpNetworkPolicy(policy: McpNetworkPolicy): Promise<McpNetworkPolicy> {
    return fetchJSON<{ policy: McpNetworkPolicy }>(`${BASE_URL}/settings/mcp-network-policy`, {
      method: 'PUT',
      body: JSON.stringify({ policy }),
    }).then((r) => r.policy)
  },

  /** DELETE /settings/mcp-network-policy — сброс к дефолту (config или deny приватных диапазонов). */
  async resetMcpNetworkPolicy(): Promise<McpNetworkPolicy> {
    return fetchJSON<{ policy: McpNetworkPolicy }>(`${BASE_URL}/settings/mcp-network-policy`, {
      method: 'DELETE',
    }).then((r) => r.policy)
  },

  // --- LLM Gateway (AD-036) ---
  async getLlmGatewaySettingsInfo(): Promise<{
    settings: LlmGatewaySettings
    isOverridden: boolean
    defaults: LlmGatewaySettings
  }> {
    return fetchJSON<{ llmGateway: LlmGatewaySettings; isOverridden: boolean; defaults: LlmGatewaySettings }>(
      `${BASE_URL}/settings/llm-gateway`,
    ).then((r) => ({ settings: r.llmGateway, isOverridden: r.isOverridden, defaults: r.defaults }))
  },

  async saveLlmGatewaySettings(config: LlmGatewaySettings): Promise<LlmGatewaySettings> {
    return fetchJSON<{ llmGateway: LlmGatewaySettings }>(`${BASE_URL}/settings/llm-gateway`, {
      method: 'PUT',
      body: JSON.stringify({ llmGateway: config }),
    }).then((r) => r.llmGateway)
  },

  /** DELETE /settings/llm-gateway — сброс runtime-настроек к config.yaml-дефолту (live). */
  async resetLlmGatewaySettings(): Promise<LlmGatewaySettings> {
    return fetchJSON<{ llmGateway: LlmGatewaySettings }>(`${BASE_URL}/settings/llm-gateway`, {
      method: 'DELETE',
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

  // --- Инструменты: политика включения (AD-071 §2.3) ---
  async getToolsPolicyInfo(): Promise<{ policy: ToolsPolicy; isOverridden: boolean; defaults: ToolsPolicy }> {
    return fetchJSON<{ toolsPolicy: ToolsPolicy; isOverridden: boolean; defaults: ToolsPolicy }>(
      `${BASE_URL}/settings/tools-policy`,
    ).then((r) => ({ policy: r.toolsPolicy, isOverridden: r.isOverridden, defaults: r.defaults }))
  },

  async saveToolsPolicy(toolsPolicy: ToolsPolicy): Promise<ToolsPolicy> {
    return fetchJSON<{ toolsPolicy: ToolsPolicy }>(`${BASE_URL}/settings/tools-policy`, {
      method: 'PUT',
      body: JSON.stringify({ toolsPolicy }),
    }).then((r) => r.toolsPolicy)
  },

  /** DELETE /settings/tools-policy — сброс к config-дефолту (live-применение). */
  async resetToolsPolicy(): Promise<ToolsPolicy> {
    return fetchJSON<{ toolsPolicy: ToolsPolicy }>(`${BASE_URL}/settings/tools-policy`, {
      method: 'DELETE',
    }).then((r) => r.toolsPolicy)
  },

  // --- MCP: политика включения MCP-инструментов (AD-071 §2.3) ---
  async getMcpPolicyInfo(): Promise<{ policy: ToolsPolicy; isOverridden: boolean; defaults: ToolsPolicy }> {
    return fetchJSON<{ mcpPolicy: ToolsPolicy; isOverridden: boolean; defaults: ToolsPolicy }>(
      `${BASE_URL}/settings/mcp-policy`,
    ).then((r) => ({ policy: r.mcpPolicy, isOverridden: r.isOverridden, defaults: r.defaults }))
  },

  async saveMcpPolicy(mcpPolicy: ToolsPolicy): Promise<ToolsPolicy> {
    return fetchJSON<{ mcpPolicy: ToolsPolicy }>(`${BASE_URL}/settings/mcp-policy`, {
      method: 'PUT',
      body: JSON.stringify({ mcpPolicy }),
    }).then((r) => r.mcpPolicy)
  },

  /** DELETE /settings/mcp-policy — сброс к config-дефолту (live-применение). */
  async resetMcpPolicy(): Promise<ToolsPolicy> {
    return fetchJSON<{ mcpPolicy: ToolsPolicy }>(`${BASE_URL}/settings/mcp-policy`, {
      method: 'DELETE',
    }).then((r) => r.mcpPolicy)
  },

  // --- Скиллы (AD-046 §9.1) ---
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

  /** POST /skills/reload — принудительный ре-скан реестра (AD-046 §8.3). */
  async reloadSkills(): Promise<void> {
    await fetchJSON<{ status: string }>(`${BASE_URL}/skills/reload`, { method: 'POST' })
  },

  // --- Slash-команды (AD-046 §7/§9.1) ---
  /** GET /commands — встроенные + шаблонные + скиллы + bundles; `diagnostics` — shadowed/collision. */
  async getCommands(params?: { projectId?: string; diagnostics?: boolean }): Promise<CommandsListResponse> {
    const q = new URLSearchParams()
    if (params?.projectId) q.set('project_id', params.projectId)
    if (params?.diagnostics) q.set('diagnostics', '1')
    const qs = q.toString()
    return fetchJSON<CommandsListResponse>(`${BASE_URL}/commands${qs ? `?${qs}` : ''}`)
  },

  // --- Bundles (AD-046 §7.3) ---
  /** GET /skill-bundles — список YAML-групп скиллов. */
  async getSkillBundles(): Promise<SkillBundlesResponse> {
    return fetchJSON<SkillBundlesResponse>(`${BASE_URL}/skill-bundles`)
  },

  /** GET /skill-bundles/:name — один bundle. */
  async getSkillBundle(name: string): Promise<SkillBundle> {
    return fetchJSON<SkillBundle>(`${BASE_URL}/skill-bundles/${encodeURIComponent(name)}`)
  },

  /** POST /skill-bundles — создание bundle. */
  async createSkillBundle(input: SkillBundle): Promise<SkillBundle> {
    return fetchJSON<SkillBundle>(`${BASE_URL}/skill-bundles`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /** PATCH /skill-bundles/:name — правка bundle. */
  async updateSkillBundle(name: string, input: Omit<SkillBundle, 'name'>): Promise<SkillBundle> {
    return fetchJSON<SkillBundle>(`${BASE_URL}/skill-bundles/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...input, name }),
    })
  },

  /** DELETE /skill-bundles/:name — удаление bundle. */
  async deleteSkillBundle(name: string): Promise<void> {
    await fetchJSON<{ status: string }>(`${BASE_URL}/skill-bundles/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
  },

  // --- Scope-API скиллов (AD-046 §4.5, аналог MCP) ---
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

  // --- Скиллы: instance-wide настройки (AD-046 §4.5) ---
  /** GET /settings/skills — отключения (группы/категории/имена) и политика. */
  async getSkillsSettings(): Promise<SkillsSettingsResponse> {
    return fetchJSON<SkillsSettingsResponse>(`${BASE_URL}/settings/skills`)
  },

  /** PUT /settings/skills — сохранить отключения и (опционально) политику. */
  async updateSkillsSettings(
    disabled: SkillsDisabledRequest,
    policy?: ToolsPolicy,
  ): Promise<SkillsSettingsResponse> {
    return fetchJSON<SkillsSettingsResponse>(`${BASE_URL}/settings/skills`, {
      method: 'PUT',
      body: JSON.stringify(policy ? { disabled, policy } : { disabled }),
    })
  },

  /** DELETE /settings/skills — сброс к дефолту. */
  async resetSkillsSettings(): Promise<void> {
    await fetchJSON<{ status: string }>(`${BASE_URL}/settings/skills`, { method: 'DELETE' })
  },

  // --- Инструменты: instance-wide отключение (AD-071 §2.6) ---
  /** GET /settings/tools-disabled — жёстко отключённые admin'ом capability и тулы. */
  async getToolsDisabledInfo(): Promise<{
    config: ToolsDisabledConfig
    isOverridden: boolean
    defaults: ToolsDisabledConfig
  }> {
    return fetchJSON<{ toolsDisabled: ToolsDisabledConfig; isOverridden: boolean; defaults: ToolsDisabledConfig }>(
      `${BASE_URL}/settings/tools-disabled`,
    ).then((r) => ({ config: r.toolsDisabled, isOverridden: r.isOverridden, defaults: r.defaults }))
  },

  /** PUT /settings/tools-disabled — сохранить и live-применить отключение инструментов. */
  async saveToolsDisabled(config: ToolsDisabledConfig): Promise<ToolsDisabledConfig> {
    return fetchJSON<{ toolsDisabled: ToolsDisabledConfig }>(`${BASE_URL}/settings/tools-disabled`, {
      method: 'PUT',
      body: JSON.stringify({ toolsDisabled: config }),
    }).then((r) => r.toolsDisabled)
  },

  /** DELETE /settings/tools-disabled — сброс к config-дефолту (пусто; live-применение). */
  async resetToolsDisabled(): Promise<ToolsDisabledConfig> {
    return fetchJSON<{ toolsDisabled: ToolsDisabledConfig }>(`${BASE_URL}/settings/tools-disabled`, {
      method: 'DELETE',
    }).then((r) => r.toolsDisabled)
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

  // --- Агент по умолчанию (админка «Агенты») ---
  /** GET /settings/default-agent — эффективный агент по умолчанию и источник значения. */
  async getDefaultAgentInfo(): Promise<{ defaultAgent: string; isOverridden: boolean; defaults: string }> {
    return fetchJSON<{ defaultAgent: string; isOverridden: boolean; defaults: string }>(
      `${BASE_URL}/settings/default-agent`,
    )
  },

  /** PUT /settings/default-agent — сохранить агента по умолчанию (live-применение). */
  async setDefaultAgent(defaultAgent: string): Promise<{ defaultAgent: string }> {
    return fetchJSON<{ defaultAgent: string }>(`${BASE_URL}/settings/default-agent`, {
      method: 'PUT',
      body: JSON.stringify({ defaultAgent }),
    })
  },

  /** DELETE /settings/default-agent — сброс к дефолту (`DEFAULT_AGENT_ID`). */
  async resetDefaultAgent(): Promise<{ status: string; defaultAgent: string; isOverridden: boolean; defaults: string }> {
    return fetchJSON<{ status: string; defaultAgent: string; isOverridden: boolean; defaults: string }>(
      `${BASE_URL}/settings/default-agent`,
      { method: 'DELETE' },
    )
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

  // --- Словари классификации (AD-034/AD-035) ---
  async getDictionaries(): Promise<{ dictionaries: DictionaryEntry[] }> {
    return fetchJSON<{ dictionaries: DictionaryEntry[] }>(`${BASE_URL}/dictionaries`)
  },

  async getDictionary(category: string, lang: string): Promise<{ dictionary: DictionaryDetail }> {
    return fetchJSON<{ dictionary: DictionaryDetail }>(
      `${BASE_URL}/dictionaries/${encodeURIComponent(category)}/${encodeURIComponent(lang)}`,
    )
  },

  async saveDictionary(
    category: string,
    lang: string,
    data: { content: string },
  ): Promise<{ status: string; dictionary: DictionaryDetail }> {
    return fetchJSON<{ status: string; dictionary: DictionaryDetail }>(
      `${BASE_URL}/dictionaries/${encodeURIComponent(category)}/${encodeURIComponent(lang)}`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      },
    )
  },

  async resetDictionary(category: string, lang: string): Promise<{ status: string; dictionary: DictionaryDetail }> {
    return fetchJSON<{ status: string; dictionary: DictionaryDetail }>(
      `${BASE_URL}/dictionaries/${encodeURIComponent(category)}/${encodeURIComponent(lang)}`,
      { method: 'DELETE' },
    )
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

// AD-071 §2.3: `ToolsPolicy` — общий контракт `@itphx/synth-shared/types`
// (импортирован и реэкспортирован выше).

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

/** AD-071 §2.5: тело добавления записи реестра MCP. */
export interface McpRegistryAddInput {
  name: string
  config: McpServerConfig
  enabledByDefault?: boolean
  origin?: 'instance' | 'user'
}

/** AD-071 §2.5: тело обновления записи реестра MCP. */
export interface McpRegistryUpdateInput {
  name?: string
  config?: McpServerConfig
  enabledByDefault?: boolean
}

/** AD-071 §2.4: ответ GET/PUT /projects/:id/mcp — проектный MCP-скоуп. */
export interface ProjectMcpResponse {
  enabled: string[]
  defaultOn: string[]
  knownServers: string[]
}

/** Ответ GET /api/v2/hybrid/status — статус гибридного режима (core ↔ удалённый backend). */
export interface HybridStatus {
  enabled: boolean
  connected: boolean
  backendUrl: string | null
  /** Адрес сервера известен (--connect/env/конфиг) — информационное поле. */
  serverConfigured: boolean
  /** Доступен вход на сервер (адрес/issuer известен или уже подключено) — серверная форма логина. */
  serverLoginAvailable: boolean
  user?: {
    id: string
    username: string
    roles: string[]
  } | null
  /** URL известных серверов из реестра профилей core (список для datalist формы входа). */
  knownServers?: string[]
  /** URL последнего использованного сервера (предзаполнение поля адреса). */
  lastServer?: string | null
}

/** Словарь классификации (AD-034/AD-035): GET/PUT/DELETE /api/v2/dictionaries. */
export interface DictionaryEntry {
  category: string
  language: string
  source: 'system' | 'user'
  keywords: string[]
  tools?: string[]
  /** Размер действующего содержимого (YAML) в байтах. */
  size: number
}

/** Словарь классификации с действующим содержимым (YAML) — ответ GET/PUT/DELETE элемента. */
export interface DictionaryDetail extends DictionaryEntry {
  content: string
}

// --- Скиллы и slash-команды (AD-046) ---

/** AD-046 §9.1: ответ GET /api/v2/skills. */
export interface SkillsListResponse {
  skills: SkillSummary[]
  workspace?: string
  diagnostics?: SkillDiagnostic[]
}

/** AD-046 §9.1: список supporting-файлов скилла. */
export interface SkillFilesResponse {
  name: string
  files: string[]
}

/** AD-046 §9.1: содержимое supporting-файла скилла. */
export interface SkillFileResponse {
  name: string
  path: string
  content: string
}

/** AD-046 §7/§9.1: ответ GET /api/v2/commands. */
export interface CommandsListResponse {
  commands: CommandSummary[]
  workspace?: string
  diagnostics?: CommandDiagnostic[]
}

/** AD-046 §7.3: ответ GET /api/v2/skill-bundles. */
export interface SkillBundlesResponse {
  bundles: SkillBundle[]
}

/**
 * AD-046 §4.5: эффективная запись скилла в сессии/проекте (уровень, trust,
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
  disabledReason?: 'session' | 'system'
}

/** AD-046 §4.5: ответ GET/PUT /api/v2/sessions/:id/skills. */
export interface SessionSkillsResponse {
  session_id: string
  skills: EffectiveSkillEntry[]
  enabled: string[]
  disabled: string[]
}

/** AD-046 §4.5: ответ GET/PUT /api/v2/projects/:id/skills. */
export interface ProjectSkillsResponse {
  project_id: string
  skills: EffectiveSkillEntry[]
  enabled: string[]
  defaultOn: string[]
}

/** AD-046 §4.5: ответ GET/PUT /api/v2/settings/skills. */
export interface SkillsSettingsResponse {
  disabled: SkillsDisabledRequest
  policy: ToolsPolicy
}

// --- Проектные инструкции (AD-069 §9.3) ---

/** Статус файла в снимке (совпадает с core `InstructionsDiagnosticStatus`). */
export type InstructionFileStatus =
  | 'loaded'
  | 'truncated'
  | 'blocked'
  | 'dedup'
  | 'skipped'
  | 'untrusted'
  | 'skipped-install-tree'
  | 'excluded'
  | 'fetch-error'

/** Источник кандидата: merged chain, `config.sources` path или URL. */
export type InstructionSourceKind = 'chain' | 'path' | 'url'

/** Результат threat-scan (AD-036) по файлу инструкций. */
export interface InstructionScanInfo {
  scanned: boolean
  blocked: boolean
  suspicious: boolean
  matches: string[]
}

/** Файл проектных инструкций в снимке прозрачности (AD-069 §9.3). */
export interface InstructionFileInfo {
  /** Путь относительно workspace (`./AGENTS.md`, `../AGENTS.md`) или URL. */
  path: string
  kind: InstructionSourceKind
  label?: string
  url?: string
  chars: number
  truncated: boolean
  status: InstructionFileStatus
  scan?: InstructionScanInfo
}

/** Диагностика снимка проектных инструкций. */
export interface InstructionDiagnostic {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  path?: string
  kind?: InstructionSourceKind
}

/** AD-069 §9.3: ответ GET /api/v2/context/instructions (снимок + id сессии). */
export interface InstructionsInfo {
  session_id?: string
  enabled: boolean
  cap: { chars: number; source: 'dynamic' | 'override'; contextWindow: number }
  files: InstructionFileInfo[]
  diagnostics: InstructionDiagnostic[]
}
