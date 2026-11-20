import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

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

const mocks = vi.hoisted(() => ({
  getUsers: vi.fn(),
  getUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useUsersStore } from '@/stores/usersStore'
import { UsersPanel } from './UsersPanel'
import type { UserInfo } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Пользователь каталога: обязательные поля DTO (см. `lib/api/users.ts`). */
function makeUser(id: string, username: string, extra: Partial<UserInfo> = {}): UserInfo {
  return {
    id,
    username,
    email: `${username}@example.com`,
    roles: ['USER'],
    team_roles: [],
    display_name: null,
    is_active: true,
    notes: '',
    preferences: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_login: null,
    ...extra,
  }
}

const ADMIN_USER = makeUser('u-1', 'admin', { roles: ['ADMIN'], display_name: 'Admin' })
const NEW_USER = makeUser('u-2', 'newbie', { display_name: 'New User' })

async function flush(): Promise<void> {
  await act(async () => {})
}

async function renderPanel(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <UsersPanel />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await flush()
  await flush()
  return container
}

/** Мутация каталога в другом клиенте/вкладке: шина → `usersStore.applyEvent()`. */
async function emitUsersUpdated(): Promise<void> {
  await act(async () => {
    useUsersStore.getState().applyEvent()
  })
  await flush()
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getUsers.mockResolvedValue({ users: [ADMIN_USER] })
  mocks.getUser.mockResolvedValue(ADMIN_USER)
  mocks.confirm.mockResolvedValue(true)
  // Счётчик — на модуль: между тестами обнуляем, иначе первый рендер увидит
  // `revision > 0` и перечитает список дважды.
  useUsersStore.setState({ revision: 0 })
})

afterEach(async () => {
  while (roots.length > 0) {
    const entry = roots.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.container.remove()
  }
  document.body.innerHTML = ''
})

describe('UsersPanel — событие `users.updated` (инвариант 27)', () => {
  it('начальный список читается один раз (revision === 0 — не сигнал)', async () => {
    const container = await renderPanel()

    expect(mocks.getUsers).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('admin')
  })

  it('событие перечитывает каталог: новый пользователь появляется без перезагрузки', async () => {
    const container = await renderPanel()

    expect(container.textContent).not.toContain('newbie')

    // Пользователь создан во второй вкладке админки (`POST /api/v2/users`).
    mocks.getUsers.mockResolvedValue({ users: [ADMIN_USER, NEW_USER] })

    await emitUsersUpdated()

    expect(mocks.getUsers).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('newbie')
  })

  it('удалённый в другом клиенте пользователь исчезает по событию', async () => {
    mocks.getUsers.mockResolvedValue({ users: [ADMIN_USER, NEW_USER] })
    const container = await renderPanel()

    expect(container.textContent).toContain('newbie')

    mocks.getUsers.mockResolvedValue({ users: [ADMIN_USER] })

    await emitUsersUpdated()

    expect(container.textContent).not.toContain('newbie')
  })

  it('ошибка перечитывания по событию показывается баннером, панель не падает', async () => {
    const container = await renderPanel()

    mocks.getUsers.mockRejectedValue(new Error('users backend down'))

    await emitUsersUpdated()

    expect(container.textContent).toContain('users backend down')
  })
})
