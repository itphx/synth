import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

import { Icon, type IconName } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type { PipelineFlowNode } from './graph-adapter'

/**
 * Иконка вида узла пайплайна (ADR-101, Э7.2) — из общего реестра `Icon`
 * (своих svg не заводим).
 */
export function nodeKindIcon(kind: string): IconName {
  switch (kind) {
    case 'script':
      return 'terminal-box'
    case 'tool':
      return 'tools'
    case 'human':
      return 'user-3'
    case 'agent':
    default:
      return 'robot-2'
  }
}

/**
 * Карточка узла графа — «кубик» на канвасе.
 *
 * Показывает вид узла, название и цель (агент/инструмент/команда/вопрос
 * человека). Ручки (handles) — вход сверху, выход снизу: так цепочка
 * читается сверху вниз, как список шагов.
 */
export function PipelineNodeCard({ data, selected }: NodeProps<PipelineFlowNode>) {
  const { t } = useI18n()
  const node = data.node
  const title = node.title || node.id

  const subtitle = (): string => {
    switch (node.kind) {
      case 'agent':
        return node.agent ?? t('pipelines.editor.kind.agent')
      case 'tool':
        return node.tool ?? t('pipelines.editor.kind.tool')
      case 'script':
        return node.command ?? t('pipelines.editor.kind.script')
      case 'human':
        return t('pipelines.editor.kind.human')
      default:
        return node.kind
    }
  }

  return (
    <div
      data-node-id={node.id}
      className={cn(
        'w-56 rounded-lg border bg-card px-3 py-2 text-left shadow-sm transition-colors',
        selected ? 'border-primary ring-1 ring-primary/40' : 'border-border',
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2 !w-2 !border-background !bg-muted-foreground"
      />
      <div className="flex items-center gap-2">
        <Icon name={nodeKindIcon(node.kind)} className="h-4 w-4 shrink-0 text-primary" />
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <span className="rounded bg-interactive px-1 py-0.5 text-[0.65rem] text-muted-foreground">
          {node.kind}
        </span>
        <span className="truncate text-[0.65rem] text-muted-foreground">{subtitle()}</span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !border-background !bg-muted-foreground"
      />
    </div>
  )
}
