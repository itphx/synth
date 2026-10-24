import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { MemoryGraph, MemoryGraphNode } from '@/lib/api/synthApi'

/**
 * ADR-107 / PROP-047: интерактивная SVG-визуализация графа памяти.
 *
 * Холст рисуется **чистым SVG + математикой** — без React Flow, d3 и прочих
 * библиотек: layout считается вручную и полностью детерминирован (одинаковый
 * вход → одинаковые координаты), поэтому граф не «прыгает» при перестроении.
 *
 * Раскладка:
 * - сущности — по окружности (радиус зависит от их количества: чем больше
 *   сущностей, тем шире кольцо, чтобы подписи не наезжали друг на друга);
 * - факты — рядом со своей сущностью (якорь — единственная связанная с фактом
 *   сущность) либо, если такой якорь не единственный, во внутреннем кольце;
 * - рёбра — прямые линии: `co_occurs` пунктиром, остальные — сплошные.
 *
 * Подпись связи рисуется только для инцидентных выбранной/наведённой сущности
 * — иначе граф превращается в кашу.
 */

/** Высота холста (px) — фиксированная, ширина адаптивная. */
const CANVAS_HEIGHT = 320

/** Ширина холста, пока контейнер не измерен (первый рендер, тесты). */
const DEFAULT_CANVAS_WIDTH = 640

/** Минимальная ширина холста — иначе подписи наезжают друг на друга. */
const MIN_CANVAS_WIDTH = 360

/** Радиус узла-сущности (круг темы). */
const ENTITY_RADIUS = 8

/** Радиус узла-факта — заметно меньше сущности. */
const FACT_RADIUS = 4

/** Максимальная длина подписи сущности на холсте. */
const LABEL_MAX = 24

/** Приблизительная ширина одного символа подписи (для оценки переполнения). */
const LABEL_CHAR_WIDTH = 7

/**
 * Размер подписей на холсте — производная от темы (`--text-micro`),
 * чтобы подписи масштабировались вместе с UI и не «отъезжали» от узлов.
 */
const CANVAS_FONT_SIZE = 'calc(var(--text-micro) * 0.78)'

/** Шаг углового разноса фактов вокруг своей сущности (рад). */
const FACT_ANGLE_STEP = 0.42

/** Доля радиуса, на которой стоит факт, привязанный к сущности. */
const FACT_ANCHOR_RATIO = 0.62

/** Доля радиуса внутреннего кольца для «ничьих» фактов. */
const FACT_INNER_RATIO = 0.42

/** Узел графа с вычисленной позицией. */
export interface GraphLayoutNode {
  id: string
  kind: MemoryGraphNode['kind']
  x: number
  y: number
  /** Короткая подпись на холсте (только у сущностей). */
  label: string
  /** Полное имя/текст — уходит в `<title>` (всплывающая подсказка). */
  title: string
  /** Имя сущности — по нему строится фильтр графа. */
  entityName?: string
}

