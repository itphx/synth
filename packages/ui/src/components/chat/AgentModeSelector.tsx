import { useState, useEffect, useMemo } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useAgentsStore } from '@/stores/agentsStore'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { useUIStore } from '@/stores/useUIStore'
import { synthApi } from '@/lib/api/synthApi'
import { resolveColor } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { ScrollableOverlay } from '../ui/ScrollableOverlay'

interface AgentModeSelectorProps {
  sessionId: string
}

export function AgentModeSelector({ sessionId }: AgentModeSelectorProps) {
  const agents = useAgentsStore(s => s.agents)
  const activeAgentId = useAgentsStore(s => s.activeAgentId)
  const defaultAgentId = useAgentsStore(s => s.defaultAgentId)
  const setActiveAgentId = useAgentsStore(s => s.setActiveAgentId)
  const loadAgents = useAgentsStore(s => s.loadAgents)
  const { t } = useI18n()
  const { deviceType } = useDevice()
  const centralNarrow = useUIStore((s) => s.centralNarrow)
  const isMobile = deviceType !== 'desktop' || centralNarrow
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    loadAgents(sessionId)
  }, [sessionId])

  const activeAgent = agents.find((a) => a.id === activeAgentId)
  const defaultAgent = agents.find((a) => a.id === defaultAgentId)

  const sortedAgents = useMemo(() => {
    const list = [...agents]
    const assistantIdx = list.findIndex((a) => a.id === 'assistant')
    if (assistantIdx > -1) {
      const [assistant] = list.splice(assistantIdx, 1)
      list.unshift(assistant)
    }
    return list
  }, [agents])

  const filtered = searchQuery.trim()
    ? sortedAgents.filter((a) => {
        const q = searchQuery.toLowerCase()
        return (
          a.agent_mode == null || a.agent_mode.includes('primary')
        ) && (
          a.display_name.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          (a.description && a.description.toLowerCase().includes(q))
        )
      })
    : sortedAgents.filter((a) => a.agent_mode == null || a.agent_mode.includes('primary'))

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className="model-selector-trigger flex shrink-0 items-center gap-1.5 cursor-pointer hover:opacity-70 min-w-0"
          aria-label={activeAgent?.display_name || activeAgentId || t('chat.modelControls.searchAgents')}
        >
          {activeAgent?.icon ? (
            <Icon
              name={activeAgent.icon}
              className="size-3.5 shrink-0"
              style={activeAgent.color ? { color: resolveColor(activeAgent.color) } : undefined}
            />
          ) : (
            <div
              className="h-2 w-2 rounded-full shrink-0"
              style={activeAgent?.color ? { backgroundColor: resolveColor(activeAgent.color) } : undefined}
            />
          )}
          {!isMobile && (
            <span
              className={`font-medium text-xs whitespace-nowrap max-w-[12.5rem] truncate ${activeAgent?.color ? '' : 'text-foreground'}`}
              style={activeAgent?.color ? { color: resolveColor(activeAgent.color) } : undefined}
            >
              {activeAgent?.display_name || activeAgentId || 'Agent'}
            </span>
          )}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          sideOffset={4}
          className="w-[min(280px,calc(100vw-2rem))] p-0 flex flex-col bg-popover text-popover-foreground border border-border rounded-lg shadow-lg z-50"
          align="end"
          alignOffset={-40}
          collisionPadding={8}
        >
          <div className="p-2 border-b border-border/40">
            <div className="relative">
              <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder={t('chat.modelControls.searchAgents')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 w-full text-xs bg-background border border-border rounded-md px-2 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                autoFocus={!isMobile}
              />
            </div>
          </div>

          <ScrollableOverlay
            outerClassName="max-h-[min(800px,calc(100dvh-12rem))] flex-1"
            className="p-1"
          >
            {!searchQuery.trim() && defaultAgent && activeAgentId !== defaultAgent.id && (
              <>
                <DropdownMenu.Item
                  onClick={() => {
                    setActiveAgentId(defaultAgent.id)
                    synthApi.updateSession(sessionId, { settings: { agentRole: defaultAgent.id } }).catch(() => {})
                    setOpen(false)
                    setSearchQuery('')
                  }}
                  className="text-xs flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer hover:bg-interactive-hover data-[highlighted]:bg-interactive-selection outline-none"
                >
                  <Icon name="arrow-go-back" className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{t('chat.modelControls.resetToDefault')}</span>
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 border-t border-border/30" />
              </>
            )}

            {filtered.length === 0 && (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                {t('chat.modelControls.noAgentsFound')}
              </div>
            )}

            {filtered.map((agent) => {
              const disabled = !agent.available
              const item = (
                <DropdownMenu.Item
                  key={agent.id}
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return
                    setActiveAgentId(agent.id)
                    synthApi.updateSession(sessionId, { settings: { agentRole: agent.id } }).catch(() => {})
                    setOpen(false)
                    setSearchQuery('')
                  }}
                  className={`text-xs group flex flex-col gap-0.5 px-2 py-1.5 rounded-md outline-none ${
                    disabled
                      ? 'opacity-40 cursor-not-allowed'
                      : 'cursor-pointer hover:bg-interactive-hover data-[highlighted]:bg-interactive-selection data-[highlighted]:text-foreground'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {agent.icon ? (
                      <Icon
                        name={agent.icon}
                        className="h-3.5 w-3.5 shrink-0"
                        style={agent.color ? { color: resolveColor(agent.color) } : undefined}
                      />
                    ) : (
                      <div
                        className="h-1 w-1 rounded-full shrink-0"
                        style={agent.color ? { backgroundColor: resolveColor(agent.color) } : undefined}
                      />
                    )}
                    <span className="font-medium truncate">{agent.display_name}</span>
                    {activeAgentId === agent.id && (
                      <Icon name="check" className="h-3.5 w-3.5 text-primary shrink-0" />
                    )}
                  </div>
                  {agent.description && (
                    <span className="text-[0.625rem] text-muted-foreground max-w-[12.5rem] ml-[1.375rem] break-words leading-tight">
                      {agent.description}
                    </span>
                  )}
                </DropdownMenu.Item>
              )
              return disabled ? (
                <div key={agent.id} title={t('chat.modelControls.agentProjectOnly')}>
                  {item}
                </div>
              ) : (
                item
              )
            })}
          </ScrollableOverlay>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
