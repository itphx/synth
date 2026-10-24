import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { MemoryGraphCanvas } from './MemoryGraphCanvas'
import type { MemoryGraph } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/**
 * Граф памяти: две сущности, один факт (упоминает обе) и три связи —
 * «факт → сущность» (mentions) и «сущность ↔ сущность» (co_occurs).
 */
const GRAPH: MemoryGraph = {
  nodes: [
    { id: 'entity:Fleet', kind: 'entity', name: 'Fleet', entity: 'Fleet' },
    { id: 'entity:kubectl', kind: 'entity', name: 'kubectl', entity: 'kubectl' },
    {
      id: 'fact:fact-1',
      kind: 'fact',
      factId: 'fact-1',
      text: 'Деплой в test идёт через Fleet, а не через kubectl.',
    },
  ],
  edges: [
    { from: 'fact:fact-1', to: 'entity:Fleet', relation: 'mentions' },
    { from: 'fact:fact-1', to: 'entity:kubectl', relation: 'mentions' },
    { from: 'entity:Fleet', to: 'entity:kubectl', relation: 'co_occurs' },
  ],
  stats: { entities: 2, facts: 1, edges: 3 },
}

/** Граф без узлов — пустое состояние. */
const EMPTY_GRAPH: MemoryGraph = {
  nodes: [],
  edges: [],
  stats: { entities: 0, facts: 0, edges: 0 },
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

const allByTestId = (container: HTMLElement, testId: string): Element[] => [
  ...container.querySelectorAll(`[data-testid="${testId}"]`),
]

async function flush(): Promise<void> {
  await act(async () => {})
}

/** Клик по элементу: SVG-узлы не имеют `HTMLElement.click()`, шлём событие. */
async function clickElement(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

async function renderCanvas(
  graph: MemoryGraph,
  props: Partial<React.ComponentProps<typeof MemoryGraphCanvas>> = {},
): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <MemoryGraphCanvas graph={graph} onSelectEntity={() => undefined} {...props} />
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  while (roots.length > 0) {
    const entry = roots.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.container.remove()
  }
})

describe('MemoryGraphCanvas — отрисовка графа', () => {
  it('рисует узлы и рёбра по данным графа', async () => {
    const container = await renderCanvas(GRAPH)

    const nodes = allByTestId(container, 'memory-graph-canvas-node')
    expect(nodes).toHaveLength(3)
    expect(nodes.filter((node) => node.getAttribute('data-node-kind') === 'entity')).toHaveLength(2)
    expect(nodes.filter((node) => node.getAttribute('data-node-kind') === 'fact')).toHaveLength(1)

    const edges = allByTestId(container, 'memory-graph-canvas-edge')
    expect(edges).toHaveLength(3)

    // Подпись сущности — короткая, полное имя — в `<title>`.
    const labels = allByTestId(container, 'memory-graph-canvas-label')
    expect(labels.map((label) => label.textContent)).toEqual(['Fleet', 'kubectl'])
    const titles = [...container.querySelectorAll('title')].map((title) => title.textContent)
    expect(titles).toContain('Fleet')
  })

  it('клик по узлу-сущности вызывает onSelectEntity с её именем', async () => {
    const onSelectEntity = vi.fn()
    const container = await renderCanvas(GRAPH, { onSelectEntity })

    const node = container.querySelector('[data-node-id="entity:Fleet"]')
    expect(node).toBeTruthy()
    await clickElement(node as Element)

    expect(onSelectEntity).toHaveBeenCalledTimes(1)
    expect(onSelectEntity).toHaveBeenCalledWith('Fleet')
  })

  it('координаты раскладки детерминированы: два рендера дают одинаковый результат', async () => {
    const first = await renderCanvas(GRAPH)
    const second = await renderCanvas(GRAPH)

    const svgA = byTestId(first, 'memory-graph-canvas-svg')
    const svgB = byTestId(second, 'memory-graph-canvas-svg')
    expect(svgA?.getAttribute('viewBox')).toBe(svgB?.getAttribute('viewBox'))
    expect(svgA?.getAttribute('viewBox')).toBeTruthy()

    const positions = (container: HTMLElement) =>
      allByTestId(container, 'memory-graph-canvas-node').map((node) => {
        const circle = node.querySelector('circle')
        return `${node.getAttribute('data-node-id')}:${circle?.getAttribute('cx')}:${circle?.getAttribute('cy')}`
      })

    const positionsA = positions(first)
    expect(positionsA).toHaveLength(3)
    expect(positionsA).toEqual(positions(second))
  })

  it('пустой граф — компонент ничего не рисует', async () => {
    const container = await renderCanvas(EMPTY_GRAPH)

    expect(byTestId(container, 'memory-graph-canvas')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('связь co_occurs рисуется пунктиром, остальные — сплошной линией', async () => {
    const container = await renderCanvas(GRAPH)

    const edges = allByTestId(container, 'memory-graph-canvas-edge')
    const coOccurs = edges.find(
      (edge) => edge.getAttribute('data-edge-relation') === 'co_occurs',
    )
    const mentions = edges.find(
      (edge) => edge.getAttribute('data-edge-relation') === 'mentions',
    )

    expect(coOccurs?.getAttribute('stroke-dasharray')).toBe('4 3')
    expect(mentions?.getAttribute('stroke-dasharray')).toBeNull()
  })
})