/** Ребро графа с координатами концов. */
export interface GraphLayoutEdge {
  from: string
  to: string
  relation: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Раскладка графа: узлы и рёбра в координатах холста. */
export interface GraphLayout {
  nodes: GraphLayoutNode[]
  edges: GraphLayoutEdge[]
}

/** Пропсы канваса графа памяти. */
export interface MemoryGraphCanvasProps {
  graph: MemoryGraph
  /** Имя выбранной сущности (акцент на её узле и инцидентных рёбрах). */
  selectedEntity?: string
  /** Клик по узлу-сущности — тот же обработчик, что клик по сущности в списке. */
  onSelectEntity: (entity: string) => void
}

/** Сортировка по id — стабильный порядок узлов при одинаковом входе. */
function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Обрезка подписи сущности до LABEL_MAX символов. */
export function truncateGraphLabel(value: string): string {
  const text = value.trim()
  if (text.length <= LABEL_MAX) return text
  return `${text.slice(0, LABEL_MAX)}…`
}

/**
 * Раскладка графа — чистая функция: одинаковый вход → одинаковые координаты.
 *
 * @param width ширина холста в единицах viewBox
 * @param height высота холста в единицах viewBox
 */
export function computeGraphLayout(
  graph: MemoryGraph,
  width: number,
  height: number,
): GraphLayout {
  const byId = new Map<string, MemoryGraphNode>()
  for (const node of graph.nodes) byId.set(node.id, node)

  const entities = sortById(graph.nodes.filter((node) => node.kind === 'entity'))
  const facts = sortById(graph.nodes.filter((node) => node.kind === 'fact'))

  const centerX = width / 2
  const centerY = height / 2
  // Кольцо должно помещаться в холст с запасом на подписи.
  const maxRadiusX = Math.max(0, width / 2 - 72)
  const maxRadiusY = Math.max(0, height / 2 - 48)
  // Радиус кольца зависит от числа сущностей: чем их больше, тем шире кольцо,
  // иначе подписи наезжают друг на друга. Дальше — потолок по холсту.
  const baseRadius =
    entities.length > 1
      ? Math.max(Math.min(40, maxRadiusY), 22 + entities.length * 15)
      : 0
  const radiusY = Math.min(baseRadius, maxRadiusY)
  // По горизонтали кольцо растягивается — в широком контейнере иначе граф
  // сбивается в кучу посреди пустого места.
  const radiusX = Math.min(maxRadiusX, Math.max(radiusY, baseRadius * 2.2))

  const nodes: GraphLayoutNode[] = []
  const positions = new Map<string, GraphLayoutNode>()
  const entityAngle = new Map<string, number>()

  entities.forEach((entity, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / entities.length
    entityAngle.set(entity.id, angle)
    const name = entity.name?.trim() || entity.id
    const node: GraphLayoutNode = {
      id: entity.id,
      kind: 'entity',
      x: centerX + radiusX * Math.cos(angle),
      y: centerY + radiusY * Math.sin(angle),
      label: truncateGraphLabel(name),
      title: name,
      entityName: name,
    }
    positions.set(entity.id, node)
    nodes.push(node)
  })

  // Факт привязывается к сущности, если та связана с ним единственным ребром.
  const owners = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    if (from.kind === 'fact' && to.kind === 'entity') {
      owners.set(from.id, [...(owners.get(from.id) ?? []), to.id])
    } else if (to.kind === 'fact' && from.kind === 'entity') {
      owners.set(to.id, [...(owners.get(to.id) ?? []), from.id])
    }
  }

  const anchored = new Map<string, string[]>()
  const freeFacts: string[] = []
  for (const fact of facts) {
    const list = owners.get(fact.id) ?? []
    if (list.length === 1) {
      anchored.set(list[0]!, [...(anchored.get(list[0]!) ?? []), fact.id])
    } else {
      freeFacts.push(fact.id)
    }
  }

  const innerRadiusX = radiusX > 0 ? radiusX * FACT_INNER_RATIO : Math.min(maxRadiusX, 40)
  const innerRadiusY = radiusY > 0 ? radiusY * FACT_INNER_RATIO : Math.min(maxRadiusY, 40)
  // При единственной сущности кольцо вырождается в точку — факты вокруг неё
  // раскладываем по отдельному радиусу, иначе все сойдутся в центре.
  const anchorRadiusX = radiusX > 0 ? radiusX * FACT_ANCHOR_RATIO : innerRadiusX
  const anchorRadiusY = radiusY > 0 ? radiusY * FACT_ANCHOR_RATIO : innerRadiusY

  // Факты рядом со своей сущностью.
  for (const [entityId, factIds] of anchored) {
    const angle = entityAngle.get(entityId)
    if (angle === undefined) continue
    factIds.forEach((factId, index) => {
      const offset = (index - (factIds.length - 1) / 2) * FACT_ANGLE_STEP
      const fact = byId.get(factId)
      if (!fact) return
      const node: GraphLayoutNode = {
        id: fact.id,
        kind: 'fact',
        x: centerX + anchorRadiusX * Math.cos(angle + offset),
        y: centerY + anchorRadiusY * Math.sin(angle + offset),
        label: '',
        title: fact.text?.trim() || fact.factId || fact.id,
      }
      positions.set(fact.id, node)
      nodes.push(node)
    })
  }

