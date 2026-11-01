import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import type { PermissionPreview } from '@itphx/synth-shared/types'

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
}))

vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { PermissionRequestBar } from './PermissionRequestBar'
import { usePermissionStore } from '@/stores/permissionStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const SESSION_ID = 's1'

function makePreview(diff: string, path = 'a.txt'): PermissionPreview {
  return {
    files: [
      {
        path,
        diff,
        additions: diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
        deletions: diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
      },
    ],
  }
}

function addRequest(preview?: PermissionPreview): void {
  usePermissionStore.getState().addRequest(SESSION_ID, {
    approvalId: 'approval_1',
    toolName: 'write_file',
    params: { file_path: 'a.txt', content: 'new' },
    reason: 'правило file.* → ask',
    askedAt: new Date().toISOString(),
    timeoutMs: 30_000,
    ...(preview ? { preview } : {}),
  })
}

async function renderBar(sessionId = SESSION_ID): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <PermissionRequestBar sessionId={sessionId} />
      </I18nProvider>,
    )
  })
  return container
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  usePermissionStore.setState({ requestsBySession: {} })
  vi.clearAllMocks()
})

describe('PermissionRequestBar — превью изменений', () => {
  beforeAll(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('без превью блок превью не рендерится', async () => {
    addRequest()
    const container = await renderBar()
    expect(container.querySelector('[data-testid="permission-preview"]')).toBeNull()
  })

  it('с превью показывает путь файла, счётчики и строки диффа', async () => {
    addRequest(
      makePreview('--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-one\n+uno\n two'),
    )
    const container = await renderBar()

    const preview = container.querySelector('[data-testid="permission-preview"]')
    expect(preview).not.toBeNull()
    expect(preview!.textContent).toContain('a.txt')
    expect(preview!.textContent).toContain('+1')
    expect(preview!.textContent).toContain('−1')
    expect(preview!.textContent).toContain('-one')
    expect(preview!.textContent).toContain('+uno')
  })

  it('дифф длиннее 40 строк обрезается, остаток — счётчиком', async () => {
    const lines = ['--- a/a.txt', '+++ b/a.txt']
    for (let i = 0; i < 60; i++) lines.push(`+строка ${i}`)
    addRequest(makePreview(lines.join('\n')))
    const container = await renderBar()

    const preview = container.querySelector('[data-testid="permission-preview"]')!
    expect(preview.textContent).toContain('+строка 0')
    // 62 строки диффа, показаны 40 → остаток 22.
    expect(preview.textContent).toContain('Ещё 22')
    expect(preview.textContent).not.toContain('+строка 41')
  })

  it('файл превью сворачивается и разворачивается', async () => {
    addRequest(makePreview('--- a/a.txt\n+++ b/a.txt\n+uno'))
    const container = await renderBar()

    const preview = container.querySelector('[data-testid="permission-preview"]')!
    const toggle = preview.querySelector('button')!
    expect(preview.textContent).toContain('+uno')

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(preview.textContent).not.toContain('+uno')

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(preview.textContent).toContain('+uno')
  })
})
