import { describe, it, expect } from 'vitest'

import dashboardSource from './DashboardPanel.tsx?raw'
import sessionsSource from './SessionsPanel.tsx?raw'
import debugSource from './DebugPanel.tsx?raw'
import defaultsSource from './DefaultsPanel.tsx?raw'
import projectsSource from './ProjectsPanel.tsx?raw'
import providersSource from './ProvidersPanel.tsx?raw'
import modelsSource from './ModelsPanel.tsx?raw'
import agentsSource from './AgentsPanel.tsx?raw'
import contextSource from './ContextPanel.tsx?raw'
import usersSource from './UsersPanel.tsx?raw'

const PANELS: Record<string, string> = {
  DashboardPanel: dashboardSource,
  SessionsPanel: sessionsSource,
  DebugPanel: debugSource,
  DefaultsPanel: defaultsSource,
  ProjectsPanel: projectsSource,
  ProvidersPanel: providersSource,
  ModelsPanel: modelsSource,
  AgentsPanel: agentsSource,
  ContextPanel: contextSource,
  UsersPanel: usersSource,
}

/** Все строковые литералы, которые содержат токен `grid`, но не несут базовый `grid-cols-1`. */
function bareGridClasses(source: string): string[] {
  const bad: string[] = []
  const literal = /['"`]([^'"`]*)['"`]/g
  let match: RegExpExecArray | null
  while ((match = literal.exec(source)) !== null) {
    const tokens = match[1].split(/\s+/).filter(Boolean)
    if (tokens.includes('grid') && !tokens.includes('grid-cols-1')) {
      bad.push(match[1])
    }
  }
  return bad
}

describe('ADR-072: админ-панели используют Settings UI Kit', () => {
  for (const [name, source] of Object.entries(PANELS)) {
    it(`${name} собирается на SettingsPanel`, () => {
      expect(source).toContain('SettingsPanel')
    })

    it(`${name} без асимметричного pr-2`, () => {
      expect(source).not.toContain('pr-2')
    })

    it(`${name}: нет grid без базового grid-cols-1`, () => {
      expect(bareGridClasses(source)).toEqual([])
    })
  }
})
