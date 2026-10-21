import React from 'react'

import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import type { PipelineNode, PipelineSpec } from '@/lib/api/synthApi'

/**
 * Структурный (read-only) вид спецификации пайплайна (ADR-101, Э7).
 *
 * **Точка расширения:** визуального редактора пока нет (Э7.2 — `@xyflow/react`),
 * поэтому спецификация показывается списком шагов: вид узла, агент, вход,
 * переходы, выходы. В Э7.2 этот компонент заменяется канвасом — поэтому он
 * принимает **только** спецификацию и ничего не знает о загрузке/сохранении.
 */
export function PipelineSpecView({
  spec,
  emptyText,
}: {
  spec: PipelineSpec | undefined | null
  emptyText?: string
}) {
  const { t } = useI18n()

  if (!spec) {
    return (
      <p className="text-xs text-muted-foreground">
        {emptyText ?? t('pipelines.noDraft')}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded bg-interactive px-1.5 py-0.5">{t('pipelines.mode')}: {spec.mode}</span>
        <span className="rounded bg-interactive px-1.5 py-0.5">{t('pipelines.version')}: {spec.version}</span>
        {spec.status === 'draft'
          ? <span className="rounded bg-status-warning/15 px-1.5 py-0.5 text-status-warning">{t('pipelines.status.draft')}</span>
          : <span className="rounded bg-status-success/15 px-1.5 py-0.5 text-status-success">{t('pipelines.status.published')}</span>}
      </div>

      {spec.vars && Object.keys(spec.vars).length > 0 && (
        <Section title={t('pipelines.vars')}>
          <ul className="flex flex-col gap-0.5">
            {Object.entries(spec.vars).map(([name, path]) => (
              <li key={name} className="text-xs">
                <span className="font-medium text-foreground">{name}</span>
                <span className="text-muted-foreground"> ← {path}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={t('pipelines.nodes', { count: String(spec.nodes?.length ?? 0) })}>
        <ol className="flex flex-col gap-1.5">
          {(spec.nodes ?? []).map((node) => (
            <NodeRow key={node.id} node={node} />
          ))}
        </ol>
      </Section>

      <Section title={t('pipelines.exits', { count: String(spec.exits?.length ?? 0) })}>
        <ul className="flex flex-col gap-1">
          {(spec.exits ?? []).map((exit, index) => (
            <li key={index} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{exit.kind}</span>
              {exit.kind === 'session' && (
                <span>
                  {' '}
                  {exit.session?.agent ?? exit.session?.sessionId ?? '—'}
                </span>
              )}
              {exit.kind === 'file' && <span> {exit.file?.path ?? '—'}</span>}
              {exit.kind === 'gateway' && (
                <span> {exit.gateway?.event ?? exit.gateway?.webhookId ?? '—'}</span>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </section>
  )
}

/** Строка узла: вид, название, агент/тул/команда, вход и переходы. */
function NodeRow({ node }: { node: PipelineNode }) {
  const { t } = useI18n()

  const detail = (): string => {
    switch (node.kind) {
      case 'agent':
        return node.agent ?? '—'
      case 'tool':
        return node.tool ?? '—'
      case 'script':
        return node.command ?? '—'
      case 'human':
        return t('pipelines.node.human')
      default:
        return node.kind
    }
  }

  return (
    <li className="rounded border border-border bg-card px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Icon name="arrow-right-s" className="h-3 w-3 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{node.title || node.id}</span>
        <span className="rounded bg-interactive px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">{node.kind}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>{t('pipelines.node.target')}: {detail()}</span>
        {node.skill && <span>{t('pipelines.node.skill')}: {node.skill}</span>}
        {node.timeoutSec !== undefined && <span>{t('pipelines.node.timeout')}: {node.timeoutSec} с</span>}
        {node.retry && <span>{t('pipelines.node.retry')}: {node.retry.max}</span>}
        {node.input && node.input.length > 0 && (
          <span>{t('pipelines.node.input')}: {node.input.join(', ')}</span>
        )}
      </div>
      {node.on && node.on.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {node.on.map((transition, index) => (
            <li key={index} className="text-[0.65rem] text-muted-foreground">
              <Icon name="arrow-right" className="inline h-2.5 w-2.5" />
              {transition.when.path} {transition.when.op}
              {transition.when.value !== undefined ? ` ${JSON.stringify(transition.when.value)}` : ''}
              {' → '}
              <span className="text-foreground">{transition.then}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
