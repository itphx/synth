import { useState } from 'react'
import type { QueuedMessage } from '../../stores/chatStore'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'

interface QueuePanelProps {
  pending: QueuedMessage[]
  isStalled: boolean
  pendingCount: number
  onResume: () => void
  onClear: () => void
  onReturnAll: () => void
  onReturnMsg: (index: number) => void
}

export function QueuePanel({
  pending,
  isStalled,
  pendingCount,
  onResume,
  onClear,
  onReturnAll,
  onReturnMsg,
}: QueuePanelProps) {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(!isStalled)

  if (pending.length === 0 && !isStalled) return null

  const borderClass = isStalled
    ? 'border-status-warning/20'
    : 'border-border/60'
  const bgClass = isStalled
    ? 'bg-status-warning/5'
    : 'bg-surface-inset'

  return (
    <div className={`shrink-0 mx-auto w-4/5 rounded-lg border ${borderClass} ${bgClass}`}>
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Icon
            name={collapsed ? 'arrow-right-s' : 'arrow-down-s'}
            className="size-3"
          />
          {isStalled ? (
            <Icon name="error-warning" className="size-3.5 text-status-warning shrink-0" />
          ) : (
            <Icon name="time" className="size-3.5 text-foreground shrink-0" />
          )}
          <span className={isStalled ? 'text-status-warning' : ''}>
            {isStalled
              ? t('chat.queue.stalled', { count: String(pendingCount) })
              : t('chat.queue.pending', { count: String(pending.length) })}
          </span>
        </button>
        <div className="flex items-center gap-1">
          {isStalled && (
            <button
              onClick={onResume}
              className="rounded px-2 py-0.5 text-[0.6875rem] font-medium bg-status-warning/20 text-status-warning hover:bg-status-warning/30 transition-colors"
            >
              {t('chat.queue.resume')}
            </button>
          )}
          <button
            onClick={onReturnAll}
            className="rounded px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
          >
            {t('chat.queue.return')}
          </button>
          <button
            onClick={onClear}
            className="rounded px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            {t('chat.queue.clear')}
          </button>
        </div>
      </div>

      {!collapsed && pending.length > 0 && (
        <div className="px-3 pb-2 space-y-1">
          {pending.map((msg, i) => (
            <div
              key={i}
              className={`flex items-center gap-2 px-2 py-1 rounded text-xs border group ${
                isStalled
                  ? 'bg-status-warning/10 border-status-warning/10'
                  : 'bg-surface-card border-border/20'
              }`}
            >
              <span className="text-muted-foreground shrink-0">
                {msg.agentRole ? `@${msg.agentRole}` : `#${i + 1}`}
              </span>
              <span className="truncate flex-1 text-foreground/80">
                {msg.content.slice(0, 100)}{msg.content.length > 100 ? '...' : ''}
              </span>
              <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => onReturnMsg(i)}
                  className="text-muted-foreground hover:text-foreground px-1"
                  title={t('chat.queue.return')}
                >
                  ↩
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
