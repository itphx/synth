// workspace: домен API v2 (ADR-095) — объект `workspaceApi` и его DTO.

import type { FileEntry, WorkspaceOutsideRootPolicy } from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

// --- Workspace root: выбор/создание каталога (ADR-075) ---

/** ADR-075: ответ `GET /fs/workspace-root` — корень workspace (`workspacesRoot`) и его подкаталоги. */
export interface WorkspaceRootResponse {
  root: string
  entries: FileEntry[]
}

/** ADR-075: ответ `GET /fs/workspace-root/browse` — навигация по каталогам. */
export interface WorkspaceBrowseResponse {
  root: string
  /** Канонический путь сервера: относительный внутри root, абсолютный — вне. */
  path: string
  entries: FileEntry[]
}

/** ADR-075: результат `POST /fs/workspace-root/mkdir`. */
export interface WorkspaceMkdirResult {
  created: boolean
  path: string
}

/** ADR-075: политика абсолютных путей вне `workspacesRoot` (runtime override + defaults). */
export interface WorkspacePolicyInfo {
  outsideRoot: WorkspaceOutsideRootPolicy
  isOverridden: boolean
  defaults: WorkspaceOutsideRootPolicy
  /** Managed-развёртывание: политика задаётся деплоем, менять/обходить нельзя. */
  readOnly?: boolean
}

export const workspaceApi = {
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

  // --- Корень workspace: выбор/создание каталога (ADR-075) ---
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
}
