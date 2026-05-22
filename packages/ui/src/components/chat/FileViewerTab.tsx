import { Icon } from '../icon/Icon'
import type { CenterTab } from '@/stores/useUIStore'

interface FileViewerTabProps {
  tab: CenterTab
}

export function FileViewerTab({ tab }: FileViewerTabProps) {
  return (
    <div className="flex flex-1 items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Icon name="file-3" className="size-16" />
        <div className="flex items-center gap-2">
          <Icon name="file-3" className="size-5" />
          <span className="text-sm font-medium">Просмотр: {tab.title}</span>
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
