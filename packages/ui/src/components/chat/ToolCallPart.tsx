import { useState } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'

interface ToolCallPartProps {
  toolCall: { name: string; args: Record<string, unknown>; id?: string }
}

export function ToolCallPart({ toolCall }: ToolCallPartProps) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="mb-2 rounded-md border border-border/50 overflow-hidden">
      <button
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors bg-muted/30"
        onClick={() => setExpanded(!expanded)}
      >
        <Icon
          name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
          className="size-3.5 transition-transform"
        />
        <Icon name="tools" className="size-3.5 text-blue-400" />
        <span className="font-medium">{t('chat.toolCall.title')}: {toolCall.name}</span>
        <span className="ml-auto text-[10px] opacity-50">
          {expanded ? t('chat.toolCall.collapse') : t('chat.toolCall.expand')}
        </span>
      </button>
      {expanded && (
        <div className="p-3 border-t border-border/50 bg-muted/10">
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap overflow-x-auto font-mono">
            {JSON.stringify(toolCall.args, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
