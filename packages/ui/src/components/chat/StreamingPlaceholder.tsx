import { cn, resolveColor } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { useAgentsStore } from '@/stores/agentsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { ProviderIcon } from '@/components/admin/ProviderIcon'
import { ReasoningBlock } from './ReasoningBlock'
import { MarkdownContent } from './MarkdownContent'
import { useI18n } from '@/lib/i18n'
import type { StreamState } from '@/stores/chatStore'

interface StreamingPlaceholderProps {
  stream: StreamState
  onStop: () => void
}

export function StreamingPlaceholder({ stream, onStop }: StreamingPlaceholderProps) {
  const agents = useAgentsStore((s) => s.agents)
  const providers = useProvidersStore((s) => s.providers)
  const { t } = useI18n()

  const isSummary = stream.agentRole === 'summary'
  const isDebug = stream.agentRole === 'debug'

  const agentInfo = !isSummary && !isDebug && stream.agentRole
    ? agents.find((a) => a.id === stream.agentRole)
    : undefined
  const agentColor = resolveColor(agentInfo?.color ?? null)

  const providerIcon = stream.provider
    ? providers.find((p) => p.name === stream.provider)?.icon || ''
    : ''
  const providerUrl = stream.provider
    ? providers.find((p) => p.name === stream.provider)?.url
    : undefined

  return (
    <div className={cn(
      'flex flex-col px-4 py-3 group',
      (isSummary || isDebug) ? 'items-center' : 'items-start',
    )}>
      <div className={cn(
        'max-w-[85%] rounded-lg px-4 py-3 text-foreground',
        isSummary
          ? 'bg-yellow-500/5 border border-yellow-500/20'
          : isDebug
            ? 'bg-amber-500/5 border border-amber-500/30 text-amber-600 dark:text-amber-400'
            : 'bg-card border border-border/50 rounded-bl-sm',
      )}>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 mb-1">
          {isSummary && (
            <span className="inline-flex items-center gap-1 rounded-sm py-0.5 text-primary">
              <Icon name="subtract" className="size-3" />
              <span>Summary</span>
            </span>
          )}

          {isDebug && (
            <span className="inline-flex items-center gap-1 rounded-sm py-0.5 text-amber-600 dark:text-amber-400">
              <Icon name="laptop" className="size-3" />
              <span>Debug</span>
            </span>
          )}

          {!isSummary && !isDebug && stream.agentRole && (
            <span
              className={`inline-flex items-center gap-1 rounded-sm py-0.5 ${agentColor ? '' : 'text-primary'}`}
              style={agentColor ? { color: agentColor } : undefined}
            >
              <Icon name={agentInfo?.icon || 'user-smile'} className="size-3" />
              <span>{agentInfo?.display_name || stream.agentRole}</span>
            </span>
          )}

          {stream.model && (
            <span className="inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5">
              <ProviderIcon icon={providerIcon} baseUrl={providerUrl} size={12} className="shrink-0" />
              <span>{stream.model}</span>
            </span>
          )}

          <span className="ml-auto inline-flex gap-0.5">
            <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
          </span>
        </div>

        {stream.reasoning && (
          <ReasoningBlock reasoning={stream.reasoning} />
        )}

        {stream.content && (
          <MarkdownContent content={stream.content} />
        )}

        {stream.isStreaming && (
          <div className="flex items-center gap-0.5 mt-2 pt-1.5 border-t border-border/30">
            <button
              onClick={onStop}
              title={t('chat.input.stop')}
              className="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Icon name="stop" className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
