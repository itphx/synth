import { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { useChatStore } from '@/stores/chatStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProvidersStore } from '@/stores/providersStore'
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
  const sessionId = activeTab?.data?.sessionId

  const { messagesBySession } = useChatStore()
  const sessions = useSessionsStore((s) => s.sessions)
  const { selectedModelName, models: providersModels } = useProvidersStore()

  const activeSession = sessionId ? sessions.find((s) => s.id === sessionId) : undefined
  const sessionModelId = (activeSession?.settings as Record<string, unknown>)?.model as string | undefined
  const effectiveModel = sessionModelId || selectedModelName

  const contextWindow = useMemo(() => {
    const m = providersModels.find((m) => m.id === effectiveModel || m.name === effectiveModel)
    return m?.context_window ?? 200_000
  }, [providersModels, effectiveModel])

  const lastInputTokens = useMemo(() => {
    const msgs = sessionId ? messagesBySession[sessionId] || [] : []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!
      if (m.role === 'assistant' && !m.disabled && !m.hidden) {
        return m.usage?.input_tokens ?? 0
      }
    }
    return 0
  }, [messagesBySession, sessionId])

  const windowPercent = contextWindow > 0 ? Math.round((lastInputTokens / contextWindow) * 100) : 0
  const [summarizing, setSummarizing] = useState(false)

  const canSummarize = useMemo(() => {
    const msgs = sessionId ? messagesBySession[sessionId] || [] : []
    const active = msgs.filter((m) => !m.disabled && !m.hidden && m.role !== 'info' && m.role !== 'summary')
    if (active.length < 3) return false
    const lastSummaryIdx = active.reduceRight(
      (lastIdx, m, i) => (lastIdx >= 0 ? lastIdx : (m.role === 'summary' ? i : -1)), -1,
    )
    if (lastSummaryIdx < 0) return true
    const activeAfter = active.slice(lastSummaryIdx + 1).filter(
      (m) => m.role !== 'summary',
    )
    return activeAfter.length >= 3
  }, [messagesBySession, sessionId])

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

  const handleSummarize = useCallback(async () => {
    if (!activeTab?.data?.sessionId) return
    const sid = activeTab.data.sessionId
    setSummarizing(true)
    notify({ text: t('rightPanel.context.summarizationStarted'), type: 'info', category: 'queue', sessionId: sid })
    try {
      const body = await synthApi.summarizeSessionStream(sid)
      if (!body) throw new Error('No response body')
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const streamId = `summary-${sid}`
      const store = useChatStore.getState()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.type === 'chunk') {
              const s = useChatStore.getState()
              if (!s.streamingBySession[sid]?.[streamId]) {
                s.startStream(sid, streamId, 'summary', parsed.model || undefined, parsed.provider || undefined)
              }
              s.updateStreamChunk(sid, streamId, parsed.content || '', '', parsed.model || undefined, parsed.provider || undefined)
            } else if (parsed.type === 'done') {
              const s = useChatStore.getState()
              const streamState = s.streamingBySession[sid]?.[streamId]
              const content = parsed.content || streamState?.content || ''
              const model = parsed.model || undefined
              const provider = parsed.provider || undefined
              const usage = parsed.usage

              // Remove stream state
              useChatStore.setState((st) => {
                const sessionStreams = { ...(st.streamingBySession[sid] || {}) }
                delete sessionStreams[streamId]
                return { streamingBySession: { ...st.streamingBySession, [sid]: sessionStreams } }
              })

              // Add summary message
              const msgs = s.messagesBySession[sid] || []
              const newMsg = {
                index: msgs.length > 0 ? Math.max(...msgs.map((m) => m.index)) + 1 : 0,
                role: 'summary',
                content,
                model: model || null,
                provider: provider || null,
                usage: usage ? { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, total_tokens: usage.total_tokens || 0 } : null,
                disabled: false,
                pinned: false,
                hidden: false,
                created_at: new Date().toISOString(),
              }
              useChatStore.getState().addMessage(sid, newMsg)

              // Disable summarized messages
              if (Array.isArray(parsed.indices)) {
                const u = useChatStore.getState()
                for (const idx of parsed.indices) {
                  u.updateMessage(sid, idx, { disabled: true })
                }
              }
            }
          } catch { /* skip malformed */ }
        }
      }
      notify({ text: t('rightPanel.context.summarized'), type: 'success', category: 'queue', sessionId: sid })
    } catch {
      notify({ text: t('rightPanel.context.summarizeError'), type: 'error', category: 'error', sessionId: activeTab.data.sessionId })
    } finally {
      setSummarizing(false)
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
        <>
          <div
            className="ml-1 flex shrink-0 items-center gap-1"
            title={`${lastInputTokens.toLocaleString()} / ${contextWindow.toLocaleString()}`}
          >
            <div className="h-1.5 w-12 rounded-full bg-foreground/10 overflow-hidden">
              <div
                className="h-1.5 rounded-full bg-primary transition-all"
                style={{ width: `${Math.min(windowPercent, 100)}%` }}
              />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">{windowPercent}%</span>
          </div>
          <button
            onClick={handleSummarize}
            disabled={!canSummarize || summarizing}
            title={canSummarize ? t('rightPanel.context.summarizeNow') : t('rightPanel.context.notEnoughMessages')}
            className={cn(
              'ml-1.5 shrink-0 rounded p-1 transition-colors',
              canSummarize && !summarizing
                ? 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover'
                : 'text-muted-foreground opacity-30 cursor-default',
            )}
          >
            <Icon name="subtract" className="size-3.5 text-amber-400" />
          </button>
          <button
            onClick={handleClearSession}
            title={t('leftPanel.clearSession')}
            className="ml-0.5 shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
          >
            <Icon name="close" className="size-3.5 text-destructive" />
          </button>
        </>
      )}
    </div>
  )
}
