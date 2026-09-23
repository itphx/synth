import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const apiMock = vi.hoisted(() => ({
  getSessions: vi.fn(),
  getProjects: vi.fn(),
  getUsers: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { DashboardPanel } from './DashboardPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderPanel(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <DashboardPanel />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  apiMock.getSessions.mockResolvedValue([{}, {}, {}])
  apiMock.getProjects.mockResolvedValue([{}, {}])
  apiMock.getUsers.mockResolvedValue({ users: [{}, {}, {}, {}, {}] })
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

describe('DashboardPanel — миграция на Settings UI Kit (AD-072)', () => {
  it('каркас — SettingsPanel: один скролл, без pr-2, сетка карточек с grid-cols-1', async () => {
    const container = await renderPanel()

    const scrollers = container.querySelectorAll('.overflow-y-auto')
    expect(scrollers).toHaveLength(1)
    expect(scrollers[0]!.classList.contains('overflow-x-hidden')).toBe(true)
    expect(container.innerHTML).not.toContain('pr-2')

    const grid = container.querySelector('.grid')
    expect(grid).not.toBeNull()
    expect(grid!.classList.contains('grid-cols-1')).toBe(true)
  })

  it('показывает статистику по сессиям, проектам и пользователям', async () => {
    const container = await renderPanel()

    expect(container.textContent).toContain('Dashboard')
    expect(container.textContent).toContain('Total sessions')
    expect(container.textContent).toContain('Projects')
    expect(container.textContent).toContain('Users')

    expect(apiMock.getSessions).toHaveBeenCalledTimes(1)
    expect(apiMock.getProjects).toHaveBeenCalledTimes(1)
    expect(apiMock.getUsers).toHaveBeenCalledTimes(1)
  })
})
