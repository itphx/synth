import React, { useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import type { ProjectData, ProjectPipeline, PipelineSpecInput } from '@/lib/api/synthApi'
import { useNotification } from '@/hooks/useNotification'
import { Dialog, DialogContent } from '@/components/ui/dialog'

/**
 * Диалог создания пайплайна проекта (ADR-101, Э7).
 *
 * Визуального редактора пока нет (Э7.2 — `@xyflow/react`), поэтому создаём
 * **каркас** спецификации: один агентский узел и выход `none`. Дальше
 * спецификация правится на странице пайплайна (структурный вид/JSON) — до
 * появления канваса.
 */
export function CreatePipelineDialog({
  project,
  onClose,
  onCreated,
}: {
  project: ProjectData
  onClose: () => void
  onCreated: (pipeline: ProjectPipeline) => void
}) {
  const { t } = useI18n()
  const { notify } = useNotification()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('pipelines.nameRequired'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Серверные поля (`id`/`version`/`status`/`projectId`) проставляет сервер —
      // в теле создания их нет.
      const spec: PipelineSpecInput = {
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        mode: 'plan',
        nodes: [{ id: 'step-1', kind: 'agent', title: trimmed, agent: 'assistant' }],
        exits: [{ kind: 'none' }],
      }
      const pipeline = await synthApi.createProjectPipeline(project.id, {
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        spec,
      })
      notify({ text: t('pipelines.created'), type: 'success', category: 'system' })
      onCreated(pipeline)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      notify({ text: message, type: 'error', category: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4 gap-3" showCloseButton={true}>
        <h3 className="text-sm font-semibold">{t('pipelines.createTitle')}</h3>
        <p className="text-xs text-muted-foreground">{project.name}</p>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('pipelines.name')}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder={t('pipelines.namePlaceholder')}
            className="w-full rounded bg-interactive px-2 py-1.5 text-sm text-foreground outline-none"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('pipelines.description')}
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('pipelines.descriptionPlaceholder')}
            className="w-full rounded bg-interactive px-2 py-1.5 text-sm text-foreground outline-none"
          />
        </label>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="flex-1 rounded bg-primary px-2 py-1.5 text-xs text-primary-foreground transition-colors disabled:opacity-50"
          >
            {t('pipelines.create')}
          </button>
          <button
            onClick={onClose}
            className="flex-1 rounded bg-interactive px-2 py-1.5 text-xs text-foreground hover:bg-interactive-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
