import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const apiMock = vi.hoisted(() => ({
  getProjects: vi.fn(async () => []),
  getWorkspaceSetting: vi.fn(async () => ({ workspace: '/data/workspaces/default' })),
  setWorkspaceSetting: vi.fn(async () => ({ workspace: '/data/workspaces/default' })),
  getWorkspacePolicy: vi.fn(async () => ({ outsideRoot: 'confirm', isOverridden: false, defaults: 'confirm' })),
  setWorkspacePolicy: vi.fn(async () => ({ outsideRoot: 'confirm' })),
  clearWorkspacePolicy: vi.fn(async () => ({ outsideRoot: 'confirm', isOverridden: false, defaults: 'confirm', status: 'restored' })),
  createProject: vi.fn(async () => ({})),
  deleteProject: vi.fn(async () => ({})),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuthStore } from '@/stores/authStore'
import { ProjectsPanel } from './ProjectsPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <ProjectsPanel />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  useAuthStore.setState({ user: null } as never)
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('ProjectsPanel: instance-настройка workspace — только ADMIN', () => {
  const workspaceInput = (container: HTMLElement): HTMLInputElement | null =>
    container.querySelector('input[aria-label="Default workspace"]')

  it('ADMIN: поле и сохранение доступны, предупреждения нет', async () => {
    useAuthStore.setState({ user: { id: 'a', username: 'admin', roles: ['ADMIN'] } as never })
    const container = await render()
    expect(workspaceInput(container)?.disabled).toBe(false)
    expect(container.querySelector('[data-testid="workspace-admin-only"]')).toBeNull()
  })

  it('LEAD: поле заблокировано, показано предупреждение (managed RBAC — ADMIN)', async () => {
    useAuthStore.setState({ user: { id: 'l', username: 'lead', roles: ['LEAD'] } as never })
    const container = await render()
    expect(workspaceInput(container)?.disabled).toBe(true)
    expect(container.querySelector('[data-testid="workspace-admin-only"]')).not.toBeNull()
  })

  it('USER: поле заблокировано, сохранение не вызывается', async () => {
    useAuthStore.setState({ user: { id: 'u', username: 'user', roles: ['USER'] } as never })
    const container = await render()
    expect(workspaceInput(container)?.disabled).toBe(true)
    expect(container.querySelector('[data-testid="workspace-admin-only"]')).not.toBeNull()

    const saveButton = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Save'),
    )
    await act(async () => {
      saveButton?.click()
    })
    expect(apiMock.setWorkspaceSetting).not.toHaveBeenCalled()
  })
})
