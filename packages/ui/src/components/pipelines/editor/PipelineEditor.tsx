import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react'

import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import type { PipelineCondition, PipelineNodeKind, PipelineSpec } from '@itphx/synth-shared/types'

import {
  buildEdges,
  compactOrders,
  conditionEdgeId,
  conditionEdges,
  createFlowNode,
  flowToSpec,
  formatConditionLabel,
  nextNodeId,
  orderNodes,
  specToFlow,
  type PipelineConditionEdge,
  type PipelineFlow,
  type PipelineFlowEdge,
  type PipelineFlowNode,
} from './graph-adapter'
import { NodeInspector, type InspectorTransition } from './NodeInspector'
import { PipelineNodeCard, nodeKindIcon } from './PipelineNodeCard'

/**
 * Тема React Flow под тёмную тему приложения.
 *
 * Переменные — **самой библиотеки** (`--xy-*`), значения — только
 * CSS-переменные приложения; новых дизайн-токенов не заводим.
 */
const FLOW_STYLE = {
  '--xy-background-color': 'var(--background)',
  '--xy-edge-stroke': 'var(--border)',
  '--xy-edge-stroke-selected': 'var(--primary)',
  '--xy-connectionline-stroke': 'var(--primary)',
  '--xy-handle-background-color': 'var(--muted-foreground)',
  '--xy-handle-border-color': 'var(--background)',
  '--xy-node-background-color': 'var(--card)',
  '--xy-node-border-color': 'var(--border)',
  '--xy-node-text-color': 'var(--foreground)',
  '--xy-attribution-background-color': 'transparent',
  '--xy-controls-button-background-color': 'var(--card)',
  '--xy-controls-button-background-color-hover': 'var(--interactive-hover)',
  '--xy-controls-button-color': 'var(--foreground)',
  '--xy-controls-button-border-color': 'var(--border)',
} as unknown as React.CSSProperties

/** Типы узлов графа: все виды шага рисует одна карточка. */
const NODE_TYPES: NodeTypes = {
  agent: PipelineNodeCard,
  script: PipelineNodeCard,
  tool: PipelineNodeCard,
  human: PipelineNodeCard,
}

/** Условие по умолчанию для нового перехода (пример из документации). */
const DEFAULT_CONDITION: PipelineCondition = {
  path: 'prev.output.status',
  op: 'eq',
  value: 'ok',
}

/**
 * Визуальный редактор пайплайна — «кубики» на канвасе React Flow
 * (ADR-101, Э7.2).
 *
 * Слева — палитра видов шага (agent/script/tool/human), по центру — граф,
 * справа — инспектор выбранного шага (поля по виду + переходы `on`).
 *
 * Спецификация — источник истины: граф редактируется, а наружу отдаётся
 * спецификация (`flowToSpec`), которую сохраняет страница пайплайна.
 */
