import { forwardRef, type ReactNode } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'

interface MessageActionsProps {
  messageIndex: number
  role: string
  disabled: boolean
  pinned: boolean
  canRetry: boolean
  hasDebug: boolean
  readOnly?: boolean
  /** У сообщения есть статистика ответа — на mobile показать кнопку (popover). */
  hasStats?: boolean
  /** Содержимое popover со статистикой (mobile); на десктопе не передаётся. */
  statsContent?: ReactNode
  onCopy: () => void
  onToggle: () => void
  onPin: () => void
  onDelete: () => void
  onRetry: () => void
  onDebug: () => void
  onFork: () => void
}

export function MessageActions({
  messageIndex: _messageIndex,
  role,
  disabled,
  pinned,
  canRetry,
  hasDebug,
  readOnly,
  hasStats,
  statsContent,
  onCopy,
  onToggle,
  onPin,
  onDelete,
  onRetry,
  onDebug,
  onFork,
}: MessageActionsProps) {
  const { t } = useI18n()
  const isUser = role === 'user'

  return (
    <div className="message-actions flex items-center gap-0.5 mt-2 pt-1.5 -mb-1.5 border-t border-border/30 opacity-0 group-hover:opacity-100 transition-opacity">
      <ActionBtn onClick={onCopy} title={t('chat.actions.copy')} icon="file-copy" />

      <ActionBtn onClick={onFork} title={t('chat.actions.fork')} icon="git-branch" />

      {!readOnly && (
        <ActionBtn
          onClick={onToggle}
          title={disabled ? t('chat.actions.toggleOn') : t('chat.actions.toggleOff')}
          icon={disabled ? 'eye-off' : 'eye'}
          active={disabled}
        />
      )}

      {!readOnly && (
        <ActionBtn
          onClick={onPin}
          title={pinned ? t('chat.actions.unpin') : t('chat.actions.pin')}
          icon="pushpin"
          active={pinned}
        />
      )}

      {!readOnly && (
        <ActionBtn onClick={onDelete} title={t('chat.actions.delete')} icon="delete-bin" danger />
      )}

      {!readOnly && isUser && canRetry && (
        <ActionBtn onClick={onRetry} title={t('chat.actions.retry')} icon="refresh" />
      )}

      {!isUser && hasDebug && (
        <ActionBtn onClick={onDebug} title={t('chat.actions.debug')} icon="bug" />
      )}

      {/* AD-070 §2.6 (mobile): статистика ответа — в popover, инлайн не рендерится. */}
      {!isUser && hasStats && statsContent && (
        <Popover>
          <PopoverTrigger asChild>
            <ActionBtn title={t('chat.messageStats.toggle')} icon="chart-line" />
          </PopoverTrigger>
          <PopoverContent className="w-56 p-3">
            {statsContent}
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

const ActionBtn = forwardRef<
  HTMLButtonElement,
  {
    onClick?: () => void
    title: string
    icon: string
    active?: boolean
    danger?: boolean
  }
>(function ActionBtn({ onClick, title, icon, active, danger }, ref) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      title={title}
      className={`rounded p-1 transition-colors ${
        danger
          ? 'hover:bg-destructive/10 hover:text-destructive'
          : active
            ? 'text-primary bg-primary/10'
            : 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover'
      }`}
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  )
})
