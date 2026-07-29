import { Icon } from '../icon/Icon'
import { memo } from 'react'
import type { MessageData } from '@/stores/chatStore'
import { useAuthStore } from '@/stores/authStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { ProviderIcon } from '@/components/admin/ProviderIcon'
import { resolveColor } from '@/lib/utils'

interface MessageHeaderProps {
  message: MessageData
  /** true если сессия — дочерняя (сабагент) */
  isSubagent?: boolean
  /** Клик по origin-бейджу — открыть родительскую сессию */
  onOriginClick?: () => void
}

function resolveAuthor(): string {
  const { user, profile } = useAuthStore.getState()
  return profile?.display_name || user?.username || ''
}

function MessageHeaderInner({ message, isSubagent, onOriginClick }: MessageHeaderProps) {
  const time = message.timestamp || message.created_at
  const formatted = time
    ? new Date(time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : ''

  const isUser = message.role === 'user'
  const isSummary = message.role === 'summary'

  const agents = useAgentsStore((s) => s.agents)
  const providers = useProvidersStore((s) => s.providers)

  const agentInfo = message.agent_role
    ? agents.find((a) => a.id === message.agent_role)
    : undefined
  const agentColor = resolveColor(agentInfo?.color ?? null)

  const providerIcon = message.provider
    ? providers.find((p) => p.name === message.provider)?.icon || ''
    : ''
  const providerUrl = message.provider
    ? providers.find((p) => p.name === message.provider)?.url
    : undefined

  const isInherited = message.origin === 'inherited'

  // В дочерних сессиях (сабагент):
  //   inherited user     → userBadge  (сообщение написал пользователь в родительской сессии)
  //   inherited assistant → agentBadge (ответ написал агент в родительской сессии)
  //   local сообщения    → agentBadge (промпт/ответ сабагента — от агента)
  // В основных сессиях:
  //   user      → userBadge
  //   assistant → agentBadge
  //   summary   → summary badge
  const showUserBadge = isSubagent ? (isInherited && isUser) : isUser
  const showAgentBadge = !isSummary && !!message.agent_role && (
    isSubagent
      ? (isInherited ? !isUser : true)     // сабагент: inherited-ассистент или любое local
      : !isUser                              // основная сессия: не-user → agentBadge
  )
  const agentBadge = showAgentBadge && (
    agentInfo ? (
      <span
        className={`inline-flex items-center gap-1 rounded-sm py-0.5 ${agentColor ? '' : 'text-primary'}`}
        style={agentColor ? { color: agentColor } : undefined}
      >
        <Icon name={agentInfo.icon || 'user-smile'} className="size-3" />
        <span>{agentInfo.display_name || message.agent_role}</span>
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 rounded-sm py-0.5 text-primary">
        <Icon name="user-smile" className="size-3" />
        <span>{message.agent_role}</span>
      </span>
    )
  )

  const userBadge = showUserBadge && (
    <span className="inline-flex items-center gap-1 rounded-sm py-0.5 text-primary">
      <Icon name="user-3" className="size-3" />
      <span>{resolveAuthor()}</span>
    </span>
  )

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 mb-1">
      {userBadge}
      {agentBadge}

      {isSummary && (
        <span className="inline-flex items-center gap-1 rounded-sm py-0.5 text-primary">
          <Icon name="subtract" className="size-3" />
          <span>Summary</span>
        </span>
      )}

      {!isUser && message.model && (
        <span className="inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5">
          <ProviderIcon icon={providerIcon} baseUrl={providerUrl} size={12} className="shrink-0" />
          <span>{message.model}</span>
        </span>
      )}

      {formatted || (message.origin === 'merged' || message.origin === 'crosspost') ? (
        <span className="ml-auto inline-flex items-center gap-1">
          {(message.origin === 'merged' || message.origin === 'crosspost') && (
            <button
              title={message.source_msg_id ? `Из сообщения ${message.source_msg_id.slice(0, 8)}...` : undefined}
              onClick={onOriginClick}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] cursor-pointer hover:opacity-80 transition-opacity ${
                message.origin === 'merged' ? 'bg-purple-500/10 text-purple-600' :
                'bg-teal-500/10 text-teal-600'
              }`}
            >
              <Icon
                name={message.origin === 'merged' ? 'links-line' : 'link'}
                className="h-2.5 w-2.5"
              />
              {message.origin === 'merged' ? 'Скопировано' : 'Связано'}
            </button>
          )}
          {formatted && (
            <span className="tabular-nums">{formatted}</span>
          )}
        </span>
      ) : null}
    </div>
  )
}

export const MessageHeader = memo(MessageHeaderInner);
