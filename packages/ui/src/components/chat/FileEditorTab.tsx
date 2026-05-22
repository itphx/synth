import { useI18n } from '@/lib/i18n'
import { Icon } from '../icon/Icon'
import type { CenterTab } from '@/stores/useUIStore'

interface FileEditorTabProps {
  tab: CenterTab
}

export function FileEditorTab({ tab }: FileEditorTabProps) {
  const { t } = useI18n()
  return (
    <div className="flex flex-1 items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Icon name="edit-2" className="size-16" />
        <div className="flex items-center gap-2">
          <Icon name="edit-2" className="size-5" />
          <span className="text-sm font-medium">{t('center.tab.editing', { title: tab.title })}</span>
        </div>
        {tab.data.filePath && (
          <span className="text-xs text-muted-foreground/60 font-mono">
            {tab.data.filePath}
          </span>
        )}
      </div>
    </div>
  )
}
