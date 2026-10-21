/**
 * Адаптер «спецификация ↔ граф» визуального редактора пайплайнов
 * (ADR-101, Э7.2).
 *
 * IR — `PipelineSpec` (`@itphx/synth-shared/types`, контракт Э1) — источник
 * истины; граф — узлы/рёбра `@xyflow/react`. Модуль **чистый**: без React, без
 * состояния и без i18n, поэтому тестируется обычными юнит-тестами.
 *
 * ## Семантика рёбер (совпадает с планировщиком)
 *
 * Планировщик (`packages/core/src/engine/pipelines/planner.ts`) выбирает
 * следующий узел так:
 *
 * 1. узел **с** `on` — переходы проверяются по порядку, берётся первое
 *    выполненное условие (остальные не проверяются); если ни одно не
 *    выполнено — перехода нет;
 * 2. узел **без** `on` — неявный линейный переход к следующему по порядку
 *    узлу `spec.nodes`; последний узел — перехода нет.
 *
 * Чтобы «картинка совпадала с поведением», граф содержит:
 *
 * - **условные рёбра** — по одному на каждый переход `node.on[i]` (явные);
 * - **линейное ребро** — у узла без переходов, к следующему по порядку узлу
 *   (неявное; в спецификации его нет — он выводится из порядка узлов).
 *
 * ## Где живут переходы
 *
 * Переходы — **в рёбрах**: `edge.data.when` (условие) и `edge.target` (цель).
 * В данных узла спецификации ключ `on` **не хранится** (кроме пустого
 * массива — он остаётся маркером, чтобы round-trip был точным), поэтому
 * источник истины один: ребро. `flowToSpec` собирает `on` обратно из рёбер,
 * `specToFlow` — разбирает `on` в рёбра.
 *
 * Идентификаторы рёбер детерминированы (`cond:<узел>:<индекс>` /
 * `linear:<узел>`) — по ним редактор узнаёт, какой переход удалили, и
 * восстанавливает порядок проверки условий.
 */
import type { Edge, Node } from '@xyflow/react'
import type {
  PipelineCondition,
  PipelineConditionOp,
  PipelineNode,
  PipelineNodeKind,
  PipelineSpec,
  PipelineTransition,
} from '@itphx/synth-shared/types'

// ─────────────── Типы графа ───────────────

/** Данные узла графа. */
export type PipelineFlowNodeData = {
  /** Спецификация узла (без ключа `on` — переходы живут в рёбрах). */
  node: PipelineNode
  /** Порядковый номер узла в `spec.nodes` — линейная цепочка планировщика. */
  order: number
}

/** Данные условного ребра (явный переход `on`). */
export type PipelineConditionEdgeData = {
  kind: 'condition'
  /** Условие перехода. */
  when: PipelineCondition
  /** Индекс перехода в `on` исходного узла — порядок проверки условий. */
  order: number
}

/** Данные линейного ребра (неявный переход к следующему по порядку узлу). */
export type PipelineLinearEdgeData = {
  kind: 'linear'
}

/** Данные ребра графа. */
export type PipelineFlowEdgeData = PipelineConditionEdgeData | PipelineLinearEdgeData

/** Узел графа редактора. */
export type PipelineFlowNode = Node<PipelineFlowNodeData, PipelineNodeKind>

/** Ребро с обязательными данными (в React Flow `data` опционален). */
type EdgeWithData<EdgeData extends Record<string, unknown>> = Omit<
  Edge<EdgeData>,
  'data'
> & { data: EdgeData }

/** Условное ребро графа. */
export type PipelineConditionEdge = EdgeWithData<PipelineConditionEdgeData>

/** Линейное ребро графа. */
export type PipelineLinearEdge = EdgeWithData<PipelineLinearEdgeData>

/** Ребро графа редактора. */
export type PipelineFlowEdge = PipelineConditionEdge | PipelineLinearEdge

/** Ребро — условный переход (сужение типа для `data.when`/`data.order`). */
export function isConditionEdge(edge: PipelineFlowEdge): edge is PipelineConditionEdge {
  return edge.data?.kind === 'condition'
}

/** Граф редактора: узлы и рёбра. */
export interface PipelineFlow {
  nodes: PipelineFlowNode[]
  edges: PipelineFlowEdge[]
}

// ─────────────── Константы разметки ───────────────

/** Ширина карточки узла (px) — для расчёта позиций и подсказок инспектора. */
export const PIPELINE_NODE_WIDTH = 240
/** Высота карточки узла (px). */
export const PIPELINE_NODE_HEIGHT = 76
/** Вертикальный зазор между узлами (px). */
export const PIPELINE_NODE_GAP_Y = 56
/** Горизонтальное смещение цепочки (px). */
export const PIPELINE_NODE_X = 40

/** Виды узлов спецификации, которые рисует редактор. */
export const PIPELINE_NODE_KINDS: readonly PipelineNodeKind[] = ['agent', 'script', 'tool', 'human']

// ─────────────── Идентификаторы рёбер ───────────────

/** Идентификатор условного ребра (переход `on` с номером `order`). */
export function conditionEdgeId(sourceId: string, order: number): string {
  return `cond:${sourceId}:${order}`
}

