import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import type { QueuedMessage } from '@/stores/chatStore'
import { QueuePanel } from './QueuePanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

interface Handlers {
  onResume: ReturnType<typeof vi.fn<() => void>>
  onClear: ReturnType<typeof vi.fn<() => void>>
  onReturnAll: ReturnType<typeof vi.fn<() => void>>
  onReturnMsg: ReturnType<typeof vi.fn<(uiIndex: number) => void>>
  onSteerMsg: ReturnType<typeof vi.fn<(uiIndex: number) => void>>
  onRemoveMsg: ReturnType<typeof vi.fn<(uiIndex: number) => void>>
}

function makeHandlers(): Handlers {
  return {
    onResume: vi.fn<() => void>(),
    onClear: vi.fn<() => void>(),
    onReturnAll: vi.fn<() => void>(),
    onReturnMsg: vi.fn<(uiIndex: number) => void>(),
    onSteerMsg: vi.fn<(uiIndex: number) => void>(),
    onRemoveMsg: vi.fn<(uiIndex: number) => void>(),
  }
}

interface RenderOptions {
  pending?: QueuedMessage[]
  isStalled?: boolean
  pendingCount?: number
  canSteer?: boolean
  canResume?: boolean
  locale?: 'en' | 'ru'
  handlers?: Handlers
}

