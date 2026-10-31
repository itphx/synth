import { useState, type DragEvent } from 'react'
import type { QueuedMessage } from '../../stores/chatStore'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { cn } from '@/lib/utils'

interface QueuePanelProps {
  pending: QueuedMessage[]
  isStalled: boolean
  pendingCount: number
  /** Ход активен — можно отправить сообщение из очереди в разрыв (steer). */
  canSteer: boolean
  onResume: () => void
  onClear: () => void
  onReturnAll: () => void
  onReturnMsg: (uiIndex: number) => void
  onSteerMsg: (uiIndex: number) => void
  onRemoveMsg: (uiIndex: number) => void
  /**
   * Новый порядок очереди (DnD): список серверных `id` в желаемом порядке.
   * Не задан — перетаскивание выключено.
   */
  onReorder?: (ids: string[]) => void
}

/** Компактная иконка-действие строки очереди; на тач-указателе — таргет ≥40px (ADR-044). */
const ROW_ACTION_CLASS =
  'flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors pointer-coarse:size-10'

/** Первая непустая строка сообщения — превью строки очереди. */
function firstLineOf(content: string): string {
  const lines = content.split('\n')
  const first = lines.find((line) => line.trim() !== '')
  return first ?? ''
}

export function QueuePanel({
  pending,
  isStalled,
  pendingCount,
  canSteer,
  onResume,
  onClear,
  onReturnAll,
  onReturnMsg,
  onSteerMsg,
  onRemoveMsg,
  onReorder,
}: QueuePanelProps) {
  const { t } = useI18n()
  const { isTouch } = useDevice()
  const [collapsed, setCollapsed] = useState(!isStalled)
  // DnD-переупорядочивание: индекс перетаскиваемой строки и строка-цель
  // (для лёгкого индикатора места вставки).
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  if (pending.length === 0 && !isStalled) return null

  /**
   * Перетаскивание доступно только на точном указателе (на тач — как в
   * деревьях, DnD выключен, ADR-044) и когда у **всех** строк есть серверный
   * id: адресация перестановки — по id, строка без него непереставляема.
   * Неподтверждённая (`sending`) строка тоже блокирует перестановку.
   */
  const canReorder =
    !!onReorder && !isTouch && pending.length > 1
    && pending.every((msg) => !!msg.id && !msg.sending)

  const finishDrag = () => {
    setDragIndex(null)
    setOverIndex(null)
  }

  const handleDragStart = (event: DragEvent<HTMLDivElement>, index: number) => {
    if (!canReorder) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    // Safari требует непустой payload, иначе drag не стартует.
    event.dataTransfer.setData('text/plain', String(index))
    setDragIndex(index)
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>, index: number) => {
    if (!canReorder || dragIndex === null) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (index !== overIndex) setOverIndex(index)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>, index: number) => {
    if (!canReorder || dragIndex === null) return
    event.preventDefault()
    const from = dragIndex
    finishDrag()
    if (from === index) return
    const next = pending.map((msg) => msg.id!)
    const [moved] = next.splice(from, 1)
    if (moved === undefined) return
    next.splice(index, 0, moved)
    onReorder?.(next)
  }

  const borderClass = isStalled
    ? 'border-status-warning/20'
    : 'border-border/60'
  const bgClass = isStalled
    ? 'bg-status-warning/5'
    : 'bg-surface-inset'

  return (
    <div className={cn('shrink-0 mx-auto w-4/5 rounded-lg border', borderClass, bgClass)}>
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          data-testid="queue-header-toggle"
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors pointer-coarse:min-h-10"
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
          <span
            className={cn('truncate', isStalled && 'text-status-warning')}
            data-testid="queue-header-count"
          >
            {isStalled
              ? t('chat.queue.stalled', { count: String(pendingCount) })
              : t('chat.queue.pending', { count: String(pending.length) })}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {isStalled && (
            <button
              onClick={onResume}
              className="rounded px-2 py-0.5 text-[0.6875rem] font-medium bg-status-warning/20 text-status-warning hover:bg-status-warning/30 transition-colors pointer-coarse:min-h-10"
            >
              {t('chat.queue.resume')}
            </button>
          )}
          <button
            onClick={onReturnAll}
            className="rounded px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors pointer-coarse:min-h-10"
          >
            {t('chat.queue.return')}
          </button>
          <button
            onClick={onClear}
            className="rounded px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors pointer-coarse:min-h-10"
          >
            {t('chat.queue.clear')}
          </button>
        </div>
      </div>

      {!collapsed && pending.length > 0 && (
        <div className="px-3 pb-2 space-y-1">
          {pending.map((msg, i) => {
            const attachmentCount = msg.attachmentCount ?? 0
            const preview = firstLineOf(msg.content)
            return (
              <div
                key={msg.id ?? `q-${i}`}
                data-testid={`queue-item-${i}`}
                data-drop-target={overIndex === i && dragIndex !== null ? 'true' : undefined}
                draggable={canReorder}
                onDragStart={(event) => handleDragStart(event, i)}
                onDragOver={(event) => handleDragOver(event, i)}
                onDrop={(event) => handleDrop(event, i)}
                onDragEnd={finishDrag}
                className={cn(
                  'flex items-center gap-2 px-2 py-1 rounded text-xs border',
                  isStalled
                    ? 'bg-status-warning/10 border-status-warning/10'
                    : 'bg-surface-card border-border/20',
                  // Лёгкий индикатор места вставки: подсветка строки-цели.
                  overIndex === i && dragIndex !== null && dragIndex !== i
                    && 'ring-1 ring-inset ring-primary/50',
                  canReorder && 'cursor-grab active:cursor-grabbing',
                )}
              >
                <span className="text-muted-foreground shrink-0">
                  {msg.agentRole ? `@${msg.agentRole}` : `#${i + 1}`}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground/80" title={preview}>
                  {preview}
                </span>
                {msg.status && (
                  <span
                    data-testid={`queue-status-${i}`}
                    className={cn(
                      'shrink-0 rounded px-1 py-0.5 text-[0.625rem] leading-none',
                      msg.status === 'starting'
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground',
                    )}
                  >
                    {msg.status === 'starting'
                      ? t('chat.queue.itemStarting')
                      : t('chat.queue.itemQueued')}
                  </span>
                )}
                {attachmentCount > 0 && (
                  <span
                    data-testid={`queue-attachments-${i}`}
                    title={t('chat.attachments.added', { count: attachmentCount })}
                    aria-label={t('chat.attachments.added', { count: attachmentCount })}
                    className="flex shrink-0 items-center gap-0.5 text-muted-foreground"
                  >
                    <Icon name="attachment-2" className="size-3" />
                    {attachmentCount}
                  </span>
                )}
                <div className="flex shrink-0 items-center gap-0.5">
                  {msg.sending ? (
                    // Оптимистичная строка: серверное подтверждение ещё не пришло.
                    // Действия очереди (steer/возврат/удаление) требуют серверного
                    // id — до подтверждения они недоступны.
                    <span
                      data-testid={`queue-sending-${i}`}
                      title={t('chat.message.unconfirmed')}
                      aria-label={t('chat.message.unconfirmed')}
                      className="flex items-center text-muted-foreground"
                    >
                      <Icon name="loader-2" className="size-3.5 animate-spin" />
                    </span>
                  ) : (
                    <>
                  {canSteer && (
                    <button
                      onClick={() => onSteerMsg(i)}
                      data-testid={`queue-steer-${i}`}
                      title={t('chat.queue.steer')}
                      aria-label={t('chat.queue.steer')}
                      className={ROW_ACTION_CLASS}
                    >
                      <Icon name="send-plane" className="size-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => onReturnMsg(i)}
                    data-testid={`queue-return-${i}`}
                    title={t('chat.queue.return')}
                    aria-label={t('chat.queue.return')}
                    className={ROW_ACTION_CLASS}
                  >
                    <Icon name="edit-2" className="size-3.5" />
                  </button>
                  <button
                    onClick={() => onRemoveMsg(i)}
                    data-testid={`queue-remove-${i}`}
                    title={t('chat.queue.remove')}
                    aria-label={t('chat.queue.remove')}
                    className={cn(ROW_ACTION_CLASS, 'hover:text-destructive hover:bg-destructive/10')}
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
