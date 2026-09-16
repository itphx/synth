import { useMemo, useEffect, useRef, useState, useCallback } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { resolveColor } from '@/lib/utils'
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
  const [highlightedIdx, setHighlightedIdx] = useState(0)

  const filtered = useMemo(() => {
    if (!query) return agents.filter((a) => a.enabled && (a.agent_mode == null || a.agent_mode.includes('primary')))
    const q = query.toLowerCase()
    return agents.filter(
      (a) =>
        a.enabled &&
        (a.agent_mode == null || a.agent_mode.includes('primary')) &&
        (a.id.toLowerCase().includes(q) ||
          a.display_name.toLowerCase().includes(q))
    )
  }, [query, agents])

  useEffect(() => {
    setHighlightedIdx(0)
  }, [query])

  const navigate = useCallback((delta: number) => {
    setHighlightedIdx((prev) => (prev + delta + filtered.length) % filtered.length)
  }, [filtered.length])

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
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          navigate(1)
          break
        case 'ArrowUp':
          e.preventDefault()
          navigate(-1)
          break
        case 'Enter':
          e.preventDefault()
          if (filtered[highlightedIdx]) {
            onSelect(filtered[highlightedIdx].id)
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, navigate, filtered, highlightedIdx, onSelect])

  if (filtered.length === 0) return null

  return (
    <div
      ref={ref}
      className="absolute z-50 rounded-lg border border-border bg-popover shadow-lg overflow-hidden"
      style={{ bottom: position.top, left: position.left, minWidth: '12.5rem' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 border-b border-border/50 text-[0.625rem] text-muted-foreground/60 uppercase tracking-wide">
        {t('chat.input.mentionHint')}
      </div>
      <div className="max-h-72 overflow-y-auto p-1">
        {filtered.map((agent, idx) => (
          <button
            key={agent.id}
            className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground hover:bg-interactive-hover transition-colors text-left group ${
              idx === highlightedIdx ? 'bg-interactive-hover' : ''
            }`}
            onClick={() => onSelect(agent.id)}
          >
            {agent.icon ? (
              <Icon
                name={agent.icon}
                className="size-3.5 shrink-0"
                style={agent.color ? { color: resolveColor(agent.color) } : undefined}
              />
            ) : (
              <div
                className="h-1 w-1 rounded-full shrink-0"
                style={agent.color ? { backgroundColor: resolveColor(agent.color) } : undefined}
              />
            )}
            <span className="font-medium">{agent.display_name}</span>
            {agent.capabilities.length > 0 && (
              <span className="text-[0.625rem] text-muted-foreground/50 ml-auto hidden group-hover:block">
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
