import { forwardRef, type ReactNode } from 'react'
import { Icon } from '../icon/Icon'
import { StatsPopoverButton } from './StatsPopoverButton'
import { useI18n } from '@/lib/i18n'

interface MessageActionsProps {
  messageIndex: number
  role: string
  disabled: boolean
  pinned: boolean
  canRetry: boolean
  hasDebug: boolean
  /** Открыто окно отладки именно для этого сообщения — подсветить кнопку. */
  debugActive?: boolean
  readOnly?: boolean
  /** У сообщения есть статистика ответа — показать кнопку и поповер. */
  hasStats?: boolean
  /** Содержимое поповера со статистикой ответа. */
  statsContent?: ReactNode
  /**
   * AD-046 §7.1: встроить действия в чужой футер (Notice) — без своей рамки,
   * отступов и opacity-обёртки (их рисует родитель).
   */
  embedded?: boolean
  /** Показывать кнопку «Копировать» (в Notice копия рисуется отдельно). */
  showCopy?: boolean
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
  debugActive,
  readOnly,
  hasStats,
  statsContent,
  embedded,
  showCopy = true,
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
    <div
      className={
        embedded
          ? 'flex items-center gap-0.5'
          : 'message-actions flex items-center gap-0.5 mt-2 pt-1.5 -mb-1.5 border-t border-border/30 opacity-0 group-hover:opacity-100 transition-opacity'
      }
    >
      {showCopy && <ActionBtn onClick={onCopy} title={t('chat.actions.copy')} icon="file-copy" />}

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
        <ActionBtn onClick={onDebug} title={t('chat.actions.debug')} icon="bug" active={debugActive} />
      )}

      {/* AD-070 §2.6: статистика ответа — кнопка в ряду, содержимое в поповере.
          Единое поведение на всех платформах, инлайн не рендерится. */}
      {!isUser && hasStats && statsContent && <StatsPopoverButton>{statsContent}</StatsPopoverButton>}
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
      className={`inline-flex items-center justify-center rounded p-1 transition-colors ${
        danger
          ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
          : active
            ? 'text-primary bg-primary/10'
            : 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover'
      }`}
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  )
})
