import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore/useAuthStore пишет в localStorage — в Node/vitest его нет.
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
  getPacks: vi.fn(),
  getPack: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { CATEGORIES } from './SettingsModal'
import { AuthoritySettings } from './AuthoritySettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Сводка контента полномочий пакета (ответ `GET /packs`). */
const AUTHORITY_SUMMARY = {
  roles: [
    { id: 'clinician', displayName: 'Врач', domain: 'clinic', grants: 2, mutatingGrants: 1 },
  ],
  actions: [
    { id: 'read', mutating: false },
    { id: 'sign', mutating: true },
  ],
  targets: [{ kind: 'record', resolver: 'record-resolver' }],
  agents: [{ id: 'doctor', roles: ['clinician'], ceiling: ['read', 'sign'] }],
  totals: { roles: 1, actions: 2, targets: 1, agents: 1, grants: 2, mutatingGrants: 1 },
}

/** Пакет с контентом полномочий (ответ `GET /packs`). */
const PACK = {
  name: 'clinic-pack',
  version: '1.0.0',
  kind: 'pack',
  status: 'active' as const,
  requiresApproval: false,
  provides: { agents: ['doctor'], skills: [], mcp: [], pipelines: [] },
  authority: AUTHORITY_SUMMARY,
  installedAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
}

/** Детали пакета с сырым манифестом (ответ `GET /packs/:name`). */
const PACK_DETAIL = {
  ...PACK,
  manifest: {
    name: 'clinic-pack',
    version: '1.0.0',
    provides: {
      authority: {
        actions: [
          { id: 'read', mutating: false },
          { id: 'sign', mutating: true },
        ],
        roles: [
          {
            id: 'clinician',
            displayName: 'Врач',
            domain: 'clinic',
            grants: [
              { action: 'read', targetPattern: 'record:*', effect: 'allow' },
              { action: 'sign', targetPattern: 'record:*', effect: 'ask' },
            ],
          },
        ],
        targets: [{ kind: 'record', resolver: 'record-resolver' }],
        agents: [{ id: 'doctor', roles: ['clinician'], ceiling: ['read', 'sign'] }],
      },
    },
  },
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

async function flush(): Promise<void> {
  await act(async () => {})
}

async function renderSettings(roles: string[] = ['USER']): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({ settingsShowAdvanced: true, settingsFocus: null })
  useAuthStore.setState({
    user: { id: 'u1', username: 'user', email: null, roles },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <AuthoritySettings />
      </I18nProvider>,
    )
  })
  await flush()
  await flush()
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getPacks.mockResolvedValue([PACK])
  mocks.getPack.mockResolvedValue(PACK_DETAIL)
})

afterEach(async () => {
  while (roots.length > 0) {
    const entry = roots.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.container.remove()
  }
})

describe('AuthoritySettings — раздел «Полномочия» (read-only)', () => {
  it('показывает роль с грантами «действие × цель, эффект» и источник гранта', async () => {
    const container = await renderSettings()

    expect(mocks.getPacks).toHaveBeenCalled()
    expect(mocks.getPack).toHaveBeenCalledWith('clinic-pack')

    const role = byTestId(container, 'authority-role-clinician')
    expect(role).toBeTruthy()
    const roleText = role?.textContent ?? ''
    expect(roleText).toContain('clinician')
    expect(roleText).toContain('clinic')
    // Грант: действие × цель и эффект.
    expect(roleText).toContain('read')
    expect(roleText).toContain('record:*')
    expect(roleText).toContain('Allow')
    expect(byTestId(container, 'authority-grant-effect-clinician-0')?.textContent).toBe('Allow')
    expect(byTestId(container, 'authority-grant-effect-clinician-1')?.textContent).toBe('Ask')

    // Источник гранта — пакет.
    const source = byTestId(container, 'authority-role-source-clinic-pack')
    expect(source?.textContent).toBe('active')
    expect(byTestId(container, 'authority-role-pack-clinic-pack')?.textContent).toContain(
      'clinic-pack',
    )
  })

  it('показывает привязки агентов к ролям и потолку агента', async () => {
    const container = await renderSettings()

    const agent = byTestId(container, 'authority-agent-doctor')
    expect(agent).toBeTruthy()
    const text = agent?.textContent ?? ''
    expect(text).toContain('doctor')
    expect(text).toContain('clinician')
    expect(text).toContain('sign')
    expect(text).toContain('clinic-pack')
  })

  it('показывает режим слоя: три состояния и честную пометку, что режим не отдаётся API', async () => {
    const container = await renderSettings()

    const mode = byTestId(container, 'authority-mode')
    expect(mode?.textContent).toContain('Not exposed by the API')
    const states = byTestId(container, 'authority-mode-states')?.textContent ?? ''
    expect(states).toContain('Enforcement')
    expect(states).toContain('Log only')
    expect(states).toContain('Disabled')
    expect(mode?.textContent).toContain('synth.authority.enabled')
  })

  it('политика инстанса — честная заглушка (API её не отдаёт)', async () => {
    const container = await renderSettings()

    const stub = byTestId(container, 'authority-policy-stub')
    expect(stub).toBeTruthy()
    expect(stub?.textContent).toContain('config')

    // Состав, принесённый пакетами: объявленные действия и виды целей.
    const content = byTestId(container, 'authority-policy-content-clinic-pack')
    expect(content?.textContent).toContain('read')
    expect(content?.textContent).toContain('sign')
    expect(content?.textContent).toContain('record')
  })

  it('раздел read-only: кнопок мутаций в нём нет', async () => {
    const container = await renderSettings(['ADMIN'])

    expect(container.querySelectorAll('button').length).toBe(0)
  })

  it('без пакетов с контентом полномочий — пустое состояние', async () => {
    mocks.getPacks.mockResolvedValue([])
    const container = await renderSettings()

    expect(byTestId(container, 'authority-roles-empty')).toBeTruthy()
    expect(byTestId(container, 'authority-agents-empty')).toBeTruthy()
  })

  it('403 — понятное сообщение вместо падения', async () => {
    mocks.getPacks.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
    const container = await renderSettings()

    const error = byTestId(container, 'authority-error')
    expect(error?.textContent).toContain('administrator rights')
  })

  it('категория «Полномочия» есть в каталоге и видна всем ролям (в том числе не-ADMIN)', () => {
    const category = CATEGORIES.find((cat) => cat.id === 'authority')
    expect(category).toBeDefined()
    // Без `roles` — раздел виден всем, включая USER/AUDITOR.
    expect(category?.roles).toBeUndefined()

    const visibleFor = (roles: string[]) =>
      CATEGORIES.filter((cat) => !cat.roles || cat.roles.some((r) => roles.includes(r))).map(
        (cat) => cat.id,
      )
    expect(visibleFor(['USER'])).toContain('authority')
    expect(visibleFor(['AUDITOR'])).toContain('authority')
    expect(visibleFor(['ADMIN'])).toContain('authority')
  })
})
