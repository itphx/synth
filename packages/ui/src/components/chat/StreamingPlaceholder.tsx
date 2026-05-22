import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import type { StreamState } from '@/stores/chatStore'
import { MarkdownContent } from './MarkdownContent'

interface StreamingPlaceholderProps {
  stream: StreamState
}

export function StreamingPlaceholder({ stream }: StreamingPlaceholderProps) {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <div className="flex items-center gap-2">
        {stream.agentRole && (
          <span className="inline-flex items-center gap-0.5 rounded-sm bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
            <Icon name="user-smile" className="size-3" />
            <span>{stream.agentRole}</span>
          </span>
        )}
        {stream.model && (
          <span className="inline-flex items-center gap-0.5 rounded-sm bg-muted px-1.5 py-0.5 text-[11px]">
            <Icon name="cpu" className="size-3" />
            <span>{stream.model}</span>
          </span>
        )}
        <BusyDots />
      </div>

      {stream.reasoning && (
        <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 mt-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70 mb-1">
            <Icon name="brain" className="size-3.5" />
            <span>{t('chat.reasoning.show')}</span>
          </div>
          <MarkdownContent content={stream.reasoning} className="text-xs text-muted-foreground/60" />
        </div>
      )}

      {stream.content && (
        <div className="mt-1">
          <MarkdownContent content={stream.content} />
        </div>
      )}
    </div>
  )
}

function BusyDots() {
  return (
    <span className="inline-flex gap-0.5 ml-1">
      <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  )
}
