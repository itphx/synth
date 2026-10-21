import React from 'react'

import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { SelectContent, SelectItem } from '@/components/ui/select'
import { ListField } from '@/components/ui/settings/controls/ListField'
import { NumberField } from '@/components/ui/settings/controls/NumberField'
import { SelectField } from '@/components/ui/settings/controls/SelectField'
import { TextArea } from '@/components/ui/settings/controls/TextArea'
import { TextField } from '@/components/ui/settings/controls/TextField'
import { useI18n } from '@/lib/i18n'
import type { PipelineCondition, PipelineConditionOp, PipelineNode } from '@itphx/synth-shared/types'

import { nodeKindIcon } from './PipelineNodeCard'

/** Переход узла в виде инспектора (условие + цель + идентификатор ребра). */
export interface InspectorTransition {
  /** Идентификатор ребра графа — по нему переход правится/удаляется. */
  id: string
  when: PipelineCondition
  then: string
}

/** Оператор условия — набор из shared-контракта. */
const OPS: PipelineConditionOp[] = ['eq', 'ne', 'in', 'exists', 'gt', 'lt']

/**
 * Разбор значения условия из текста: JSON-скаляр (число/булево/null) — как
 * есть, иначе строка. Для `in` — список через запятую.
 */
function parseScalar(text: string): string | number | boolean | null {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return text
}

/** Значение условия → текст поля ввода. */
function valueToText(value: PipelineCondition['value']): string {
  if (value === undefined) return ''
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ')
  return String(value)
}

/**
 * Инспектор узла — поля шага по его виду и переходы (`on`).
 *
 * Виды (ADR-101 §2.5): `agent` — агент/скилл/промпт, `script` — команда и
 * аргументы, `tool` — инструмент и аргументы, `human` — вопрос и таймаут.
 * Общие поля — название, таймаут, политика повторов, маппинг входа.
 */
