import { useState } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { MarkdownContent } from './MarkdownContent'

interface SubagentPartProps {
  subagent: {
    name: string
    prompt?: string
    messages?: Array<{ role: string; content: string }>
    response?: string
  }
}

export function SubagentPart({ subagent }: SubagentPartProps) {
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
        <Icon name="robot-2" className="size-3.5 text-purple-400" />
        <span className="font-medium">{t('chat.subagent.title')}: {subagent.name}</span>
      </button>
      {expanded && (
        <div className="p-3 border-t border-border/50 bg-muted/10 space-y-2">
          {subagent.prompt && (
            <div>
              <div className="text-[10px] text-muted-foreground/60 mb-1 uppercase tracking-wide">Prompt</div>
              <MarkdownContent content={subagent.prompt} className="text-xs" />
            </div>
          )}
          {subagent.messages && subagent.messages.length > 0 && (
            <div>
              <div className="text-[10px] text-muted-foreground/60 mb-1 uppercase tracking-wide">Messages</div>
              {subagent.messages.map((msg, i) => (
                <div key={i} className="text-xs mb-1 pl-2 border-l-2 border-muted">
                  <span className="text-muted-foreground/60">{msg.role}: </span>
                  <span className="text-muted-foreground">{msg.content.slice(0, 200)}{msg.content.length > 200 ? '...' : ''}</span>
                </div>
              ))}
            </div>
          )}
          {subagent.response && (
            <div>
              <div className="text-[10px] text-muted-foreground/60 mb-1 uppercase tracking-wide">Response</div>
              <MarkdownContent content={subagent.response} className="text-xs" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
