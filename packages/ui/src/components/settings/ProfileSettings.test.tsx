import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
}))

vi.mock('@/lib/api/client', () => ({ api: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { useAuthStore } from '@/stores/authStore'
import { ProfileSettings } from './ProfileSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ProfileSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  useAuthStore.setState({ user: null, profile: null })
  mocks.getProfile.mockResolvedValue({
    username: 'dev',
    display_name: 'Dev',
    email: 'dev@example.com',
    phone: '',
    team_roles: ['developer'],
    notes: '',
    preferences: { avatar: null },
  })
  mocks.updateProfile.mockResolvedValue({ preferences: { avatar: null } })
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

describe('ProfileSettings — миграция на Settings UI Kit (AD-072)', () => {
  it('каркас — SettingsPanel с единственным scroll-контейнером и без pr-2', async () => {
    const container = await renderSettings()

    const scrollers = container.querySelectorAll('.overflow-y-auto')
    expect(scrollers).toHaveLength(1)
    expect(scrollers[0]!.classList.contains('overflow-x-hidden')).toBe(true)
    expect(container.innerHTML).not.toContain('pr-2')
  })

  it('нет grid без базового grid-cols-1', async () => {
    const container = await renderSettings()
    container.querySelectorAll('.grid').forEach((el) => {
      expect(el.classList.contains('grid-cols-1')).toBe(true)
    })
  })

  it('поля профиля рендерятся Kit-контролами', async () => {
    const container = await renderSettings()

    expect(container.textContent).toContain('Profile')
    expect(container.querySelector('#profile-username')).not.toBeNull()
    expect((container.querySelector('#profile-username') as HTMLInputElement).disabled).toBe(true)
    expect(container.querySelector('#profile-display-name')).not.toBeNull()
    expect(container.querySelector('#profile-email')).not.toBeNull()
    expect(container.querySelector('#profile-phone')).not.toBeNull()
    expect(container.querySelector('#profile-notes')).not.toBeNull()
  })

  it('сохранение профиля идёт через SettingsActions', async () => {
    const container = await renderSettings()

    const save = container.querySelector('[data-testid="profile-save"]') as HTMLButtonElement
    expect(save).not.toBeNull()

    await act(async () => {
      save.click()
    })

    expect(mocks.updateProfile).toHaveBeenCalledTimes(1)
  })
})
