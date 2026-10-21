import { describe, it, expect } from 'vitest'

import type { PipelineSpec } from '@itphx/synth-shared/types'

import {
  buildEdges,
  conditionEdgeId,
  conditionEdges,
  createFlowNode,
  flowToSpec,
  formatConditionLabel,
  linearEdgeId,
  moveFlowNode,
  nextNodeId,
  orderNodes,
  removeFlowNode,
  specToFlow,
  updateFlowNode,
} from './graph-adapter'

/**
 * Спецификация со всеми видами узлов, условными переходами, переменными,
 * границами и выходами — эталон для round-trip.
 */
const SPEC: PipelineSpec = {
  id: 'pr-pipeline',
  name: 'PR Pipeline',
  description: 'Релизный пайплайн',
  version: 3,
  status: 'draft',
  mode: 'act',
  projectId: 'proj-1',
  io: { input: { type: 'object' } },
  vars: { branch: 'trigger.payload.branch' },
  nodes: [
    {
      id: 'implement',
      kind: 'agent',
      title: 'Правка',
      agent: 'implementer',
      skill: 'code-review',
      prompt: 'Исправь задачу',
      input: ['prev.output.report', 'trigger.payload.issue'],
      timeoutSec: 900,
      retry: { max: 2, backoffSec: 5 },
      on: [
        { when: { path: 'prev.output.status', op: 'eq', value: 'ok' }, then: 'verify' },
        { when: { path: 'prev.output.status', op: 'eq', value: 'failed' }, then: 'fix' },
      ],
    },
    { id: 'verify', kind: 'tool', tool: 'git_status', toolArgs: { path: '.' } },
    { id: 'fix', kind: 'script', command: 'echo repair', args: ['--fast'] },
    { id: 'approve', kind: 'human', prompt: 'Подтверди публикацию', timeoutSec: 86400 },
  ],
  exits: [
    { kind: 'session', session: { agent: 'reporter' } },
    { kind: 'file', file: { path: 'reports/report.md', contentFrom: 'prev.output.report' } },
    { kind: 'gateway', gateway: { event: 'pipeline.completed' } },
    { kind: 'none' },
  ],
}

describe('graph-adapter: спецификация → граф', () => {
  it('узлы спецификации становятся узлами графа в том же порядке', () => {
    const { nodes } = specToFlow(SPEC)

    expect(nodes.map((node) => node.id)).toEqual(['implement', 'verify', 'fix', 'approve'])
    expect(nodes.map((node) => node.type)).toEqual(['agent', 'tool', 'script', 'human'])
    expect(nodes.map((node) => node.data.order)).toEqual([0, 1, 2, 3])
  })

  it('условные переходы становятся рёбрами с подписью условия', () => {
    const { edges } = specToFlow(SPEC)

    const conditions = conditionEdges(edges)
    expect(conditions).toHaveLength(2)
    expect(conditions[0]?.id).toBe(conditionEdgeId('implement', 0))
    expect(conditions[0]?.source).toBe('implement')
    expect(conditions[0]?.target).toBe('verify')
    expect(conditions[0]?.label).toBe('prev.output.status = ok')
    expect(conditions[1]?.target).toBe('fix')
  })

  it('линейное ребро есть только у узла без переходов и ведёт к следующему узлу', () => {
    const { edges } = specToFlow(SPEC)

    // У «implement» есть `on` — линейного ребра нет (правило 2 планировщика).
    expect(edges.some((edge) => edge.id === linearEdgeId('implement'))).toBe(false)
    // «verify» без переходов — линейное ребро в «fix».
    expect(edges.some((edge) => edge.id === linearEdgeId('verify'))).toBe(true)
    expect(edges.find((edge) => edge.id === linearEdgeId('verify'))?.target).toBe('fix')
    // «fix» без переходов — линейное ребро в «approve».
    expect(edges.find((edge) => edge.id === linearEdgeId('fix'))?.target).toBe('approve')
    // Последний узел — без ребра.
    expect(edges.some((edge) => edge.source === 'approve')).toBe(false)
  })

  it('данные узла не дублируют переходы (источник истины — ребро)', () => {
    const { nodes } = specToFlow(SPEC)
    const implement = nodes.find((node) => node.id === 'implement')

    expect(implement?.data.node.on).toBeUndefined()
    expect(implement?.data.node.agent).toBe('implementer')
    expect(implement?.data.node.retry).toEqual({ max: 2, backoffSec: 5 })
  })
})

