import { Icon } from '../icon/Icon'
import type { MessageData } from '@/stores/chatStore'

interface MessageHeaderProps {
  message: MessageData
}

export function MessageHeader({ message }: MessageHeaderProps) {
  const time = message.timestamp || message.created_at
  const formatted = time
    ? new Date(time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : ''

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 mb-1">
      {message.agent_role && (
        <span className="inline-flex items-center gap-0.5 rounded-sm bg-primary/10 px-1.5 py-0.5 text-primary">
          <Icon name="user-smile" className="size-3" />
          <span>{message.agent_role}</span>
        </span>
      )}

      {message.model && (
        <span className="inline-flex items-center gap-0.5 rounded-sm bg-muted px-1.5 py-0.5">
          <Icon name="cpu" className="size-3" />
          <span>{message.model}</span>
        </span>
      )}

      {formatted && (
        <span className="ml-auto tabular-nums">{formatted}</span>
      )}
    </div>
  )
}
