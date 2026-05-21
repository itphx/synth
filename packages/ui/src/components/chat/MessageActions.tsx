import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'

interface MessageActionsProps {
  messageIndex: number
  role: string
  disabled: boolean
  pinned: boolean
  canRetry: boolean
  hasDebug: boolean
  onCopy: () => void
  onToggle: () => void
  onPin: () => void
  onDelete: () => void
  onRetry: () => void
  onReturn: () => void
  onDebug: () => void
}

export function MessageActions({
  role,
  disabled,
  pinned,
  canRetry,
  hasDebug,
  onCopy,
  onToggle,
  onPin,
  onDelete,
  onRetry,
  onReturn,
  onDebug,
}: MessageActionsProps) {
  const { t } = useI18n()
  const isUser = role === 'user'

  return (
    <div className="flex items-center gap-0.5 mt-2 pt-1.5 border-t border-border/30 opacity-0 group-hover:opacity-100 transition-opacity">
      <ActionBtn onClick={onCopy} title={t('chat.actions.copy')} icon="file-copy" />

      <ActionBtn
        onClick={onToggle}
        title={disabled ? t('chat.actions.toggleOn') : t('chat.actions.toggleOff')}
        icon={disabled ? 'eye-off' : 'eye'}
        active={disabled}
      />

      <ActionBtn
        onClick={onPin}
        title={pinned ? t('chat.actions.unpin') : t('chat.actions.pin')}
        icon="pushpin"
        active={pinned}
      />

      <ActionBtn onClick={onDelete} title={t('chat.actions.delete')} icon="delete-bin" danger />

      {isUser && canRetry && (
        <ActionBtn onClick={onRetry} title={t('chat.actions.retry')} icon="refresh" />
      )}

      {isUser && (
        <ActionBtn onClick={onReturn} title={t('chat.actions.return')} icon="arrow-go-back" />
      )}

      {!isUser && hasDebug && (
        <ActionBtn onClick={onDebug} title={t('chat.actions.debug')} icon="bug" />
      )}
    </div>
  )
}

function ActionBtn({
  onClick,
  title,
  icon,
  active,
  danger,
}: {
  onClick: () => void
  title: string
  icon: string
  active?: boolean
  danger?: boolean
}) {
  return (
    <button
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
}