async function renderPanel(options: RenderOptions = {}): Promise<HTMLElement> {
  const {
    pending = [
      { content: 'первая строка\nвторая строка', attachmentCount: 2 },
      { content: 'второе сообщение', agentRole: 'fixer' },
    ],
    isStalled = false,
    pendingCount = pending.length,
    canSteer = true,
    canResume = false,
    locale = 'en',
    handlers = makeHandlers(),
  } = options

  useI18nStore.setState({
    locale,
    dictionary: locale === 'ru' ? ruDict : enDict,
    loadingLocale: null,
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })

  await act(async () => {
    root.render(
      <I18nProvider>
        <QueuePanel
          pending={pending}
          isStalled={isStalled}
          pendingCount={pendingCount}
          canSteer={canSteer}
          canResume={canResume}
          onResume={handlers.onResume}
          onClear={handlers.onClear}
          onReturnAll={handlers.onReturnAll}
          onReturnMsg={handlers.onReturnMsg}
          onSteerMsg={handlers.onSteerMsg}
          onRemoveMsg={handlers.onRemoveMsg}
        />
      </I18nProvider>,
    )
  })
  return container
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).not.toBeNull()
  await act(async () => {
    ;(el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
})

describe('QueuePanel — строки очереди', () => {
  it('превью — первая строка сообщения, вторая не попадает в строку', async () => {
    const container = await renderPanel()
    await click(container.querySelector('[data-testid="queue-header-toggle"]'))

    const row = container.querySelector('[data-testid="queue-item-0"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('первая строка')
    expect(row!.textContent).not.toContain('вторая строка')
  })

  it('счётчик вложений показывается только когда они есть', async () => {
    const container = await renderPanel()
    await click(container.querySelector('[data-testid="queue-header-toggle"]'))

    const withAttachments = container.querySelector('[data-testid="queue-attachments-0"]')
    expect(withAttachments).not.toBeNull()
    expect(withAttachments!.textContent).toContain('2')
    expect(container.querySelector('[data-testid="queue-attachments-1"]')).toBeNull()
  })

  it('агент в очереди — префикс @role, без роли — порядковый номер', async () => {
    const container = await renderPanel()
    await click(container.querySelector('[data-testid="queue-header-toggle"]'))

    expect(container.querySelector('[data-testid="queue-item-0"]')!.textContent).toContain('#1')
    expect(container.querySelector('[data-testid="queue-item-1"]')!.textContent).toContain('@fixer')
  })

  it('статус строки: starting и queued подписаны, без статуса — плашки нет', async () => {
    const container = await renderPanel({
      locale: 'ru',
      pending: [
        { id: 'm1', content: 'запускается', status: 'starting' },
        { id: 'm2', content: 'ждёт', status: 'queued' },
        { id: 'm3', content: 'без статуса' },
      ],
    })
    await click(container.querySelector('[data-testid="queue-header-toggle"]'))

    expect(container.querySelector('[data-testid="queue-status-0"]')!.textContent).toBe('Запускается')
    expect(container.querySelector('[data-testid="queue-status-1"]')!.textContent).toBe('В очереди')
    expect(container.querySelector('[data-testid="queue-status-2"]')).toBeNull()
    // Действия строки не ломаются статусом.
    expect(container.querySelector('[data-testid="queue-remove-0"]')).not.toBeNull()
  })
})

describe('QueuePanel — действия строки', () => {
  it('«В разрыв» есть только при активном ходе (canSteer)', async () => {
    const withoutTurn = await renderPanel({ canSteer: false })
    await click(withoutTurn.querySelector('[data-testid="queue-header-toggle"]'))
    expect(withoutTurn.querySelector('[data-testid="queue-steer-0"]')).toBeNull()
    expect(withoutTurn.querySelector('[data-testid="queue-return-0"]')).not.toBeNull()
    expect(withoutTurn.querySelector('[data-testid="queue-remove-0"]')).not.toBeNull()
  })

  it('при canSteer кнопка «В разрыв» видна', async () => {
    const container = await renderPanel({ canSteer: true })
    await click(container.querySelector('[data-testid="queue-header-toggle"]'))
    expect(container.querySelector('[data-testid="queue-steer-0"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="queue-steer-1"]')).not.toBeNull()
  })

  it('клики вызывают обработчики с индексом строки', async () => {
    const handlers = makeHandlers()
    const container = await renderPanel({ handlers })
    await click(container.querySelector('[data-testid="queue-header-toggle"]'))

    await click(container.querySelector('[data-testid="queue-steer-1"]'))
    await click(container.querySelector('[data-testid="queue-return-1"]'))
    await click(container.querySelector('[data-testid="queue-remove-1"]'))

    expect(handlers.onSteerMsg).toHaveBeenCalledWith(1)
    expect(handlers.onReturnMsg).toHaveBeenCalledWith(1)
    expect(handlers.onRemoveMsg).toHaveBeenCalledWith(1)
  })

  it('неподтверждённая строка (`sending`) показывает спиннер и не даёт действий очереди', async () => {
    const container = await renderPanel({
      pending: [{ id: 'stream-1-1', content: 'в очереди', sending: true }],
    })
    await click(container.querySelector('[data-testid="queue-header-toggle"]'))

    const sending = container.querySelector('[data-testid="queue-sending-0"]')
    expect(sending).not.toBeNull()
    expect(sending!.getAttribute('aria-label')).toBe('Message sent; confirmation is delayed — checking the queue')
    // Действия требуют серверного id — до подтверждения их нет.
    expect(container.querySelector('[data-testid="queue-steer-0"]')).toBeNull()
    expect(container.querySelector('[data-testid="queue-return-0"]')).toBeNull()
    expect(container.querySelector('[data-testid="queue-remove-0"]')).toBeNull()
  })

  it('кнопки строки имеют tooltip/aria-подписи из словаря', async () => {
    const container = await renderPanel({ locale: 'ru' })
    await click(container.querySelector('[data-testid="queue-header-toggle"]'))

    const steer = container.querySelector('[data-testid="queue-steer-0"]')
    expect(steer!.getAttribute('title')).toBe('В разрыв')
    expect(steer!.getAttribute('aria-label')).toBe('В разрыв')
    expect(container.querySelector('[data-testid="queue-return-0"]')!.getAttribute('title'))
      .toBe('Вернуть в поле ввода')
    expect(container.querySelector('[data-testid="queue-remove-0"]')!.getAttribute('title'))
      .toBe('Удалить')
  })
})

describe('QueuePanel — заголовок и сворачивание', () => {
  it('по умолчанию свёрнут; заголовок показывает счётчик и раскрывает список', async () => {
    const container = await renderPanel()
    const header = container.querySelector('[data-testid="queue-header-toggle"]')

    expect(header!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-testid="queue-header-count"]')!.textContent)
      .toBe('In queue: 2')
    expect(container.querySelector('[data-testid="queue-item-0"]')).toBeNull()

    await click(header)
    expect(header!.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('[data-testid^="queue-item-"]').length).toBe(2)

    await click(header)
    expect(header!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-testid="queue-item-0"]')).toBeNull()
  })

  it('при остановленной очереди список раскрыт и есть «Продолжить»', async () => {
    const handlers = makeHandlers()
    const container = await renderPanel({ isStalled: true, pendingCount: 2, handlers })

    expect(container.querySelector('[data-testid="queue-item-0"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="queue-header-count"]')!.textContent)
      .toBe('Processing stopped: 2 messages')

    const buttons = Array.from(container.querySelectorAll('button'))
    const resume = buttons.find((b) => b.textContent === 'Resume')
    expect(resume).not.toBeUndefined()
    await click(resume)
    expect(handlers.onResume).toHaveBeenCalledTimes(1)
  })

  it('«Вернуть всё» и «Очистить» в заголовке вызывают обработчики', async () => {
    const handlers = makeHandlers()
    const container = await renderPanel({ handlers })
    const buttons = Array.from(container.querySelectorAll('button'))
    await click(buttons.find((b) => b.textContent === 'Return to input') ?? null)
    await click(buttons.find((b) => b.textContent === 'Clear') ?? null)

    expect(handlers.onReturnAll).toHaveBeenCalledTimes(1)
    expect(handlers.onClear).toHaveBeenCalledTimes(1)
  })

  it('пустая очередь вне остановки ничего не рендерит', async () => {
    const container = await renderPanel({ pending: [], pendingCount: 0 })
    expect(container.textContent).toBe('')
  })
})

describe('QueuePanel — возобновление очереди', () => {
  it('после «Стопа» (очередь непуста, хода нет) кнопка «Продолжить» доступна', async () => {
    const handlers = makeHandlers()
    const container = await renderPanel({ canResume: true, handlers })

    const resume = container.querySelector('[data-testid="queue-resume"]')
    expect(resume).not.toBeNull()
    await click(resume)
    expect(handlers.onResume).toHaveBeenCalledTimes(1)
  })

  it('без canResume (ход идёт) кнопки «Продолжить» нет', async () => {
    const container = await renderPanel({ canResume: false })
    expect(container.querySelector('[data-testid="queue-resume"]')).toBeNull()
  })

  it('при остановленной очереди кнопка «Продолжить» есть независимо от canResume', async () => {
    const container = await renderPanel({ isStalled: true, canResume: false })
    expect(container.querySelector('[data-testid="queue-resume"]')).not.toBeNull()
  })
})
