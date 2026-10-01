import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// i18n/runtime могут трогать localStorage (в Node/vitest его нет).
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

const mocks = vi.hoisted(() => ({
  getSessionInstructions: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ProjectInstructions } from './ProjectInstructions'
import { useInstructionsStore } from '@/stores/instructionsStore'
import type { InstructionsInfo } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function info(overrides: Partial<InstructionsInfo> = {}): InstructionsInfo {
  return {
    session_id: 's1',
    enabled: true,
    cap: { chars: 20000, source: 'dynamic', contextWindow: 128000 },
    files: [],
    diagnostics: [],
    ...overrides,
  }
}

async function render(sessionId = 's1'): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ProjectInstructions sessionId={sessionId} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

async function toggle(container: HTMLElement): Promise<void> {
  await act(async () => {
    ;(container.querySelector('[data-testid="instructions-toggle"]') as HTMLElement).click()
  })
}

beforeEach(() => {
  mocks.getSessionInstructions.mockReset()
  useInstructionsStore.setState({ infoBySession: {}, loadingBySession: {}, errorBySession: {} })
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
})

describe('ProjectInstructions (AD-069 §9.3)', () => {
  it('показывает сводку и по клику — список файлов со статусом/размером/scan, свёрнут по умолчанию', async () => {
    mocks.getSessionInstructions.mockResolvedValue(info({
      files: [
        {
          path: './AGENTS.md',
          kind: 'chain',
          chars: 1000,
          truncated: false,
          status: 'loaded',
          scan: { scanned: true, blocked: false, suspicious: false, matches: [] },
        },
        {
          path: '../shared/AGENTS.md',
          kind: 'chain',
          chars: 234,
          truncated: false,
          status: 'untrusted',
          scan: { scanned: true, blocked: false, suspicious: true, matches: ['ignore previous'] },
        },
      ],
    }))

    const container = await render()

    expect(container.querySelector('[data-testid="instructions-toggle"]')).not.toBeNull()
    expect(container.textContent).toContain('2 files · 1.2k chars')
    expect(container.querySelector('[data-testid="instructions-files"]')).toBeNull()

    await toggle(container)

    const files = container.querySelectorAll('[data-testid="instructions-file"]')
    expect(files).toHaveLength(2)
    expect(container.textContent).toContain('./AGENTS.md')
    expect(container.textContent).toContain('1k')
    expect(container.textContent).toContain(enDict['sessionTab.instructions.status.loaded'])
    expect(container.textContent).toContain(enDict['sessionTab.instructions.status.untrusted'])
    expect(container.querySelector('[data-testid="instructions-suspicious"]')?.textContent).toContain('(1)')
  })

  it('бейдж статуса — в одной строке с именем файла (одна строка, путь truncate)', async () => {
    mocks.getSessionInstructions.mockResolvedValue(info({
      files: [
        {
          path: './AGENTS.md',
          kind: 'chain',
          chars: 10,
          truncated: false,
          status: 'loaded',
          scan: { scanned: true, blocked: false, suspicious: false, matches: [] },
        },
      ],
    }))
    const container = await render()
    await toggle(container)

    const file = container.querySelector('[data-testid="instructions-file"]')!
    // Одна строка: единственный прямой потомок-контейнер.
    expect(file.children).toHaveLength(1)
    const row = file.children[0] as HTMLElement
    const path = row.querySelector('.font-mono') as HTMLElement
    const badge = row.querySelector('[data-testid="instructions-status"]') as HTMLElement
    expect(path, 'путь файла').toBeTruthy()
    expect(badge, 'бейдж статуса').toBeTruthy()
    // Путь обрезается и лежит в том же контейнере строки, что и бейдж.
    expect(path.className).toContain('truncate')
    expect(path.parentElement).toBe(badge.parentElement)
  })

  it('enabled:false — понятное пустое состояние без списка', async () => {
    mocks.getSessionInstructions.mockResolvedValue(info({ enabled: false }))
    const container = await render()

    expect(container.querySelector('[data-testid="instructions-disabled"]')).not.toBeNull()
    expect(container.textContent).toContain(enDict['sessionTab.instructions.disabled'])
    expect(container.querySelector('[data-testid="instructions-files"]')).toBeNull()
  })

  it('сессия без проекта (диагностика no-project) — пустое состояние с причиной', async () => {
    mocks.getSessionInstructions.mockResolvedValue(info({
      files: [],
      diagnostics: [{ level: 'info', code: 'no-project', message: 'Проект не выбран' }],
    }))
    const container = await render()

    expect(container.querySelector('[data-testid="instructions-empty"]')).not.toBeNull()
    expect(container.textContent).toContain(enDict['sessionTab.instructions.noProject'])
  })

  it('blocked-файл: статус blocked и признак обрезки в списке', async () => {
    mocks.getSessionInstructions.mockResolvedValue(info({
      files: [
        {
          path: './AGENTS.md',
          kind: 'chain',
          chars: 12,
          truncated: true,
          status: 'blocked',
          scan: { scanned: true, blocked: true, suspicious: true, matches: ['secret'] },
        },
      ],
    }))
    const container = await render()
    await toggle(container)

    expect(container.textContent).toContain(enDict['sessionTab.instructions.status.blocked'])
    expect(container.textContent).toContain(enDict['sessionTab.instructions.truncated'])
    // Сводка показывает счётчик заблокированных файлов (plural en → "1 file blocked").
    expect(container.textContent).toContain('1 file blocked')
  })
})