describe('graph-adapter: граф → спецификация', () => {
  it('round-trip без потерь: узлы, переходы, выходы и метаданные', () => {
    const flow = specToFlow(SPEC)
    const restored = flowToSpec(flow.nodes, flow.edges, SPEC)

    expect(restored).toEqual(SPEC)
  })

  it('round-trip сохраняет порядок узлов', () => {
    const flow = specToFlow(SPEC)
    const restored = flowToSpec(flow.nodes, flow.edges, SPEC)

    expect(restored.nodes.map((node) => node.id)).toEqual([
      'implement',
      'verify',
      'fix',
      'approve',
    ])
  })

  it('round-trip восстанавливает переходы `on` в исходном порядке', () => {
    const flow = specToFlow(SPEC)
    const restored = flowToSpec(flow.nodes, flow.edges, SPEC)

    expect(restored.nodes[0]?.on).toEqual([
      { when: { path: 'prev.output.status', op: 'eq', value: 'ok' }, then: 'verify' },
      { when: { path: 'prev.output.status', op: 'eq', value: 'failed' }, then: 'fix' },
    ])
    // Узлы без переходов остаются без `on`.
    expect(restored.nodes[1]?.on).toBeUndefined()
  })

  it('пустой массив `on` не теряется при round-trip', () => {
    const spec: PipelineSpec = {
      ...SPEC,
      nodes: [{ id: 'a', kind: 'agent', agent: 'assistant', on: [] }],
    }
    const flow = specToFlow(spec)
    const restored = flowToSpec(flow.nodes, flow.edges, spec)

    expect(restored.nodes[0]?.on).toEqual([])
  })

  it('метаданные, выходы и переменные берутся из основы', () => {
    const flow = specToFlow(SPEC)
    const base: PipelineSpec = { ...SPEC, name: 'Другое имя', exits: [{ kind: 'none' }] }
    const restored = flowToSpec(flow.nodes, flow.edges, base)

    expect(restored.name).toBe('Другое имя')
    expect(restored.exits).toEqual([{ kind: 'none' }])
    expect(restored.vars).toEqual({ branch: 'trigger.payload.branch' })
    expect(restored.mode).toBe('act')
    expect(restored.status).toBe('draft')
    expect(restored.version).toBe(3)
  })
})

describe('graph-adapter: подписи условий', () => {
  it('операторы отображаются символами, значения — как есть', () => {
    expect(formatConditionLabel({ path: 'prev.output.status', op: 'eq', value: 'ok' })).toBe(
      'prev.output.status = ok',
    )
    expect(formatConditionLabel({ path: 'vars.branch', op: 'ne', value: 'main' })).toBe(
      'vars.branch ≠ main',
    )
    expect(formatConditionLabel({ path: 'vars.branch', op: 'in', value: ['a', 'b'] })).toBe(
      'vars.branch ∈ a, b',
    )
    expect(formatConditionLabel({ path: 'prev.output.count', op: 'gt', value: 3 })).toBe(
      'prev.output.count > 3',
    )
    expect(formatConditionLabel({ path: 'prev.output.report', op: 'exists' })).toBe(
      'prev.output.report ?',
    )
  })
})

describe('graph-adapter: изменение графа', () => {
  it('удаление узла убирает его рёбра и сдвигает порядок', () => {
    const flow = specToFlow(SPEC)
    const { nodes, edges } = removeFlowNode(flow.nodes, flow.edges, 'verify')

    expect(nodes.map((node) => node.id)).toEqual(['implement', 'fix', 'approve'])
    expect(nodes.map((node) => node.data.order)).toEqual([0, 1, 2])
    expect(edges.some((edge) => edge.source === 'verify' || edge.target === 'verify')).toBe(false)
    // Линейное ребро пересобрано: «implement» без переходов? — у него есть `on`,
    // поэтому линейное ребро появилось у «fix».
    expect(edges.find((edge) => edge.id === linearEdgeId('fix'))?.target).toBe('approve')
  })

  it('перестановка узла меняет порядок и линейные рёбра', () => {
    const flow = specToFlow(SPEC)
    const moved = moveFlowNode(flow.nodes, 'fix', -1)
    const edges = buildEdges(moved, conditionEdges(flow.edges))

    expect(orderNodes(moved).map((node) => node.id)).toEqual([
      'implement',
      'fix',
      'verify',
      'approve',
    ])
    // У «fix» нет переходов → линейное ребро в «verify».
    expect(edges.find((edge) => edge.id === linearEdgeId('fix'))?.target).toBe('verify')
  })

  it('правка полей узла не трогает остальные узлы', () => {
    const flow = specToFlow(SPEC)
    const updated = updateFlowNode(flow.nodes, 'verify', { title: 'Проверка' })

    expect(updated.find((node) => node.id === 'verify')?.data.node.title).toBe('Проверка')
    expect(updated.find((node) => node.id === 'implement')?.data.node).toEqual(
      flow.nodes.find((node) => node.id === 'implement')?.data.node,
    )
  })

  it('идентификатор нового узла не пересекается с существующими', () => {
    expect(nextNodeId(['implement', 'node-1'])).toBe('node-2')
    expect(nextNodeId(['implement'])).toBe('node-1')
  })

  it('новый узел получает вид и пустую спецификацию', () => {
    const node = createFlowNode('tool', 'node-1', 2)

    expect(node.id).toBe('node-1')
    expect(node.type).toBe('tool')
    expect(node.data.order).toBe(2)
    expect(node.data.node).toEqual({ id: 'node-1', kind: 'tool' })
  })
})
