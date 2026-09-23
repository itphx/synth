import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const apiMock = vi.hoisted(() => ({
  getSessions: vi.fn(async () => []),
  getProjects: vi.fn(async () => []),
  getUsers: vi.fn(async () => ({ users: [] })),
  getModels: vi.fn(async () => []),
  getAllAgents: vi.fn(async () => ({ agents: [] })),
  getProviders: vi.fn(async () => ({ providers: [], default_provider: '' })),
  fetchModels: vi.fn(async () => ({ fetched: 0, new: 0, enriched: 0 })),
  saveModel: vi.fn(async () => ({})),
  deleteModel: vi.fn(async () => undefined),
  fetchProviderIcon: vi.fn(async () => ({})),
  createProvider: vi.fn(async () => ({})),
  updateProvider: vi.fn(async () => ({})),
  deleteProvider: vi.fn(async () => undefined),
  testProvider: vi.fn(async () => ({ status: 'ok' })),
  getAgentDetail: vi.fn(async () => ({})),
  saveAgent: vi.fn(async () => ({})),
  toggleAgent: vi.fn(async () => undefined),
  deleteAgent: vi.fn(async () => undefined),
  getContextFiles: vi.fn(async () => ({ files: [] })),
  getContextFile: vi.fn(async () => ({ name: '', content: '' })),
  saveContextFile: vi.fn(async () => undefined),
  toggleContextFile: vi.fn(async () => ({ name: '', enabled: true })),
  deleteContextFile: vi.fn(async () => undefined),
  resetContextFile: vi.fn(async () => undefined),
  getDebugConfig: vi.fn(async () => ({ groups: {}, available_levels: [] })),
  saveDebugConfig: vi.fn(async () => undefined),
  getWorkspaceSetting: vi.fn(async () => ({ workspace: '' })),
  setWorkspaceSetting: vi.fn(async () => ({ workspace: '' })),
  createProject: vi.fn(async () => ({})),
  deleteProject: vi.fn(async () => ({})),
  getUser: vi.fn(async () => ({})),
  updateUser: vi.fn(async () => ({})),
  createUser: vi.fn(async () => ({})),
  deleteUser: vi.fn(async () => ({})),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

vi.mock('@/lib/api/profileService', () => ({
  profileService: {
    getDefaults: vi.fn(async () => ({
      locale: 'ru',
      themeMode: 'system',
      theme: 'flexoki',
      uiScaleMobile: null,
      uiScaleDesktop: null,
    })),
  },
}))

vi.mock('@/lib/api/client', () => ({
  api: {
    updateDefaults: vi.fn(async () => ({ status: 'ok', defaults: {} })),
  },
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { DashboardPanel } from './DashboardPanel'
import { SessionsPanel } from './SessionsPanel'
import { DebugPanel } from './DebugPanel'
import { DefaultsPanel } from './DefaultsPanel'
import { ProjectsPanel } from './ProjectsPanel'
import { ProvidersPanel } from './ProvidersPanel'
import { ModelsPanel } from './ModelsPanel'
import { AgentsPanel } from './AgentsPanel'
import { ContextPanel } from './ContextPanel'
import { UsersPanel } from './UsersPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PANELS: Array<[string, React.ComponentType]> = [
  ['DashboardPanel', DashboardPanel],
  ['SessionsPanel', SessionsPanel],
  ['DebugPanel', DebugPanel],
  ['DefaultsPanel', DefaultsPanel],
  ['ProjectsPanel', ProjectsPanel],
  ['ProvidersPanel', ProvidersPanel],
  ['ModelsPanel', ModelsPanel],
  ['AgentsPanel', AgentsPanel],
  ['ContextPanel', ContextPanel],
  ['UsersPanel', UsersPanel],
]

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderPanel(Panel: React.ComponentType): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <Panel />
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
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('AD-072: админ-панели рендерятся на SettingsPanel', () => {
  for (const [name, Panel] of PANELS) {
    it(`${name} монтируется и содержит scroll-тело без pr-2`, async () => {
      const container = await renderPanel(Panel)
      expect(container.querySelector('.overflow-y-auto')).not.toBeNull()
      expect(container.innerHTML).not.toContain('pr-2')
      container.querySelectorAll('.grid').forEach((el) => {
        expect(el.classList.contains('grid-cols-1')).toBe(true)
      })
    })
  }
})
