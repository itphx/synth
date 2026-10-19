import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
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

import React from 'react'

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  getMyIdentities: vi.fn(),
  deleteMyIdentity: vi.fn(),
  claimIdentity: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/client', () => ({ api: mocks }))
vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuthStore } from '@/stores/authStore'
import { ProfileSettings } from './ProfileSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({ settingsShowAdvanced: true, settingsFocus: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <ProfileSettings />
        </TooltipProvider>
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
    interview_completed: false,
    preferences: { avatar: null },
  })
  mocks.updateProfile.mockResolvedValue({ preferences: { avatar: null } })
  mocks.getMyIdentities.mockResolvedValue({ identities: [] })
  mocks.deleteMyIdentity.mockResolvedValue(undefined)
  mocks.claimIdentity.mockResolvedValue({
    identity: { provider: 'tg', externalId: '450316139', linkedAt: '2026-03-01T10:00:00.000Z', linkedBy: 'u1' },
  })
  mocks.confirm.mockResolvedValue(true)
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

describe('ProfileSettings — миграция на Settings UI Kit (ADR-072)', () => {
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

  it('сохранение профиля идёт через SettingsActions (активен только при изменениях)', async () => {
    const container = await renderSettings()

    const save = container.querySelector('[data-testid="profile-save"]') as HTMLButtonElement
    expect(save).not.toBeNull()
    // ADR-072: без несохранённых изменений Save неактивен.
    expect(save.disabled).toBe(true)

    const displayName = container.querySelector('#profile-display-name') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(displayName, 'Changed')
      displayName.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(save.disabled).toBe(false)

    await act(async () => {
      save.click()
    })

    expect(mocks.updateProfile).toHaveBeenCalledTimes(1)
  })

  it('действия рендерятся внутри scroll-тела, а не fixed-футером', async () => {
    const container = await renderSettings()

    const scroll = container.querySelector('.overflow-y-auto')!
    const save = container.querySelector('[data-testid="profile-save"]')!
    expect(scroll.contains(save)).toBe(true)
  })

  it('Cancel откатывает форму к загруженному состоянию и сбрасывает disabled', async () => {
    const container = await renderSettings()

    const cancel = container.querySelector('[data-testid="profile-cancel"]') as HTMLButtonElement
    expect(cancel).not.toBeNull()
    expect(cancel.disabled).toBe(true)

    const displayName = container.querySelector('#profile-display-name') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(displayName, 'Changed')
      displayName.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect((container.querySelector('#profile-display-name') as HTMLInputElement).value).toBe('Changed')
    expect(cancel.disabled).toBe(false)

    await act(async () => {
      cancel.click()
    })

    expect((container.querySelector('#profile-display-name') as HTMLInputElement).value).toBe('Dev')
    expect(cancel.disabled).toBe(true)
  })

  it('после успешного Save Cancel снова disabled', async () => {
    const container = await renderSettings()

    const displayName = container.querySelector('#profile-display-name') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(displayName, 'Saved name')
      displayName.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const save = container.querySelector('[data-testid="profile-save"]') as HTMLButtonElement
    await act(async () => {
      save.click()
    })

    const cancel = container.querySelector('[data-testid="profile-cancel"]') as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
  })

  it('тумблер интервью грузится из interview_completed и уходит в updateProfile', async () => {
    mocks.getProfile.mockResolvedValue({
      username: 'dev',
      display_name: 'Dev',
      email: 'dev@example.com',
      phone: '',
      team_roles: ['developer'],
      notes: '',
      interview_completed: true,
      preferences: { avatar: null },
    })

    const container = await renderSettings()

    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      toggle.click()
    })

    const save = container.querySelector('[data-testid="profile-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })

    expect(mocks.updateProfile).toHaveBeenCalledTimes(1)
    expect(mocks.updateProfile.mock.calls[0]![0]).toMatchObject({ interview_completed: false })
  })
})

