import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getWorkspaceRoot: vi.fn(),
  browseWorkspaceRoot: vi.fn(),
  mkdirWorkspaceRoot: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { DirectoryPickerDialog } from './DirectoryPickerDialog'
import type { FileEntry } from '@itphx/synth-shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

interface RenderHandlers {
  onOpenChange: ReturnType<typeof vi.fn>
  onSelect: ReturnType<typeof vi.fn>
}

const entry = (name: string, path: string): FileEntry => ({
  name,
  path,
  isDirectory: true,
  size: 0,
  modifiedAt: 0,
})

function apiError(status: number, code: string, message = 'error'): Error {
  return Object.assign(new Error(message), { status, code })
}

async function render(
  props?: Partial<React.ComponentProps<typeof DirectoryPickerDialog>>,
): Promise<RenderHandlers> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })

  const onOpenChange = vi.fn()
  const onSelect = vi.fn()
  await act(async () => {
    root.render(
      <I18nProvider>
        <DirectoryPickerDialog
          open
          onOpenChange={onOpenChange}
          onSelect={onSelect}
          {...props}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return { onOpenChange, onSelect }
}

const byTestId = (id: string): HTMLElement | null =>
  document.body.querySelector(`[data-testid="${id}"]`)

const click = async (el: Element | null | undefined) => {
  expect(el, 'элемент для клика не найден').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

const typeInto = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  mocks.getWorkspaceRoot.mockResolvedValue({
    root: '/ws',
    entries: [entry('alpha', 'alpha'), entry('beta', 'beta')],
  })
  mocks.browseWorkspaceRoot.mockResolvedValue({
    root: '/ws',
    path: 'alpha',
    entries: [entry('nested', 'alpha/nested')],
  })
  mocks.mkdirWorkspaceRoot.mockResolvedValue({ created: true, path: 'alpha/new' })
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

describe('DirectoryPickerDialog (AD-075)', () => {
  it('отрисовывается и загружает корень workspace', async () => {
    await render()

    expect(mocks.getWorkspaceRoot).toHaveBeenCalledWith(false)
    expect(byTestId('workspace-current-path')?.textContent).toBe('/ws')
    expect(byTestId('workspace-entry-alpha')).not.toBeNull()
    expect(byTestId('workspace-entry-beta')).not.toBeNull()
  })

  it('навигация по подкаталогам обновляет путь', async () => {
    await render()

    await click(byTestId('workspace-entry-alpha'))
    await act(async () => {})

    expect(mocks.browseWorkspaceRoot).toHaveBeenCalledWith('alpha', false)
    expect(byTestId('workspace-current-path')?.textContent).toBe('/ws/alpha')
    expect(byTestId('workspace-entry-nested')).not.toBeNull()
  })

  it('выбор текущего каталога вызывает onSelect(absolute) и закрывает диалог', async () => {
    const { onSelect, onOpenChange } = await render()

    await click(byTestId('workspace-select-current'))

    expect(onSelect).toHaveBeenCalledWith('/ws')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('тумблер «Показать скрытые» перечитывает каталог с includeHidden', async () => {
    await render()

    const toggle = document.body.querySelector('[role="switch"]')
    await click(toggle)

    expect(mocks.browseWorkspaceRoot).toHaveBeenCalledWith('', true)
  })

  it('создание вне корня: 409 → подтверждение → повтор с confirmOutsideRoot', async () => {
    mocks.mkdirWorkspaceRoot
      .mockRejectedValueOnce(
        apiError(409, 'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED', 'confirmation required'),
      )
      .mockResolvedValueOnce({ created: true, path: '../outside/new' })

    await render()
    await typeInto(byTestId('workspace-new-folder') as HTMLInputElement, 'new')
    await click(byTestId('workspace-create'))
    await act(async () => {})

    // Первая попытка — без флага подтверждения.
    expect(mocks.mkdirWorkspaceRoot).toHaveBeenNthCalledWith(1, 'new', false)

    // Появился ConfirmDialog вне корня.
    const confirmDialog = [...document.body.querySelectorAll('[data-slot="dialog-content"]')].find(
      (d) => d.textContent?.includes('Create outside workspace root?'),
    )
    expect(confirmDialog).toBeTruthy()

    const confirmButton = [...confirmDialog!.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create',
    )
    await click(confirmButton)
    await act(async () => {})

    expect(mocks.mkdirWorkspaceRoot).toHaveBeenNthCalledWith(2, 'new', true)
    expect(byTestId('workspace-error')).toBeNull()
  })

  it('403 при навигации показывается ошибкой и не роняет диалог', async () => {
    mocks.browseWorkspaceRoot.mockRejectedValueOnce(
      apiError(403, 'PROTECTED_PATH_DENIED', 'denied'),
    )

    await render()
    await click(byTestId('workspace-entry-alpha'))
    await act(async () => {})

    const error = byTestId('workspace-error')
    expect(error).not.toBeNull()
    expect(error!.textContent).toContain('denied by policy')
    // Диалог остаётся смонтированным.
    expect(byTestId('workspace-select-current')).not.toBeNull()
  })

  it('403 при создании (deny-политика) показывается ошибкой', async () => {
    mocks.mkdirWorkspaceRoot.mockRejectedValueOnce(
      apiError(403, 'WORKSPACE_OUTSIDE_ROOT_DENIED', 'denied'),
    )

    await render()
    await typeInto(byTestId('workspace-new-folder') as HTMLInputElement, 'new')
    await click(byTestId('workspace-create'))
    await act(async () => {})

    expect(byTestId('workspace-error')?.textContent).toContain('denied by policy')
  })
})
