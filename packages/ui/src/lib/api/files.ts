// files: домен API v2 (ADR-095) — объект `filesApi` и его DTO.

import type { DirectoryListResult, FileReadResult } from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

export const filesApi = {
  // Файловая система (API v2 — /fs?project_id=&path=)
  async listDirectory(
    projectId: string,
    path?: string,
    includeHidden?: boolean,
    maxDepth?: number,
  ): Promise<DirectoryListResult> {
    const params = new URLSearchParams({ project_id: projectId })
    if (path) params.set('path', path)
    if (includeHidden) params.set('includeHidden', 'true')
    if (maxDepth) params.set('maxDepth', String(maxDepth))
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

  async moveEntry(
    projectId: string,
    sourcePath: string,
    targetPath: string,
    targetProjectId?: string,
  ): Promise<{ moved: boolean; sourcePath: string; targetPath: string }> {
    const body: Record<string, unknown> = { projectId, sourcePath, targetPath }
    if (targetProjectId) body.targetProjectId = targetProjectId
    return fetchJSON(`${BASE_URL}/fs/move`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
}