describe('ProfileSettings — идентичности (ADR-089)', () => {
  it('пустое состояние при отсутствии идентичностей', async () => {
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="profile-identities-empty"]')).not.toBeNull()
    expect(container.textContent).toContain('Identities')
  })

  it('список идентичностей: provider:externalId, имя и дата', async () => {
    mocks.getMyIdentities.mockResolvedValue({
      identities: [
        {
          provider: 'tg',
          externalId: '450316139',
          username: 'john',
          displayName: 'John Doe',
          linkedAt: '2026-03-01T10:00:00.000Z',
        },
      ],
    })

    const container = await renderSettings()
    await act(async () => {})

    const list = container.querySelector('[data-testid="profile-identities-list"]')
    expect(list).not.toBeNull()
    expect(container.querySelector('[data-testid="profile-identity-tg:450316139"]')).not.toBeNull()
    expect(container.textContent).toContain('John Doe')
    expect(container.textContent).toContain('tg:450316139')
  })

  it('отвязка: подтверждение → deleteMyIdentity и удаление строки', async () => {
    mocks.getMyIdentities.mockResolvedValue({
      identities: [
        { provider: 'tg', externalId: '1', displayName: 'A', linkedAt: '2026-03-01T10:00:00.000Z' },
      ],
    })
    mocks.confirm.mockResolvedValue(true)

    const container = await renderSettings()
    await act(async () => {})

    const unlink = container.querySelector('[data-testid="profile-identity-unlink-tg:1"]') as HTMLButtonElement
    expect(unlink).not.toBeNull()
    await act(async () => {
      unlink.click()
    })

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteMyIdentity).toHaveBeenCalledWith('tg', '1')
    expect(container.querySelector('[data-testid="profile-identity-tg:1"]')).toBeNull()
    expect(container.querySelector('[data-testid="profile-identities-empty"]')).not.toBeNull()
  })

  it('отмена подтверждения не вызывает deleteMyIdentity', async () => {
    mocks.getMyIdentities.mockResolvedValue({
      identities: [
        { provider: 'tg', externalId: '2', linkedAt: '2026-03-01T10:00:00.000Z' },
      ],
    })
    mocks.confirm.mockResolvedValue(false)

    const container = await renderSettings()
    await act(async () => {})

    const unlink = container.querySelector('[data-testid="profile-identity-unlink-tg:2"]') as HTMLButtonElement
    await act(async () => {
      unlink.click()
    })

    expect(mocks.deleteMyIdentity).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="profile-identity-tg:2"]')).not.toBeNull()
  })

  it('ошибка загрузки идентичностей показывается пользователю', async () => {
    mocks.getMyIdentities.mockRejectedValue(new Error('boom'))

    const container = await renderSettings()
    await act(async () => {})

    expect(container.textContent).toContain('boom')
  })

  // --- ADR-089 (claim-flow): форма подтверждения по коду ---

  /** Вводит код в claim-поле (нативный сеттер React). */
  const typeCode = async (container: HTMLElement, code: string) => {
    const input = container.querySelector('#profile-identity-claim-code') as HTMLInputElement
    expect(input).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, code)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('claim: кнопка недоступна при пустом коде', async () => {
    const container = await renderSettings()
    await act(async () => {})

    const button = container.querySelector('[data-testid="profile-identity-claim"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.disabled).toBe(true)

    await typeCode(container, 'ABC-DEF')
    expect(button.disabled).toBe(false)

    await typeCode(container, '   ')
    expect(button.disabled).toBe(true)
  })

  it('claim: успех — claimIdentity вызван, список обновился, поле очищено', async () => {
    const container = await renderSettings()
    await act(async () => {})

    await typeCode(container, 'ABC-DEF')
    const button = container.querySelector('[data-testid="profile-identity-claim"]') as HTMLButtonElement
    await act(async () => {
      button.click()
    })

    expect(mocks.claimIdentity).toHaveBeenCalledWith('ABC-DEF')
    expect(container.querySelector('[data-testid="profile-identity-tg:450316139"]')).not.toBeNull()
    expect((container.querySelector('#profile-identity-claim-code') as HTMLInputElement).value).toBe('')
  })

  it('claim: 404 — текст «код недействителен»', async () => {
    mocks.claimIdentity.mockRejectedValue(Object.assign(new Error('nf'), { status: 404, code: 'NOT_FOUND' }))

    const container = await renderSettings()
    await act(async () => {})
    await typeCode(container, 'BAD-CODE')
    await act(async () => {
      (container.querySelector('[data-testid="profile-identity-claim"]') as HTMLButtonElement).click()
    })

    expect(container.textContent).toContain('Code is invalid, expired, or already used')
  })

  it('claim: 409 — текст «уже привязана к другому профилю»', async () => {
    mocks.claimIdentity.mockRejectedValue(Object.assign(new Error('c'), { status: 409, code: 'CONFLICT' }))

    const container = await renderSettings()
    await act(async () => {})
    await typeCode(container, 'ABC-DEF')
    await act(async () => {
      (container.querySelector('[data-testid="profile-identity-claim"]') as HTMLButtonElement).click()
    })

    expect(container.textContent).toContain('already linked to another profile')
  })

  it('claim: 400 — текст «укажите код»', async () => {
    mocks.claimIdentity.mockRejectedValue(Object.assign(new Error('v'), { status: 400, code: 'VALIDATION_ERROR' }))

    const container = await renderSettings()
    await act(async () => {})
    await typeCode(container, 'ABC-DEF')
    await act(async () => {
      (container.querySelector('[data-testid="profile-identity-claim"]') as HTMLButtonElement).click()
    })

    expect(container.textContent).toContain('Enter the confirmation code')
  })

  it('claim: после ошибки повторный ввод кода сбрасывает сообщение', async () => {
    mocks.claimIdentity.mockRejectedValue(Object.assign(new Error('nf'), { status: 404, code: 'NOT_FOUND' }))

    const container = await renderSettings()
    await act(async () => {})
    await typeCode(container, 'BAD-CODE')
    await act(async () => {
      (container.querySelector('[data-testid="profile-identity-claim"]') as HTMLButtonElement).click()
    })
    expect(container.textContent).toContain('Code is invalid, expired, or already used')

    // Новый ввод — сообщение об ошибке очищается.
    await typeCode(container, 'NEW-CODE')
    expect(container.textContent).not.toContain('Code is invalid, expired, or already used')
  })
})