/** Идентификатор линейного (неявного) ребра. */
export function linearEdgeId(sourceId: string): string {
  return `linear:${sourceId}`
}

// ─────────────── Подписи условий ───────────────

/**
 * Символы операторов — **языконезависимые**, поэтому подпись ребра читается
 * в любой локали (названия операторов для выпадающего списка инспектора —
 * отдельные i18n-ключи).
 */
const OP_SYMBOLS: Record<PipelineConditionOp, string> = {
  eq: '=',
  ne: '≠',
  in: '∈',
  exists: '?',
  gt: '>',
  lt: '<',
}

/** Скалярное значение условия → строка для подписи. */
function formatScalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value) ?? String(value)
}

/**
 * Подпись условия перехода — `path op value` (например `prev.output.status = ok`).
 * Для `exists` значение не выводится; массив — через запятую.
 */
export function formatConditionLabel(when: PipelineCondition): string {
  const symbol = OP_SYMBOLS[when.op] ?? when.op
  if (when.op === 'exists' || when.value === undefined) {
    return `${when.path} ${symbol}`
  }
  const value = Array.isArray(when.value)
    ? when.value.map(formatScalar).join(', ')
    : formatScalar(when.value)
  return `${when.path} ${symbol} ${value}`
}

// ─────────────── Порядок узлов ───────────────

/**
 * Узлы в порядке спецификации (по `data.order`; при равенстве — порядок
 * массива). Порядок задаёт неявную линейную цепочку планировщика, поэтому
 * он часть IR, а не оформления.
 */
export function orderNodes(nodes: PipelineFlowNode[]): PipelineFlowNode[] {
  return [...nodes].sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0))
}

/**
 * Перенумеровать узлы подряд (`0..n-1`) — после удаления/перестановки узла.
 */
export function compactOrders(nodes: PipelineFlowNode[]): PipelineFlowNode[] {
  return orderNodes(nodes).map((node, index) => ({
    ...node,
    data: { ...node.data, order: index },
  }))
}

// ─────────────── Spec → Flow ───────────────

/** Позиция узла в сетке: вертикальная цепочка (как список шагов). */
function layoutPosition(index: number): { x: number; y: number } {
  return { x: PIPELINE_NODE_X, y: index * (PIPELINE_NODE_HEIGHT + PIPELINE_NODE_GAP_Y) }
}

/**
 * Узел спецификации → узел графа.
 *
 * Ключ `on` из данных узла убирается: переходы хранятся в рёбрах. Пустой
 * массив `on` сохраняется как маркер — иначе round-trip теряет сам факт его
 * наличия (для точного воспроизведения спецификации).
 */
function toFlowNode(node: PipelineNode, order: number): PipelineFlowNode {
  const { on, ...rest } = node
  const spec = on && on.length > 0 ? rest : on ? { ...rest, on } : rest
  return {
    id: node.id,
    type: node.kind,
    position: layoutPosition(order),
    data: { node: spec, order },
  }
}

/** Условное ребро — явный переход `on`. */
function conditionEdge(
  sourceId: string,
  order: number,
  when: PipelineCondition,
  targetId: string,
): PipelineFlowEdge {
  return {
    id: conditionEdgeId(sourceId, order),
    source: sourceId,
    target: targetId,
    type: 'smoothstep',
    label: formatConditionLabel(when),
    data: { kind: 'condition', when, order },
  }
}

/** Линейное ребро — неявный переход к следующему по порядку узлу. */
function linearEdge(sourceId: string, targetId: string): PipelineFlowEdge {
  return {
    id: linearEdgeId(sourceId),
    source: sourceId,
    target: targetId,
    type: 'smoothstep',
    style: { strokeDasharray: '4 4' },
    data: { kind: 'linear' },
  }
}

/**
 * Пересобрать рёбра по узлам: условные — из переходов (`conditionEdges`),
 * линейные — по порядку узлов (у узла **без** переходов).
 */
export function buildEdges(
  nodes: PipelineFlowNode[],
  conditionEdges: PipelineFlowEdge[],
): PipelineFlowEdge[] {
  const ordered = orderNodes(nodes)
  const edges: PipelineFlowEdge[] = []
  ordered.forEach((node, index) => {
    const own = conditionEdges
      .filter(
        (edge): edge is PipelineConditionEdge =>
          edge.source === node.id && isConditionEdge(edge),
      )
      .sort((a, b) => a.data.order - b.data.order)
    edges.push(...own)
    // Линейное ребро — только у узла без явных переходов (правило 2 планировщика).
    const next = ordered[index + 1]
    if (own.length === 0 && next) {
      edges.push(linearEdge(node.id, next.id))
    }
  })
  return edges
}

/**
 * Спецификация → граф: узлы (по порядку `spec.nodes`) и рёбра (условные по
 * `on`, линейные — по порядку узлов).
 */