export function PipelineEditor({
  spec,
  resetKey,
  onChange,
  readOnly,
}: {
  spec: PipelineSpec
  /** Ключ пересоздания состояния (сервер отдал другой черновик). */
  resetKey?: string
  /** Новая спецификация после изменения графа. */
  onChange: (spec: PipelineSpec) => void
  /** Только чтение (нет прав на правку). */
  readOnly?: boolean
}) {
  const { t } = useI18n()
  const [graph, setGraph] = useState<PipelineFlow>(() => specToFlow(spec))
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Актуальные значения для обработчиков (не зависят от цикла рендера).
  const specRef = useRef(spec)
  specRef.current = spec
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Смена черновика на сервере — пересобрать граф.
  useEffect(() => {
    setGraph(specToFlow(specRef.current))
    setSelectedId(null)
  }, [resetKey])

  // Отдаём наружу спецификацию при каждом изменении графа.
  useEffect(() => {
    onChangeRef.current(flowToSpec(graph.nodes, graph.edges, specRef.current))
  }, [graph])

  const selected = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  )

  /** Переходы выбранного узла (из рёбер, в порядке проверки условий). */
  const transitions = useMemo<InspectorTransition[]>(() => {
    if (!selectedId) return []
    return conditionEdges(graph.edges)
      .filter((edge) => edge.source === selectedId)
      .sort((a, b) => a.data.order - b.data.order)
      .map((edge) => ({
        id: edge.id,
        when: edge.data.when,
        then: edge.target,
      }))
  }, [graph.edges, selectedId])

  /** Узлы-цели переходов (кроме самого себя — петля почти всегда ошибка). */
  const targets = useMemo(
    () =>
      graph.nodes
        .filter((node) => node.id !== selectedId)
        .map((node) => ({ id: node.id, label: node.data.node.title || node.id })),
    [graph.nodes, selectedId],
  )

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setGraph((prev) => {
      const nodes = applyNodeChanges<PipelineFlowNode>(
        changes as NodeChange<PipelineFlowNode>[],
        prev.nodes,
      )
      const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
      if (removed.length === 0) return { ...prev, nodes }
      const kept = prev.edges.filter(
        (edge) => !removed.includes(edge.source) && !removed.includes(edge.target),
      )
      const compacted = compactOrders(nodes)
      return { nodes: compacted, edges: buildEdges(compacted, kept) }
    })
  }, [])

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    setGraph((prev) => {
      const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
      const withoutRemoved = removed.length
        ? prev.edges.filter((edge) => !removed.includes(edge.id))
        : prev.edges
      const edges = applyEdgeChanges<PipelineFlowEdge>(
        changes.filter((change) => change.type !== 'remove') as EdgeChange<PipelineFlowEdge>[],
        withoutRemoved,
      )
      return { ...prev, edges: buildEdges(prev.nodes, edges) }
    })
  }, [])

  /** Новое ребро — явный условный переход с условием по умолчанию. */
  const handleConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return
    setGraph((prev) => {
      const source = prev.nodes.find((node) => node.id === connection.source)
      if (!source) return prev
      const own = conditionEdges(prev.edges).filter((edge) => edge.source === connection.source)
      const order = own.reduce((max, edge) => Math.max(max, edge.data.order + 1), 0)
      const edge: PipelineConditionEdge = {
        id: conditionEdgeId(connection.source, order),
        source: connection.source,
        target: connection.target,
        type: 'smoothstep',
        label: formatConditionLabel(DEFAULT_CONDITION),
        data: { kind: 'condition', when: DEFAULT_CONDITION, order },
      }
      return { ...prev, edges: buildEdges(prev.nodes, [...prev.edges, edge]) }
    })
  }, [])

  /** Добавить шаг выбранного вида в конец цепочки. */
  const addNode = useCallback((kind: PipelineNodeKind) => {
    setGraph((prev) => {
      const id = nextNodeId(prev.nodes.map((node) => node.id))
      const node = createFlowNode(kind, id, prev.nodes.length)
      const nodes = [...prev.nodes, node]
      setSelectedId(id)
      return { nodes, edges: buildEdges(nodes, prev.edges) }
    })
  }, [])

  /** Удалить шаг (инспектор вызывает после подтверждения). */
  const removeNode = useCallback((id: string) => {
    setGraph((prev) => {
      const nodes = compactOrders(prev.nodes.filter((node) => node.id !== id))
      const edges = prev.edges.filter((edge) => edge.source !== id && edge.target !== id)
      setSelectedId((current) => (current === id ? null : current))
      return { nodes, edges: buildEdges(nodes, edges) }
    })
  }, [])

  /** Переставить шаг в цепочке (сдвиг на ±1). */
  const moveNode = useCallback((id: string, delta: number) => {
    setGraph((prev) => {
      const ordered = orderNodes(prev.nodes)
      const index = ordered.findIndex((node) => node.id === id)
      const target = index + delta
      if (index === -1 || target < 0 || target >= ordered.length) return prev
      const next = [...ordered]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      const nodes = next.map((node, order) => ({ ...node, data: { ...node.data, order } }))
      return { ...prev, nodes, edges: buildEdges(nodes, prev.edges) }
    })
  }, [])

  /** Правка полей шага. */
  const changeNode = useCallback((id: string, patch: Partial<PipelineFlowNode['data']['node']>) => {
    setGraph((prev) => ({
      ...prev,
      nodes: prev.nodes.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, node: { ...node.data.node, ...patch } } }
          : node,
      ),
    }))
  }, [])

  /** Правка перехода (условие/цель) — обновляем ребро и его подпись. */
  const changeTransition = useCallback(
    (id: string, patch: { when?: PipelineCondition; then?: string }) => {
      setGraph((prev) => {
        const edges = prev.edges.map((edge) => {
          if (edge.id !== id || edge.data?.kind !== 'condition') return edge
          const when = patch.when ?? edge.data.when
          return {
            ...edge,
            target: patch.then ?? edge.target,
            label: formatConditionLabel(when),
            data: { ...edge.data, when },
          }
        })
        return { ...prev, edges: buildEdges(prev.nodes, edges) }
      })
    },
    [],
  )

  /** Новый переход из выбранного шага — в конец списка переходов. */
  const addTransition = useCallback(() => {
    if (!selectedId) return
    setGraph((prev) => {
      const own = conditionEdges(prev.edges).filter((edge) => edge.source === selectedId)
      const order = own.reduce((max, edge) => Math.max(max, edge.data.order + 1), 0)
      const target = prev.nodes.find((node) => node.id !== selectedId)
      if (!target) return prev
      const edge: PipelineConditionEdge = {
        id: conditionEdgeId(selectedId, order),
        source: selectedId,
        target: target.id,
        type: 'smoothstep',
        label: formatConditionLabel(DEFAULT_CONDITION),
        data: { kind: 'condition', when: DEFAULT_CONDITION, order },
      }
      return { ...prev, edges: buildEdges(prev.nodes, [...prev.edges, edge]) }
    })
  }, [selectedId])

  /** Удалить переход (ребро). */
  const removeTransition = useCallback((id: string) => {
    setGraph((prev) => {
      const edges = prev.edges.filter((edge) => edge.id !== id)
      return { ...prev, edges: buildEdges(prev.nodes, edges) }
    })
  }, [])

  const orderedNodes = useMemo(() => orderNodes(graph.nodes), [graph.nodes])
  const selectedIndex = orderedNodes.findIndex((node) => node.id === selectedId)

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
      <div className="relative min-h-[24rem] min-w-0 flex-1">
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable
          deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
          fitView
          minZoom={0.2}
          maxZoom={2}
          style={FLOW_STYLE}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>

        <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1">
          <div className="pointer-events-auto flex flex-col gap-1 rounded-lg border border-border bg-card/95 p-2 shadow-sm">
            <span className="px-1 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('pipelines.editor.palette')}
            </span>
            {(['agent', 'script', 'tool', 'human'] as PipelineNodeKind[]).map((kind) => (
              <Button
                key={kind}
                variant="ghost"
                size="sm"
                disabled={readOnly}
                data-action={`add-node-${kind}`}
                onClick={() => addNode(kind)}
                className="justify-start"
              >
                <Icon name={nodeKindIcon(kind)} className="h-3.5 w-3.5 text-primary" />
                {t(`pipelines.editor.kind.${kind}`)}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <aside
        data-testid="pipeline-inspector"
        className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border"
      >
        {selected ? (
          <NodeInspector
            node={selected.data.node}
            transitions={transitions}
            targets={targets}
            readOnly={readOnly}
            canMoveUp={selectedIndex > 0}
            canMoveDown={selectedIndex >= 0 && selectedIndex < orderedNodes.length - 1}
            onChangeNode={(patch) => changeNode(selected.id, patch)}
            onChangeTransition={changeTransition}
            onAddTransition={addTransition}
            onRemoveTransition={removeTransition}
            onRemoveNode={() => removeNode(selected.id)}
            onMoveNode={(delta) => moveNode(selected.id, delta)}
          />
        ) : (
          <div className="flex flex-col gap-2 p-3">
            <h4 className="text-sm font-medium text-foreground">
              {t('pipelines.editor.inspector')}
            </h4>
            <p className="text-xs text-muted-foreground">
              {graph.nodes.length === 0
                ? t('pipelines.editor.emptyGraph')
                : t('pipelines.editor.noSelection')}
            </p>
            <p className="text-xs text-muted-foreground">{t('pipelines.editor.exitsHint')}</p>
          </div>
        )}
      </aside>
    </div>
  )
}
