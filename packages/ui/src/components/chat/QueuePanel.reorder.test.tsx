/**
 * DnD-переупорядочивание очереди (`QueuePanel`): перетаскивание строки даёт
 * новый порядок серверных id в `onReorder`. На тач-указателе (и при строках без
 * серверного id/неподтверждённых) перетаскивание выключено — как в деревьях.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import type { QueuedMessage } from '@/stores/chatStore'

const device = vi.hoisted(() => ({ isTouch: false }))
vi.mock('@/hooks/useDevice', () => ({
  useDevice: () => ({ deviceType: device.isTouch ? 'phone' : 'desktop', isTouch: device.isTouch }),
}))

import { QueuePanel } from './QueuePanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

interface RenderOptions {
  pending?: QueuedMessage[]
  onReorder?: (ids: string[]) => void
}

async function renderPanel(options: RenderOptions = {}): Promise<HTMLElement> {
  const {
    pending = [
      { id: 'a', content: 'первое' },
      { id: 'b', content: 'второе' },
      { id: 'c', content: 'третье' },
    ],
    onReorder,
  } = options

  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })

  await act(async () => {
    root.render(
      <I18nProvider>
        <QueuePanel
          pending={pending}
          isStalled={false}
          pendingCount={pending.length}
          canSteer={false}
          onResume={() => {}}
          onClear={() => {}}
          onReturnAll={() => {}}
          onReturnMsg={() => {}}
          onSteerMsg={() => {}}
          onRemoveMsg={() => {}}
          onReorder={onReorder}
        />
      </I18nProvider>,
    )
  })
  // Свёрнутая по умолчанию панель: раскрываем, чтобы строки были в DOM.
  await click(container.querySelector('[data-testid="queue-header-toggle"]'))
  return container
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).not.toBeNull()
  await act(async () => {
    ;(el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** jsdom не несёт DataTransfer — подкладываем минимальный объект. */
async function drag(el: Element, type: 'dragstart' | 'dragover' | 'drop' | 'dragend'): Promise<void> {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, {
    dataTransfer: {
      effectAllowed: 'move',
      dropEffect: 'move',
      setData: () => {},
      getData: () => '',
    },
  })
  await act(async () => {
    el.dispatchEvent(event)
  })
}

function row(container: HTMLElement, index: number): Element {
  const el = container.querySelector(`[data-testid="queue-item-${index}"]`)
  expect(el).not.toBeNull()
  return el!
}

beforeEach(() => {
  device.isTouch = false
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

describe('QueuePanel — DnD-переупорядочивание', () => {
  it('перетаскивание первой строки на третью → новый порядок id', async () => {
    const onReorder = vi.fn<(ids: string[]) => void>()
    const container = await renderPanel({ onReorder })

    await drag(row(container, 0), 'dragstart')
    await drag(row(container, 2), 'dragover')
    await drag(row(container, 2), 'drop')

    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a'])
  })

  it('перетаскивание последней строки на первую → порядок сдвигается вверх', async () => {
    const onReorder = vi.fn<(ids: string[]) => void>()
    const container = await renderPanel({ onReorder })

    await drag(row(container, 2), 'dragstart')
    await drag(row(container, 0), 'dragover')
    await drag(row(container, 0), 'drop')

    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b'])
  })

  it('сброс на ту же строку — перестановки нет', async () => {
    const onReorder = vi.fn<(ids: string[]) => void>()
    const container = await renderPanel({ onReorder })

    await drag(row(container, 1), 'dragstart')
    await drag(row(container, 1), 'drop')

    expect(onReorder).not.toHaveBeenCalled()
  })

  it('без обработчика перетаскивание выключено (draggable=false)', async () => {
    const container = await renderPanel()

    expect(row(container, 0).getAttribute('draggable')).not.toBe('true')
  })

  it('на тач-указателе DnD выключен', async () => {
    device.isTouch = true
    const onReorder = vi.fn<(ids: string[]) => void>()
    const container = await renderPanel({ onReorder })

    expect(row(container, 0).getAttribute('draggable')).not.toBe('true')

    await drag(row(container, 0), 'dragstart')
    await drag(row(container, 2), 'drop')
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('есть строка без серверного id — перестановка недоступна', async () => {
    const container = await renderPanel({
      pending: [{ id: 'a', content: 'A' }, { content: 'без id' }, { id: 'c', content: 'C' }],
      onReorder: () => {},
    })

    expect(row(container, 0).getAttribute('draggable')).not.toBe('true')
  })

  it('есть неподтверждённая (`sending`) строка — перестановка недоступна', async () => {
    const container = await renderPanel({
      pending: [{ id: 'a', content: 'A', sending: true }, { id: 'b', content: 'B' }],
      onReorder: () => {},
    })

    expect(row(container, 0).getAttribute('draggable')).not.toBe('true')
  })

  it('визуальный индикатор места вставки — на строке-цели во время перетаскивания', async () => {
    const container = await renderPanel({ onReorder: () => {} })

    await drag(row(container, 0), 'dragstart')
    await drag(row(container, 2), 'dragover')

    expect(row(container, 2).getAttribute('data-drop-target')).toBe('true')
    expect(row(container, 1).getAttribute('data-drop-target')).toBeNull()

    await drag(row(container, 2), 'dragend')
    expect(row(container, 2).getAttribute('data-drop-target')).toBeNull()
  })
})