  // Факты без единственного якоря — во внутреннем кольце. Кольцо сдвинуто на
  // полшага относительно сущностей, иначе факты попадают на одну ось с ними.
  const freeFactsOffset = entities.length > 0 ? Math.PI / entities.length : 0
  freeFacts.forEach((factId, index) => {
    const fact = byId.get(factId)
    if (!fact) return
    const angle =
      -Math.PI / 2 + freeFactsOffset + (2 * Math.PI * index) / Math.max(1, freeFacts.length)
    const node: GraphLayoutNode = {
      id: fact.id,
      kind: 'fact',
      x: centerX + innerRadiusX * Math.cos(angle),
      y: centerY + innerRadiusY * Math.sin(angle),
      label: '',
      title: fact.text?.trim() || fact.factId || fact.id,
    }
    positions.set(fact.id, node)
    nodes.push(node)
  })

  const edges: GraphLayoutEdge[] = []
  for (const edge of graph.edges) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (!from || !to) continue
    edges.push({
      from: edge.from,
      to: edge.to,
      relation: edge.relation ?? '',
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
    })
  }

  return { nodes, edges }
}

/** Подпись связи: известные метки переводим, пользовательские — как есть. */
function relationLabel(
  t: (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string,
  relation: string,
): string {
  if (!relation) return t('settings.memory.graph.canvas.relationUnknown')
  if (relation === 'mentions') return t('settings.memory.graph.canvas.relationMentions')
  if (relation === 'co_occurs') return t('settings.memory.graph.canvas.relationCoOccurs')
  return relation
}

/**
 * Ширина контейнера — для viewBox. В тестах/SSR ширина неизвестна, поэтому
 * используется фиксированный запасной размер: раскладка остаётся детерминированной.
 */
function useContainerWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(DEFAULT_CANVAS_WIDTH)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const measure = () => {
      const measured = element.clientWidth || element.getBoundingClientRect().width
      if (measured > 0) setWidth(Math.max(MIN_CANVAS_WIDTH, Math.round(measured)))
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return width
}

/**
 * Канвас графа памяти. Граф без рисуемых узлов или связей → `null`:
 * пустое состояние уже показывает сама секция «Граф».
 */
export function MemoryGraphCanvas({
  graph,
  selectedEntity,
  onSelectEntity,
}: MemoryGraphCanvasProps) {
  const { t } = useI18n()
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const width = useContainerWidth(wrapperRef)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const layout = useMemo(
    () => computeGraphLayout(graph, width, CANVAS_HEIGHT),
    [graph, width],
  )

  const selectedId = useMemo(() => {
    const needle = (selectedEntity ?? '').trim().toLowerCase()
    if (!needle) return null
    const match = layout.nodes.find(
      (node) =>
        node.kind === 'entity' &&
        (node.id.toLowerCase() === needle ||
          (node.entityName ?? '').toLowerCase() === needle),
    )
    return match?.id ?? null
  }, [layout, selectedEntity])

  if (layout.nodes.length === 0 || layout.edges.length === 0) return null

  const entityCount = layout.nodes.filter((node) => node.kind === 'entity').length
  const factCount = layout.nodes.length - entityCount

  return (
    <div
      className="space-y-2 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
      data-testid="memory-graph-canvas"
    >
      <div ref={wrapperRef} className="w-full min-w-0">
        <svg
          viewBox={`0 0 ${width} ${CANVAS_HEIGHT}`}
          width="100%"
          height={CANVAS_HEIGHT}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={t('settings.memory.graph.canvas.ariaLabel', {
            entities: entityCount,
            facts: factCount,
            edges: layout.edges.length,
          })}
          className="block w-full max-w-full select-none"
          data-testid="memory-graph-canvas-svg"
        >
          {/* Рёбра — под узлами. */}
          <g data-testid="memory-graph-canvas-edges">
            {layout.edges.map((edge) => {
              const touchesHover =
                hoveredId !== null && (edge.from === hoveredId || edge.to === hoveredId)
              const touchesSelected =
                selectedId !== null && (edge.from === selectedId || edge.to === selectedId)
              const showLabel = touchesHover || touchesSelected
              const dimmed = hoveredId !== null && !touchesHover
              return (
                <g key={`${edge.from}->${edge.to}:${edge.relation}`}>
                  <line
                    x1={edge.x1}
                    y1={edge.y1}
                    x2={edge.x2}
                    y2={edge.y2}
                    strokeDasharray={edge.relation === 'co_occurs' ? '4 3' : undefined}
                    className={cn(
                      'stroke-border transition-opacity',
                      touchesHover && 'stroke-primary',
                      dimmed && 'opacity-20',
                    )}
                    data-testid="memory-graph-canvas-edge"
                    data-edge-from={edge.from}
                    data-edge-to={edge.to}
                    data-edge-relation={edge.relation}
                  />
                  {showLabel && (
                    <text
                      x={(edge.x1 + edge.x2) / 2}
                      y={(edge.y1 + edge.y2) / 2 - 4}
                      textAnchor="middle"
                      className="fill-muted-foreground"
                      style={{ fontSize: CANVAS_FONT_SIZE }}
                      data-testid="memory-graph-canvas-edge-label"
                    >
                      {relationLabel(t, edge.relation)}
                    </text>
                  )}
                </g>
              )
            })}
          </g>

          {/* Узлы: сущности крупнее и цветом темы, факты мельче. */}
          <g data-testid="memory-graph-canvas-nodes">
            {layout.nodes.map((node) => {
              const isSelected = node.id === selectedId
              const isHovered = node.id === hoveredId
              const isEntity = node.kind === 'entity'
              const halfLabel = (node.label.length * LABEL_CHAR_WIDTH) / 2
              let labelX = node.x
              let labelAnchor: 'start' | 'middle' | 'end' = 'middle'
              if (node.x - halfLabel < 4) {
                labelX = node.x + ENTITY_RADIUS + 5
                labelAnchor = 'start'
              } else if (node.x + halfLabel > width - 4) {
                labelX = node.x - ENTITY_RADIUS - 5
                labelAnchor = 'end'
              }
              return (
                <g
                  key={node.id}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={() => {
                    if (isEntity && node.entityName) onSelectEntity(node.entityName)
                  }}
                  className={cn(isEntity && 'cursor-pointer')}
                  data-testid="memory-graph-canvas-node"
                  data-node-id={node.id}
                  data-node-kind={node.kind}
                  data-selected={isSelected ? 'true' : undefined}
                >
                  <title>{node.title}</title>
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={isEntity ? ENTITY_RADIUS : FACT_RADIUS}
                    className={cn(
                      isEntity ? 'fill-primary' : 'fill-muted-foreground',
                      (isSelected || isHovered) && 'stroke-foreground',
                    )}
                    strokeWidth={isSelected || isHovered ? 2 : 0}
                  />
                  {isEntity && (
                    <text
                      x={labelX}
                      y={node.y + ENTITY_RADIUS + 13}
                      textAnchor={labelAnchor}
                      className={cn('fill-foreground', isSelected && 'fill-primary')}
                      style={{ fontSize: CANVAS_FONT_SIZE }}
                      data-testid="memory-graph-canvas-label"
                    >
                      {node.label}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
          {t('settings.memory.graph.canvas.legendEntity')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-muted-foreground" aria-hidden="true" />
          {t('settings.memory.graph.canvas.legendFact')}
        </span>
        <span className="min-w-0 break-words">
          {t('settings.memory.graph.canvas.hint')}
        </span>
      </div>
    </div>
  )
}