export function specToFlow(spec: PipelineSpec): PipelineFlow {
  const specNodes = Array.isArray(spec?.nodes) ? spec.nodes : []
  const nodes = specNodes.map((node, index) => toFlowNode(node, index))

  const conditionEdges: PipelineFlowEdge[] = []
  for (const node of specNodes) {
    const transitions = Array.isArray(node?.on) ? node.on : []
    transitions.forEach((transition, index) => {
      if (!transition?.then || !transition?.when) return
      conditionEdges.push(
        conditionEdge(node.id, index, transition.when, transition.then),
      )
    })
  }

  return { nodes, edges: buildEdges(nodes, conditionEdges) }
}

// ─────────────── Flow → Spec ───────────────

/** Переходы по узлам-источникам: из условных рёбер, в порядке `order`. */
function collectTransitions(edges: PipelineFlowEdge[]): Map<string, PipelineTransition[]> {
  const bySource = new Map<string, Array<{ order: number; transition: PipelineTransition }>>()
  for (const edge of edges) {
    if (!isConditionEdge(edge)) continue
    const when = edge.data.when
    if (!when || !edge.target) continue
    const list = bySource.get(edge.source) ?? []
    list.push({ order: edge.data.order, transition: { when, then: edge.target } })
    bySource.set(edge.source, list)
  }
  const result = new Map<string, PipelineTransition[]>()
  for (const [source, list] of bySource) {
    result.set(
      source,
      list.sort((a, b) => a.order - b.order).map((item) => item.transition),
    )
  }
  return result
}

/**
 * Граф → спецификация: узлы (в порядке `data.order`) с переходами, собранными
 * из рёбер; остальные поля берутся из `base` (метаданные, режим, выходы,
 * переменные, границы).
 *
 * Round-trip `spec → flow → spec` даёт эквивалентную спецификацию: порядок
 * узлов, вид узлов, поля, переходы `on` и выходы сохраняются.
 */
export function flowToSpec(
  nodes: PipelineFlowNode[],
  edges: PipelineFlowEdge[],
  base: PipelineSpec,
): PipelineSpec {
  const transitions = collectTransitions(edges)
  const specNodes = orderNodes(nodes).map((flowNode) => {
    const node = { ...(flowNode.data?.node ?? ({ id: flowNode.id, kind: 'agent' } as PipelineNode)) }
    const own = transitions.get(flowNode.id) ?? []
    // Ключ `on` в данных узла — только маркер пустого массива; настоящие
    // переходы приходят из рёбер.
    const hadOn = Array.isArray(node.on)
    delete node.on
    if (own.length > 0) return { ...node, on: own }
    if (hadOn) return { ...node, on: [] }
    return node
  })
  return { ...base, nodes: specNodes }
}

// ─────────────── Изменение графа ───────────────

/** Уникальный идентификатор нового узла (`node-1`, `node-2`, …). */
export function nextNodeId(existingIds: Iterable<string>): string {
  const used = new Set(existingIds)
  let index = 1
  while (used.has(`node-${index}`)) index += 1
  return `node-${index}`
}

/**
 * Новый узел заданного вида — с пустыми полями (пользователь заполняет их в
 * инспекторе) и в конце цепочки.
 */
export function createFlowNode(
  kind: PipelineNodeKind,
  id: string,
  order: number,
  position?: { x: number; y: number },
): PipelineFlowNode {
  const node: PipelineNode = { id, kind }
  return {
    id,
    type: kind,
    position: position ?? layoutPosition(order),
    data: { node, order },
  }
}

/** Заменить спецификацию узла (по id), сохранив порядок и позицию. */
export function updateFlowNode(
  nodes: PipelineFlowNode[],
  id: string,
  patch: Partial<PipelineNode>,
): PipelineFlowNode[] {
  return nodes.map((node) =>
    node.id === id
      ? { ...node, data: { ...node.data, node: { ...node.data.node, ...patch } } }
      : node,
  )
}

/** Удалить узел вместе с его рёбрами (входящими и исходящими). */
export function removeFlowNode(
  nodes: PipelineFlowNode[],
  edges: PipelineFlowEdge[],
  id: string,
): { nodes: PipelineFlowNode[]; edges: PipelineFlowEdge[] } {
  const rest = nodes.filter((node) => node.id !== id)
  const keptEdges = edges.filter((edge) => edge.source !== id && edge.target !== id)
  return { nodes: compactOrders(rest), edges: buildEdges(compactOrders(rest), keptEdges) }
}

/** Переставить узел в цепочке (сдвиг на ±1 по порядку). */
export function moveFlowNode(
  nodes: PipelineFlowNode[],
  id: string,
  delta: number,
): PipelineFlowNode[] {
  const ordered = orderNodes(nodes)
  const index = ordered.findIndex((node) => node.id === id)
  if (index === -1) return nodes
  const target = index + delta
  if (target < 0 || target >= ordered.length) return nodes
  const next = [...ordered]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  return next.map((node, order) => ({ ...node, data: { ...node.data, order } }))
}

/** Условные рёбра графа (переходы `on`). */
export function conditionEdges(edges: PipelineFlowEdge[]): PipelineConditionEdge[] {
  return edges.filter((edge): edge is PipelineConditionEdge => isConditionEdge(edge))
}
