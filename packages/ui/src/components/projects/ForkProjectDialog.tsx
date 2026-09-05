import { useEffect, useState } from 'react'
import { Icon } from '@/components/icon/Icon'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { notifyMessage } from '@/hooks/useNotification'
import { useProjectsStore } from '@/stores/projectsStore'
import type { ProjectData } from '@/lib/api/synthApi'

/**
 * Диалог «Склонировать локально» (гибрид): удалённый проект → локальная копия
 * (проект + сессии + файлы). Имя копии по умолчанию — имя удалённого проекта;
 * при совпадении с существующим локальным проектом показываем предупреждение и
 * просим указать другое имя (fork всегда создаёт НОВЫЙ локальный проект).
 */
interface ForkProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Удалённый проект, который клонируем. */
  project: ProjectData
  /** Локальные проекты — для проверки коллизии имени. */
  localProjects: ProjectData[]
}

export function ForkProjectDialog({ open, onOpenChange, project, localProjects }: ForkProjectDialogProps) {
  const { t } = useI18n()
  const forkRemoteProject = useProjectsStore((s) => s.forkRemoteProject)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName(project.name || '')
      setBusy(false)
      setError(null)
    }
  }, [open, project.id, project.name])

  const trimmed = name.trim()
  const collides = !!trimmed && localProjects.some((p) => p.name === trimmed)

  const submit = async () => {
    if (busy || !trimmed || collides) return
    setBusy(true)
    setError(null)
    try {
      await forkRemoteProject(project.id, { local_name: trimmed })
      notifyMessage({
        text: t('hybrid.forkDialog.success', { name: trimmed }),
        type: 'success',
        category: 'system',
      })
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-5 gap-3">
        <h3 className="text-sm font-semibold">{t('hybrid.forkDialog.title')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('hybrid.forkDialog.subtitle')}
          <span className="block truncate mt-0.5 text-foreground">{project.name}</span>
        </p>

        <div>
          <label className="block text-[0.65rem] text-muted-foreground mb-1">
            {t('hybrid.forkDialog.localName')}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
            autoFocus
            className={cn(
              'w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none',
              collides && 'ring-1 ring-status-warning',
            )}
          />
          {collides && (
            <p className="text-[0.65rem] text-status-warning mt-1">{t('hybrid.forkDialog.nameCollision')}</p>
          )}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="rounded bg-interactive px-4 py-2 text-xs text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={busy || !trimmed || collides}
            className="flex items-center gap-1.5 rounded bg-primary px-4 py-2 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Icon name={busy ? 'loader-2' : 'download'} className={cn('size-3.5', busy && 'animate-spin')} />
            {busy ? t('hybrid.forkDialog.cloning') : t('hybrid.forkDialog.clone')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
