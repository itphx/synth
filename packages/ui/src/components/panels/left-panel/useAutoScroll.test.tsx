import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { useAutoScroll } from './useAutoScroll'

/**
 * `left-panel/useAutoScroll.ts` (ADR-095) — авто-скролл к активному узлу дерева
 * по `data-tree-node`. Проверяется поиск узла, вызов `scrollIntoView` и
 * безопасность в окружении без `scrollIntoView` (jsdom).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function Host({ targetId, nodeId }: { targetId: string | null; nodeId: string }) {
  useAutoScroll(targetId)
  return <div data-tree-node={nodeId} />
}

async function mount(props: { targetId: string | null; nodeId: string }): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<Host {...props} />)
  })
  return container
}

/** Прокрутить фейковые таймеры на окно авто-скролла (80 мс) внутри act. */
async function flushAutoScroll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useAutoScroll', () => {
  it('скроллит к узлу с совпадающим data-tree-node', async () => {
    const container = await mount({ targetId: 's1', nodeId: 's1' })
    const el = container.querySelector('[data-tree-node="s1"]')!
    const scroll = vi.fn()
    ;(el as unknown as { scrollIntoView: typeof scroll }).scrollIntoView = scroll

    await flushAutoScroll()

    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' })
  })

  it('нет узла с таким id → скролл не вызывается, ошибок нет', async () => {
    const container = await mount({ targetId: 's1', nodeId: 'other' })
    const el = container.querySelector('[data-tree-node="other"]')!
    const scroll = vi.fn()
    ;(el as unknown as { scrollIntoView: typeof scroll }).scrollIntoView = scroll

    await flushAutoScroll()

    expect(scroll).not.toHaveBeenCalled()
  })

  it('targetId=null → ничего не делает', async () => {
    const container = await mount({ targetId: null, nodeId: 's1' })
    const el = container.querySelector('[data-tree-node="s1"]')!
    const scroll = vi.fn()
    ;(el as unknown as { scrollIntoView: typeof scroll }).scrollIntoView = scroll

    await flushAutoScroll()

    expect(scroll).not.toHaveBeenCalled()
  })

  it('узел без scrollIntoView (jsdom) → безопасный выход без ошибок', async () => {
    const container = await mount({ targetId: 's1', nodeId: 's1' })
    const el = container.querySelector('[data-tree-node="s1"]')!
    // jsdom не реализует scrollIntoView — хук обязан это пережить.
    expect(typeof (el as unknown as { scrollIntoView?: unknown }).scrollIntoView).not.toBe('function')

    await expect(flushAutoScroll()).resolves.toBeUndefined()
  })
})

// ВНИМАНИЕ (зафиксированный баг, ADR-095): эффект постановки таймера имеет пустой
// список зависимостей (`[]`), а `targetId` читается из ref. Из-за этого авто-скролл
// срабатывает только для значения, актуального на момент МОНТИРОВАНИЯ хука.
// Смена активного узла без размонтирования вкладки (напр. переключение чат-таба при
// открытой панели Files, либо file-viewer-таба) скролл НЕ запускает.
// Доказательство: `useAutoScroll(targetId)` → `useEffect(..., [])` в `useAutoScroll.ts`.
// Не исправлено в рамках тестовой сессии (неоднозначно: возможен осознанный
// одноразовый скролл; фикс = заменить `[]` на `[targetId]` — требует решения владельца).
it.todo('реагирует на смену targetId после монтирования (текущее поведение: только первичный скролл)')
