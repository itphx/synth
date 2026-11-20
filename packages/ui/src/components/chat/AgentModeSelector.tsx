import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useAgentsStore } from '@/stores/agentsStore'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { useUIStore } from '@/stores/useUIStore'
import { synthApi } from '@/lib/api/synthApi'
import { resolveColor } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { ScrollableOverlay } from '../ui/ScrollableOverlay'
import { MobileMenuSheet, blurActiveElement } from '../ui/MobileMenuSheet'
import { Divider } from '../ui/Divider'

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
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const sheetScrollRef = useRef<HTMLElement | null>(null)

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

  /** Один путь закрытия: пункт/Escape/тап вне — сбрасываем и поиск. */
  const closeMenu = useCallback(() => {
    setOpen(false)
    setSearchQuery('')
  }, [])

  const selectAgent = (agentId: string) => {
    setActiveAgentId(agentId)
    synthApi.updateSession(sessionId, { settings: { agentRole: agentId } }).catch(() => {})
    closeMenu()
  }

  const showResetToDefault = !searchQuery.trim() && defaultAgent && activeAgentId !== defaultAgent.id

  /**
   * Шапка с поиском — общая для дропдауна и мобильной панели.
   * На мобильном поиск не автофокусится: фокус поднял бы клавиатуру сразу
   * поверх только что открытой панели.
   */
  const searchHeader = (
    <div className="p-2">
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
  )

  /** «Сбросить на умолчание»: пункт Radix на десктопе, кнопка — в панели. */
  const renderResetItem = (inSheet: boolean) => {
    if (!defaultAgent || !showResetToDefault) return null
    const className =
      'text-xs flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-interactive-hover data-[highlighted]:bg-interactive-selection outline-none w-full text-left'
    const content = (
      <>
        <Icon name="arrow-go-back" className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{t('chat.modelControls.resetToDefault')}</span>
      </>
    )
    const onSelect = () => selectAgent(defaultAgent.id)
    return inSheet ? (
      <button type="button" role="menuitem" onClick={onSelect} className={className}>
        {content}
      </button>
    ) : (
      <DropdownMenu.Item onClick={onSelect} className={className}>
        {content}
      </DropdownMenu.Item>
    )
  }

  const resetItemSheet = renderResetItem(true)
  const resetItemDropdown = renderResetItem(false)

  /**
   * Список агентов. На десктопе пункты — `DropdownMenu.Item` (клавиатурная
   * навигация Radix), в мобильной панели — обычные кнопки `role="menuitem"`:
   * пункт Radix вне своего `Root` не рендерится.
   */
  const renderAgentItem = (agent: (typeof agents)[number], inSheet: boolean) => {
    const disabled = !agent.available
    const className = `text-xs group flex flex-col gap-0.5 px-2 py-1.5 rounded-lg outline-none text-left w-full ${
      disabled
        ? 'opacity-40 cursor-not-allowed'
        : 'cursor-pointer hover:bg-interactive-hover data-[highlighted]:bg-interactive-selection data-[highlighted]:text-foreground'
    }`
    const content = (
      <>
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
      </>
    )
    const select = () => {
      if (disabled) return
      selectAgent(agent.id)
    }
    const node = inSheet ? (
      <button key={agent.id} type="button" role="menuitem" disabled={disabled} onClick={select} className={className}>
        {content}
      </button>
    ) : (
      <DropdownMenu.Item key={agent.id} disabled={disabled} onClick={select} className={className}>
        {content}
      </DropdownMenu.Item>
    )
    return disabled ? (
      <div key={agent.id} title={t('chat.modelControls.agentProjectOnly')}>
        {node}
      </div>
    ) : (
      node
    )
  }

  const emptyRow = filtered.length === 0 ? (
    <div className="px-2 py-4 text-center text-xs text-muted-foreground">
      {t('chat.modelControls.noAgentsFound')}
    </div>
  ) : null

  const triggerInner = (
    <>
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
    </>
  )

  /**
   * Мобильная зона (телефон/планшет и узкая центральная колонка — `centralNarrow`):
   * вместо Radix-поппера `side="top"` — общая фиксированная панель, прижатая к
   * верху композера. Иначе список открывался только вверх, верхние пункты уходили
   * за край экрана, а внутреннего скролла у поппера нет. Для `centralNarrow` —
   * осознанно: в узком столбце поппер тоже перекрывает поле ввода.
   */
  if (isMobile) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          className="model-selector-trigger flex shrink-0 items-center gap-1.5 cursor-pointer hover:opacity-70 min-w-0"
          aria-label={activeAgent?.display_name || activeAgentId || t('chat.modelControls.searchAgents')}
          aria-haspopup="menu"
          aria-expanded={open}
          // Blur на pointerdown (раньше click): клавиатура скрывается до
          // открытия панели, поэтому её позиция считается по итоговому layout.
          onPointerDown={blurActiveElement}
          onClick={() => setOpen((prev) => !prev)}
        >
          {triggerInner}
        </button>
        <MobileMenuSheet
          open={open}
          onClose={closeMenu}
          anchorRef={triggerRef}
          ariaLabel={t('chat.modelControls.searchAgents')}
          scrollRef={sheetScrollRef}
          scrollClassName="p-1"
          header={
            <>
              {searchHeader}
              <Divider inset tone="raised" />
            </>
          }
        >
          {resetItemSheet}
          {resetItemSheet && <Divider tone="raised" className="mx-2 my-1" />}
          {emptyRow}
          {filtered.map((agent) => renderAgentItem(agent, true))}
        </MobileMenuSheet>
      </>
    )
  }

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className="model-selector-trigger flex shrink-0 items-center gap-1.5 cursor-pointer hover:opacity-70 min-w-0"
          aria-label={activeAgent?.display_name || activeAgentId || t('chat.modelControls.searchAgents')}
        >
          {triggerInner}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          sideOffset={4}
          className="w-[min(280px,calc(100vw-2rem))] p-0 flex flex-col bg-popover text-popover-foreground rounded-xl ring-1 ring-foreground/10 shadow-lg z-50"
          align="end"
          alignOffset={-40}
          collisionPadding={8}
        >
          {searchHeader}

          <Divider inset tone="raised" />

          <ScrollableOverlay
            outerClassName="max-h-[min(800px,calc(100dvh-12rem))] flex-1"
            className="p-1"
          >
            {resetItemDropdown}
            {resetItemDropdown && <Divider tone="raised" className="mx-2 my-1" />}

            {emptyRow}

            {filtered.map((agent) => renderAgentItem(agent, false))}
          </ScrollableOverlay>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
