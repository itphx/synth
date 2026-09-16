import { useState } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { OriginSelector } from '@/components/ui/OriginSelector'
import { useProjectsStore } from '@/stores/projectsStore'
import { useHybridStore, selectIsOffline } from '@/stores/hybridStore'
import { useI18n } from '@/lib/i18n'
import type { ProjectData, EntityOrigin } from '@/lib/api/synthApi'

/**
 * Переиспользуемый поповер создания проекта: поле имени + (в гибриде) выбор
 * «где создать». Используется и в левой панели (ProjectsTabToolbar), и в правой
 * (ProjectTab).
 */
export function CreateProjectPopover({
  trigger,
  align = 'end',
  onCreated,
  onError,
}: {
  trigger: React.ReactNode
  align?: 'start' | 'center' | 'end'
  onCreated?: (project: ProjectData) => void | Promise<void>
  onError?: () => void
}) {
  const { t } = useI18n()
  const { createProject } = useProjectsStore()
  const hybridEnabled = useHybridStore((s) => s.enabled)
  const isOffline = useHybridStore(selectIsOffline)

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [origin, setOrigin] = useState<EntityOrigin>('local')
  const [submitting, setSubmitting] = useState(false)

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setName('')
      setOrigin('local')
    }
    setOpen(next)
  }

  const handleSubmit = async () => {
    const trimmed = name.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      const created = await createProject({ name: trimmed, origin })
      if (created) {
        setOpen(false)
        await onCreated?.(created)
      } else {
        onError?.()
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-56 p-3"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <form
          onSubmit={(e) => { e.preventDefault(); void handleSubmit() }}
          className="flex flex-col gap-2"
        >
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('leftPanel.projectName')}
            className="rounded bg-interactive px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none w-full"
          />
          {hybridEnabled && <OriginSelector value={origin} onChange={setOrigin} offline={isOffline} />}
          <button
            type="submit"
            disabled={submitting}
            className="self-end rounded px-3 py-1 text-xs text-primary hover:bg-primary/10"
          >
            {t('common.create')}
          </button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
