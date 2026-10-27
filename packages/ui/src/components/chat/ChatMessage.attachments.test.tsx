import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
// Заглушку ставим до импорта стора (vi.hoisted выполняется раньше импортов).
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

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'
import type { MediaPartData, Part } from '@itphx/synth-shared/types'
import { useUIStore } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'

function mediaPart(id: string, type: 'image' | 'audio' | 'video' | 'file', data: Partial<MediaPartData> = {}): Part {
  const base: MediaPartData = {
    blobPath: `attachments/ab/${id}`,
    sha256: `sha-${id}`,
    mime: 'application/octet-stream',
    size: 1024,
    ...data,
  }
  return { id, type, data: base }
}

function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'user',
    content: 'Ответ ассистента',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-09-19T00:00:00Z',
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderChat(message: MessageData, sessionId?: string): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ChatMessage
          message={message}
          sessionId={sessionId}
          onCopy={() => {}}
          onToggle={() => {}}
          onPin={() => {}}
          onDelete={() => {}}
          onRetry={() => {}}
          onDebug={() => {}}
          onFork={() => {}}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {})
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
  document.body.innerHTML = ''
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
})

describe('ChatMessage: вложения сообщения (ADR-115)', () => {
  it('user-сообщение с картинкой показывает блок вложений, текст остаётся', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'user',
        content: 'Посмотри на скриншот',
        parts: [
          { id: 't1', type: 'text', data: { text: 'Посмотри на скриншот' } },
          mediaPart('p1', 'image', { mime: 'image/png', name: 'shot.png' }),
        ],
      }),
      SESSION,
    )

    expect(container.querySelector('[data-testid="message-attachments"]')).not.toBeNull()
    const img = container.querySelector('[data-testid="message-attachment-image"] img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/v2/sessions/s1/attachments/p1')
    // Текст не подменён вложениями.
    expect(container.textContent).toContain('Посмотри на скриншот')
  })

  it('assistant-сообщение из одной картинки (без текста) рендерится', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'assistant',
        content: '',
        parts: [mediaPart('p2', 'image', { mime: 'image/png', name: 'chart.png' })],
      }),
      SESSION,
    )

    const img = container.querySelector('[data-testid="message-attachment-image"] img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('/api/v2/sessions/s1/attachments/p2')
  })

  it('файл-вложение показывается чипом в assistant-сообщении', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'assistant',
        content: 'Готово',
        parts: [mediaPart('p3', 'file', { mime: 'application/pdf', name: 'out.pdf', size: 1024 })],
      }),
      SESSION,
    )

    const chip = container.querySelector('[data-testid="message-attachment-file"]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toContain('out.pdf')
    expect(container.textContent).toContain('Готово')
  })

  it('сообщение без медиа-частей не рисует блок вложений', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'user',
        content: 'Просто текст',
        parts: [{ id: 't1', type: 'text', data: { text: 'Просто текст' } }],
      }),
      SESSION,
    )

    expect(container.querySelector('[data-testid="message-attachments"]')).toBeNull()
    expect(container.textContent).toContain('Просто текст')
  })

  it('URL берётся из пропа sessionId, а не из активной вкладки', async () => {
    useUIStore.setState({
      centerTabs: [{ id: 'chat-other', type: 'chat', title: 'Other', data: { sessionId: 'other' } }],
      activeCenterTabId: 'chat-other',
    })
    const container = await renderChat(
      makeMessage({
        role: 'user',
        content: '',
        parts: [mediaPart('p4', 'image', { mime: 'image/png', name: 'x.png' })],
      }),
      SESSION,
    )

    const img = container.querySelector('[data-testid="message-attachment-image"] img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/v2/sessions/s1/attachments/p4')
  })
})
