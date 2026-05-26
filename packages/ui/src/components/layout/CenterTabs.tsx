import { useRef, useEffect, useCallback } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { useChatStore } from '@/stores/chatStore'
import { synthApi } from '@/lib/api/synthApi'
import { useNotification } from '@/hooks/useNotification'

const TAB_ICONS: Record<CenterTab['type'], string> = {
  chat: 'chat-new',
  'file-viewer': 'file-3',
  'file-editor': 'edit-2',
}

export function CenterTabs() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const { centerTabs, activeCenterTabId, setActiveCenterTab, closeTab } = useUIStore()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (activeCenterTabId && scrollRef.current) {
      const el = scrollRef.current.querySelector(`[data-tab-id="${activeCenterTabId}"]`)
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }
  }, [activeCenterTabId])

  const activeTab = centerTabs.find((t) => t.id === activeCenterTabId)
  const isChatTab = activeTab?.type === 'chat'

  const handleClearSession = useCallback(async () => {
    if (!activeTab?.data?.sessionId) return
    const sessionId = activeTab.data.sessionId
    if (!window.confirm(t('leftPanel.confirmClearSession'))) return
    try {
      await synthApi.clearSession(sessionId)
      useChatStore.getState().clearSession(sessionId)
      const result = await synthApi.getSessionMessages(sessionId)
      useChatStore.getState().setMessages(sessionId, result.messages)
      notify({ text: t('chat.session.cleared'), type: 'success', category: 'queue', sessionId })
    } catch {
      notify({ text: t('chat.error.clearSession'), type: 'error', category: 'error', sessionId: activeTab.data.sessionId })
    }
  }, [activeTab, notify, t])

  if (centerTabs.length === 0) {
    return null
  }

  return (
    <div className="flex shrink-0 items-center border-b border-border bg-background px-1">
      <div
        ref={scrollRef}
        className="flex flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none"
      >
        {centerTabs.map((tab) => {
          const isActive = tab.id === activeCenterTabId
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={`group flex shrink-0 items-center gap-1.5 rounded-t-md px-3 py-1.5 cursor-pointer transition-colors select-none ${
                isActive
                  ? 'bg-card text-foreground border-x border-t border-border'
                  : 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover'
              }`}
              onClick={() => setActiveCenterTab(tab.id)}
            >
              <Icon name={TAB_ICONS[tab.type]} className="size-4 shrink-0" />
              <span className="text-xs font-medium truncate max-w-[140px]">{tab.title}</span>
              <button
                className="ml-0.5 rounded-sm p-0.5 opacity-0 group-hover:opacity-100 hover:bg-interactive-hover transition-opacity shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
                title={t('center.closeTab')}
              >
                <Icon name="close" className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
      {isChatTab && (
        <button
          onClick={handleClearSession}
          title={t('leftPanel.clearSession')}
          className="ml-1 shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
        >
          <Icon name="close" className="size-3.5 text-destructive" />
        </button>
      )}
    </div>
  )
}
