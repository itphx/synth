import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { ToastContainer, toast } from 'react-toastify'

import type { ToastPlacement } from './useToastPlacement'

/**
 * Контракт рантайм-переключения позиции (на нём держится реактивность
 * `useToastPlacement` в `App.tsx`): смена пропа `position` у `ToastContainer`
 * **не** пересоздаёт узел контейнера и **не** теряет уже показанные тосты.
 * react-toastify запоминает позицию в пропсах тоста в момент создания и
 * группирует вывод по ней, поэтому старый тост доигрывает на прежнем месте,
 * а новые появляются на новом. Если поведение библиотеки изменится (мажор),
 * тест упадёт — и тогда смену позиции придётся делать через пересоздание
 * контейнера с `key`, сознательно теряя открытые тосты.
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ host: HTMLElement; root: Root }> = []

async function render(placement: ToastPlacement): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(<ToastContainer position={placement} />)
  })
  return host
}

async function rerender(host: HTMLElement, placement: ToastPlacement): Promise<void> {
  const entry = mounted.find((m) => m.host === host)!
  await act(async () => {
    entry.root.render(<ToastContainer position={placement} />)
  })
}

function toasts(host: HTMLElement): Element[] {
  return [...host.querySelectorAll('.Toastify__toast')]
}

function container(host: HTMLElement, placement: ToastPlacement): Element | null {
  return host.querySelector(`.Toastify__toast-container--${placement}`)
}

afterEach(async () => {
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

describe('смена позиции тостов в рантайме', () => {
  it('не теряет открытый тост, а новые показывает уже на новой позиции', async () => {
    const host = await render('bottom-right')
    await act(async () => {
      toast.success('до смены')
    })
    expect(container(host, 'bottom-right')?.querySelectorAll('.Toastify__toast')).toHaveLength(1)

    // Телефон: ресайз/поворот — позиция переключилась.
    await rerender(host, 'top-center')

    // Открытый тост не потерян и доигрывает на прежнем месте.
    expect(toasts(host)).toHaveLength(1)
    expect(container(host, 'bottom-right')?.querySelectorAll('.Toastify__toast')).toHaveLength(1)

    // Новый тост идёт в верхний контейнер.
    await act(async () => {
      toast.success('после смены')
    })
    expect(container(host, 'top-center')?.querySelectorAll('.Toastify__toast')).toHaveLength(1)
    expect(toasts(host)).toHaveLength(2)
  })
})