export function NodeInspector({
  node,
  transitions,
  targets,
  readOnly,
  onChangeNode,
  onChangeTransition,
  onAddTransition,
  onRemoveTransition,
  onRemoveNode,
  onMoveNode,
  canMoveUp,
  canMoveDown,
}: {
  node: PipelineNode
  transitions: InspectorTransition[]
  targets: Array<{ id: string; label: string }>
  readOnly?: boolean
  onChangeNode: (patch: Partial<PipelineNode>) => void
  onChangeTransition: (
    id: string,
    patch: { when?: PipelineCondition; then?: string },
  ) => void
  onAddTransition: () => void
  onRemoveTransition: (id: string) => void
  onRemoveNode: () => void
  onMoveNode: (delta: number) => void
  canMoveUp: boolean
  canMoveDown: boolean
}) {
  const { t } = useI18n()
  const disabled = readOnly === true

  const opItems = OPS.map((op) => ({
    value: op,
    label: t(`pipelines.editor.op.${op}`),
  }))

  const targetItems = targets.map((target) => ({ value: target.id, label: target.label }))

  const setText = (key: keyof PipelineNode, value: string) => {
    if (value.trim() === '') {
      onChangeNode({ [key]: undefined } as Partial<PipelineNode>)
      return
    }
    onChangeNode({ [key]: value } as Partial<PipelineNode>)
  }

  const setNumber = (key: keyof PipelineNode, raw: string) => {
    if (raw.trim() === '') {
      onChangeNode({ [key]: undefined } as Partial<PipelineNode>)
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    onChangeNode({ [key]: parsed } as Partial<PipelineNode>)
  }

  const setToolArgs = (raw: string) => {
    if (raw.trim() === '') {
      onChangeNode({ toolArgs: undefined })
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      onChangeNode({ toolArgs: parsed as Record<string, unknown> })
    } catch {
      // Некорректный JSON — оставляем прежние значения (проблему покажет «Проверить»).
    }
  }

  const updateWhen = (
    transition: InspectorTransition,
    patch: Partial<PipelineCondition>,
  ) => {
    onChangeTransition(transition.id, {
      when: { ...transition.when, ...patch },
    })
  }

  return (
    <div className="flex flex-col gap-4 p-3">
      <header className="flex items-start gap-2">
        <Icon name={nodeKindIcon(node.kind)} className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {node.title || node.id}
          </span>
          <span className="truncate text-[0.65rem] text-muted-foreground">{node.id}</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || !canMoveUp}
            onClick={() => onMoveNode(-1)}
            aria-label={t('pipelines.editor.moveUp')}
            title={t('pipelines.editor.moveUp')}
          >
            <Icon name="arrow-up" className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || !canMoveDown}
            onClick={() => onMoveNode(1)}
            aria-label={t('pipelines.editor.moveDown')}
            title={t('pipelines.editor.moveDown')}
          >
            <Icon name="arrow-down" className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={disabled}
            onClick={onRemoveNode}
            aria-label={t('pipelines.editor.removeStep')}
            title={t('pipelines.editor.removeStep')}
          >
            <Icon name="trash-2" className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      <TextField
        label={t('pipelines.editor.field.title')}
        value={node.title ?? ''}
        disabled={disabled}
        onChange={(e) => setText('title', e.target.value)}
        placeholder={node.id}
      />

      {node.kind === 'agent' && (
        <>
          <TextField
            label={t('pipelines.editor.field.agent')}
            value={node.agent ?? ''}
            disabled={disabled}
            onChange={(e) => setText('agent', e.target.value)}
          />
          <TextField
            label={t('pipelines.editor.field.skill')}
            value={node.skill ?? ''}
            disabled={disabled}
            onChange={(e) => setText('skill', e.target.value)}
          />
          <TextArea
            label={t('pipelines.editor.field.prompt')}
            value={node.prompt ?? ''}
            disabled={disabled}
            onChange={(e) => setText('prompt', e.target.value)}
          />
        </>
      )}

      {node.kind === 'script' && (
        <>
          <TextField
            label={t('pipelines.editor.field.command')}
            value={node.command ?? ''}
            disabled={disabled}
            onChange={(e) => setText('command', e.target.value)}
          />
          <ListField
            label={t('pipelines.editor.field.args')}
            values={node.args ?? []}
            onChange={(next) => onChangeNode({ args: next.length ? next : undefined })}
            disabled={disabled}
          />
        </>
      )}

      {node.kind === 'tool' && (
        <>
          <TextField
            label={t('pipelines.editor.field.tool')}
            value={node.tool ?? ''}
            disabled={disabled}
            onChange={(e) => setText('tool', e.target.value)}
          />
          <TextArea
            label={t('pipelines.editor.field.toolArgs')}
            mono
            rows={3}
            value={node.toolArgs ? JSON.stringify(node.toolArgs, null, 2) : ''}
            disabled={disabled}
            onChange={(e) => setToolArgs(e.target.value)}
          />
        </>
      )}

      {node.kind === 'human' && (
        <TextArea
          label={t('pipelines.editor.field.prompt')}
          value={node.prompt ?? ''}
          disabled={disabled}
          onChange={(e) => setText('prompt', e.target.value)}
        />
      )}

      <NumberField
        label={t('pipelines.editor.field.timeout')}
        value={node.timeoutSec ?? ''}
        disabled={disabled}
        onChange={(e) => setNumber('timeoutSec', e.target.value)}
      />

      <div className="flex items-start gap-2">
        <NumberField
          containerClassName="flex-1"
          label={t('pipelines.editor.field.retryMax')}
          value={node.retry?.max ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value.trim()
            if (raw === '') {
              onChangeNode({ retry: undefined })
              return
            }
            const max = Number(raw)
            if (!Number.isFinite(max) || max < 0) return
            onChangeNode({ retry: { ...(node.retry ?? { max: 0 }), max } })
          }}
        />
        <NumberField
          containerClassName="flex-1"
          label={t('pipelines.editor.field.retryBackoff')}
          value={node.retry?.backoffSec ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value.trim()
            if (raw === '') {
              onChangeNode({
                retry: node.retry
                  ? { ...node.retry, backoffSec: undefined }
                  : undefined,
              })
              return
            }
            const backoffSec = Number(raw)
            if (!Number.isFinite(backoffSec) || backoffSec <= 0) return
            onChangeNode({
              retry: { max: node.retry?.max ?? 0, ...node.retry, backoffSec },
            })
          }}
        />
      </div>

      <ListField
        label={t('pipelines.editor.field.input')}
        values={node.input ?? []}
        onChange={(next) => onChangeNode({ input: next.length ? next : undefined })}
        disabled={disabled}
        placeholder="prev.output.report"
      />

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium text-foreground">
            {t('pipelines.editor.transitions')}
          </h4>
          <Button variant="outline" size="sm" disabled={disabled} onClick={onAddTransition}>
            <Icon name="add" className="h-3.5 w-3.5" />
            {t('pipelines.editor.transition.add')}
          </Button>
        </div>

        {transitions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('pipelines.editor.transitionsEmpty')}
          </p>
        ) : (
          transitions.map((transition) => (
            <div
              key={transition.id}
              className="flex flex-col gap-2 rounded-lg border border-border p-2"
            >
              <TextField
                label={t('pipelines.editor.transition.path')}
                value={transition.when.path}
                disabled={disabled}
                onChange={(e) => updateWhen(transition, { path: e.target.value })}
              />
              <SelectField
                label={t('pipelines.editor.transition.op')}
                value={transition.when.op}
                items={opItems}
                disabled={disabled}
                onValueChange={(value) =>
                  updateWhen(transition, { op: value as PipelineConditionOp })
                }
              >
                <SelectContent>
                  {opItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectField>
              {transition.when.op !== 'exists' && (
                <TextField
                  label={t('pipelines.editor.transition.value')}
                  value={valueToText(transition.when.value)}
                  disabled={disabled}
                  onChange={(e) => {
                    const raw = e.target.value
                    const value =
                      transition.when.op === 'in'
                        ? raw
                            .split(',')
                            .map((item) => parseScalar(item))
                            .filter((item) => item !== '')
                        : parseScalar(raw)
                    updateWhen(transition, { value })
                  }}
                />
              )}
              <SelectField
                label={t('pipelines.editor.transition.target')}
                value={transition.then}
                items={targetItems}
                disabled={disabled}
                onValueChange={(value) => onChangeTransition(transition.id, { then: value })}
              >
                <SelectContent>
                  {targetItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectField>
              <Button
                variant="danger"
                size="sm"
                disabled={disabled}
                onClick={() => onRemoveTransition(transition.id)}
              >
                <Icon name="trash-2" className="h-3.5 w-3.5" />
                {t('pipelines.editor.transition.remove')}
              </Button>
            </div>
          ))
        )}
      </section>
    </div>
  )
}
