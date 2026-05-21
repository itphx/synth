import { useState } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { MarkdownContent } from './MarkdownContent'

interface ReasoningBlockProps {
  reasoning: string
}

export function ReasoningBlock({ reasoning }: ReasoningBlockProps) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)

  if (!reasoning) return null

  return (
    <div className="mb-2 rounded-md border border-border/50 bg-muted/30 overflow-hidden">
      <button
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Icon
          name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
          className="size-3.5 transition-transform"
        />
        <Icon name="brain" className="size-3.5" />
        <span>{expanded ? t('chat.reasoning.hide') : t('chat.reasoning.show')}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 border-t border-border/50">
          <MarkdownContent content={reasoning} className="text-xs text-muted-foreground/80" />
        </div>
      )}
    </div>
  )
}
