import { useEffect, useState } from 'react'
import { Icon } from '@/components/icon/Icon'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { notifyMessage } from '@/hooks/useNotification'
import { useProjectsStore } from '@/stores/projectsStore'
import type { ProjectData } from '@/lib/api/synthApi'

/**
 * Диалог «Опубликовать на сервер» (гибрид): локальный проект → удалённый backend.
 * Два режима: создать новый проект на сервере (имя сохраняется) или обновить
 * существующий удалённый проект. Сессии и файлы переносятся всегда.
 */
interface PublishProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Локальный проект, который публикуем. */
  project: ProjectData
  /** Удалённые проекты — кандидаты на «обновить существующий». */
  remoteProjects: ProjectData[]
}

export function PublishProjectDialog({ open, onOpenChange, project, remoteProjects }: PublishProjectDialogProps) {
  const { t } = useI18n()
  const publishProject = useProjectsStore((s) => s.publishProject)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setMode('new')
      setSelectedId('')
      setBusy(false)
      setError(null)
    }
  }, [open, project.id])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const remoteProjectId = mode === 'existing' && selectedId ? selectedId : undefined
      await publishProject(project.id, remoteProjectId ? { remote_project_id: remoteProjectId } : undefined)
      notifyMessage({
        text: t('hybrid.publishDialog.success', { name: project.name }),
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

  const overwriteExisting = mode === 'existing' && !!selectedId

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-5 gap-3">
        <h3 className="text-sm font-semibold">{t('hybrid.publishDialog.title')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('hybrid.publishDialog.subtitle')}
          <span className="block truncate mt-0.5 text-foreground">{project.name}</span>
        </p>

        <div className="flex flex-col gap-1.5">
          <button
            onClick={() => setMode('new')}
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors',
              mode === 'new'
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-sidebar-border text-muted-foreground hover:bg-interactive-hover',
            )}
          >
            <Icon name={mode === 'new' ? 'checkbox' : 'checkbox-blank'} className="size-3.5 shrink-0 mt-0.5" />
            <span>
              {t('hybrid.publishDialog.new')}
              <span className="block text-muted-foreground mt-0.5 truncate">{project.name}</span>
            </span>
          </button>

          <button
            onClick={() => {
              setMode('existing')
              if (!selectedId && remoteProjects.length > 0) setSelectedId(remoteProjects[0]!.id)
            }}
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors',
              mode === 'existing'
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-sidebar-border text-muted-foreground hover:bg-interactive-hover',
            )}
          >
            <Icon name={mode === 'existing' ? 'checkbox' : 'checkbox-blank'} className="size-3.5 shrink-0 mt-0.5" />
            <span className="flex-1 min-w-0">
              {t('hybrid.publishDialog.existing')}
              <span className="block text-muted-foreground mt-1">
                {remoteProjects.length === 0 ? (
                  t('hybrid.publishDialog.noRemoteProjects')
                ) : (
                  <Select value={selectedId} onValueChange={(v) => setSelectedId(v || '')}>
                    <SelectTrigger size="sm" className="w-full text-xs border-0 bg-interactive rounded">
                      <span className="truncate flex-1 text-left">
                        {selectedId ? (remoteProjects.find((p) => p.id === selectedId)?.name ?? selectedId) : ''}
                      </span>
                      <Icon name="arrow-down-s" className="size-3.5 opacity-50 shrink-0" />
                    </SelectTrigger>
                    <SelectContent>
                      {remoteProjects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </span>
              {overwriteExisting && (
                <span className="block text-status-warning mt-1">{t('hybrid.publishDialog.overwriteHint')}</span>
              )}
            </span>
          </button>
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
            disabled={busy || (mode === 'existing' && remoteProjects.length === 0)}
            className="flex items-center gap-1.5 rounded bg-primary px-4 py-2 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Icon name={busy ? 'loader-2' : 'upload'} className={cn('size-3.5', busy && 'animate-spin')} />
            {busy ? t('hybrid.publishDialog.publishing') : t('hybrid.publishDialog.publish')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
