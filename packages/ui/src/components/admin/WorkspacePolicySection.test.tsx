import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

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
  getWorkspacePolicy: vi.fn(),
  setWorkspacePolicy: vi.fn(),
  clearWorkspacePolicy: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { WorkspacePolicySection } from './WorkspacePolicySection'
import { useAuthStore } from '@/stores/authStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderSection(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <WorkspacePolicySection />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

const click = async (el: Element | null | undefined) => {
  expect(el, 'элемент для клика не найден').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

beforeEach(() => {
  mocks.getWorkspacePolicy.mockResolvedValue({ outsideRoot: 'confirm', isOverridden: false, defaults: 'confirm' })
  mocks.setWorkspacePolicy.mockResolvedValue({ outsideRoot: 'deny' })
  mocks.clearWorkspacePolicy.mockResolvedValue({
    outsideRoot: 'confirm',
    isOverridden: false,
    defaults: 'confirm',
    status: 'restored',
  })
  useAuthStore.setState({ deployment: 'standalone' } as never)
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

describe('WorkspacePolicySection (ADR-075)', () => {
  it('читает политику и показывает текущее значение', async () => {
    const container = await renderSection()
    expect(mocks.getWorkspacePolicy).toHaveBeenCalled()

    const group = container.querySelector('[role="radiogroup"]')!
    expect(group).not.toBeNull()
    const confirm = [...group.querySelectorAll('[role="radio"]')].find((r) => r.textContent === 'Ask for confirmation')
    expect(confirm!.getAttribute('aria-checked')).toBe('true')
  })

  it('сохраняет выбранную политику через setWorkspacePolicy', async () => {
    mocks.getWorkspacePolicy
      .mockResolvedValueOnce({ outsideRoot: 'confirm', isOverridden: false, defaults: 'confirm' })
      .mockResolvedValue({ outsideRoot: 'deny', isOverridden: true, defaults: 'confirm' })
    const container = await renderSection()

    const deny = [...container.querySelectorAll('[role="radio"]')].find((r) => r.textContent === 'Deny')
    await click(deny)
    await click(container.querySelector('[data-testid="workspace-policy-save"]'))
    await act(async () => {})

    expect(mocks.setWorkspacePolicy).toHaveBeenCalledWith({ outsideRoot: 'deny' })
    expect(container.querySelector('[data-testid="workspace-policy-status"]')?.textContent).toContain('Overridden')
  })

  it('сбрасывает runtime-override через clearWorkspacePolicy', async () => {
    mocks.getWorkspacePolicy.mockResolvedValue({ outsideRoot: 'deny', isOverridden: true, defaults: 'confirm' })
    const container = await renderSection()

    await click(container.querySelector('[data-testid="workspace-policy-reset"]'))
    await act(async () => {})

    expect(mocks.clearWorkspacePolicy).toHaveBeenCalled()
  })

  it('managed-развёртывание — read-only deny без контрола', async () => {
    useAuthStore.setState({ deployment: 'managed' } as never)
    const container = await renderSection()

    expect(container.querySelector('[data-testid="workspace-policy-managed"]')).not.toBeNull()
    expect(container.querySelector('[role="radiogroup"]')).toBeNull()
    expect(container.querySelector('[data-testid="workspace-policy-save"]')).toBeNull()
  })
})
