import { useMemo, useEffect, useRef } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import type { AgentInfo } from '@/lib/api/synthApi'

interface MentionPopupProps {
  query: string
  agents: AgentInfo[]
  position: { top: number; left: number }
  onSelect: (agentId: string) => void
  onClose: () => void
}

export function MentionPopup({ query, agents, position, onSelect, onClose }: MentionPopupProps) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!query) return agents.filter((a) => a.enabled)
    const q = query.toLowerCase()
    return agents.filter(
      (a) =>
        a.enabled &&
        (a.id.toLowerCase().includes(q) ||
          a.display_name.toLowerCase().includes(q))
    )
  }, [query, agents])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  if (filtered.length === 0) return null

  return (
    <div
      ref={ref}
      className="absolute z-50 rounded-lg border border-border bg-popover shadow-lg overflow-hidden"
      style={{ bottom: position.top, left: position.left, minWidth: '200px' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 border-b border-border/50 text-[10px] text-muted-foreground/60 uppercase tracking-wide">
        {t('chat.input.mentionHint')}
      </div>
      <div className="max-h-48 overflow-y-auto p-1">
        {filtered.map((agent) => (
          <button
            key={agent.id}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground hover:bg-interactive-hover transition-colors text-left group"
            onClick={() => onSelect(agent.id)}
          >
            <Icon name="user-smile" className="size-3.5 text-primary shrink-0" />
            <span className="font-medium">{agent.display_name}</span>
            {agent.capabilities.length > 0 && (
              <span className="text-[10px] text-muted-foreground/50 ml-auto hidden group-hover:block">
                {agent.capabilities.slice(0, 2).join(', ')}
              </span>
            )}
            <span className="text-muted-foreground/50 ml-auto font-mono group-hover:hidden">@{agent.id}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
