import { Icon } from '../icon/Icon'
import { memo } from 'react'
import type { MessageData } from '@/stores/chatStore'
import { useAuthStore } from '@/stores/authStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { ProviderIcon } from '@/components/admin/ProviderIcon'

interface MessageHeaderProps {
  message: MessageData
}

function resolveColor(cssVar: string | null): string | undefined {
  if (!cssVar) return undefined
  if (cssVar.startsWith('--')) {
    return `var(${cssVar})`
  }
  return cssVar
}

function resolveAuthor(): string {
  const { user, profile } = useAuthStore.getState()
  return profile?.display_name || user?.username || ''
}

function MessageHeaderInner({ message }: MessageHeaderProps) {
  const time = message.timestamp || message.created_at
  const formatted = time
    ? new Date(time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : ''

  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
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

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 mb-1">
      {isUser && (
        <span className="inline-flex items-center gap-1 rounded-sm py-0.5 text-primary">
          <Icon name="brain" className="size-3" />
          <span>{resolveAuthor()}</span>
        </span>
      )}

      {isSummary && (
        <span className="inline-flex items-center gap-1 rounded-sm py-0.5 text-primary">
          <Icon name="subtract" className="size-3" />
          <span>Summary</span>
        </span>
      )}

      {!isUser && !isSummary && message.agent_role && (
        isAssistant && agentInfo ? (
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
      )}

      {!isUser && message.model && (
        <span className="inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5">
          <ProviderIcon icon={providerIcon} baseUrl={providerUrl} size={12} className="shrink-0" />
          <span>{message.model}</span>
        </span>
      )}

      {formatted && (
        <span className="ml-auto tabular-nums">{formatted}</span>
      )}
    </div>
  )
}

export const MessageHeader = memo(MessageHeaderInner);
