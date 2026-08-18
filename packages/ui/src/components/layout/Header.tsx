import { useMemo, useCallback, useState, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '../../stores/useUIStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useChatStore } from '@/stores/chatStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { synthApi } from '@/lib/api/synthApi'
import { useNotification } from '@/hooks/useNotification'
import { useAuthStore } from '@/stores/authStore'
import { QuickSettingsPopup } from '../auth/QuickSettingsPopup'
import { NotificationPopup } from './NotificationPopup'
import { GlobalTransportIndicator } from './GlobalTransportIndicator'

interface HeaderProps {
  onSettingsClick: () => void
}

export const Header = ({ onSettingsClick }: HeaderProps) => {
  const { t } = useI18n()
  const { notify } = useNotification()
  const {
    leftPanel, rightPanel, toggleLeftPanel, toggleRightPanel,
    setSettingsDialogOpen, setLogsDialogOpen, centerTabs, activeCenterTabId,
    openTab, closeTab,
  } = useUIStore()
  const { user } = useAuthStore()
  const projects = useProjectsStore((s) => s.projects)

  const activeTab = centerTabs.find((tab) => tab.id === activeCenterTabId)

  const headerTitle = useMemo(() => {
    if (!activeTab?.data.projectId) return 'Synth'
    const project = projects.find((p) => p.id === activeTab.data.projectId)
    return project?.name || 'Synth'
  }, [activeTab, projects])

  const isChatTab = activeTab?.type === 'chat'
  const isFileViewer = activeTab?.type === 'file-viewer'
  const isFileEditor = activeTab?.type === 'file-editor'
  const isCommitDetail = activeTab?.type === 'commit-detail'

  // Chat tab context window calculation
  const { messagesBySession } = useChatStore()
  const sessions = useSessionsStore((s) => s.sessions)
  const { selectedModelName, models: providersModels } = useProvidersStore()
  const sessionId = activeTab?.data?.sessionId

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
  const canSummarize = activeSession?.can_summarize ?? false
  const isSubagentSession = activeSession?.session_origin === 'subagent'

  const handleClearSession = useCallback(async () => {
    if (!sessionId) return
    if (!window.confirm(t('leftPanel.confirmClearSession'))) return
    try {
      await synthApi.clearSession(sessionId)
      useChatStore.getState().clearSession(sessionId)
      const result = await synthApi.getSessionMessages(sessionId)
      useChatStore.getState().setMessages(sessionId, result.messages)
      notify({ text: t('chat.session.cleared'), type: 'success', category: 'queue', sessionId })
    } catch {
      notify({ text: t('chat.error.clearSession'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, notify, t])

  const handleSummarize = useCallback(async () => {
    if (!sessionId) return
    setSummarizing(true)
    try {
      await synthApi.summarizeSession(sessionId)
      notify({ text: t('rightPanel.context.summarizeEnqueued'), type: 'info', category: 'queue', sessionId })
    } catch (e) {
      notify({ text: `${t('rightPanel.context.summarizeError')}: ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
    } finally {
      setSummarizing(false)
    }
  }, [sessionId, notify, t])

  const handleFileEdit = useCallback(() => {
    if (!activeTab?.data.projectId || !activeTab?.data.filePath) return
    openTab({
      id: `edit-${activeTab.data.projectId}/${activeTab.data.filePath}`,
      type: 'file-editor',
      title: activeTab.title,
      data: { filePath: activeTab.data.filePath, projectId: activeTab.data.projectId },
    })
  }, [activeTab, openTab])

  const handleFileDownload = useCallback(() => {
    if (!activeTab?.data.projectId || !activeTab?.data.filePath) return
    const url = synthApi.downloadFile(activeTab.data.projectId, activeTab.data.filePath)
    const a = document.createElement('a')
    a.href = url
    a.download = activeTab.title
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [activeTab])

  // File editor state (from tab metadata)
  const editingState = activeTab?.editingState
  const isEditorDirty = editingState === 'dirty' || editingState === 'error'
  const isSaving = editingState === 'saving'

  const handleFileSave = useCallback(async () => {
    if (!activeTab?.data.projectId || !activeTab?.data.filePath || !isEditorDirty || isSaving) return
    // Trigger save via custom event – FileEditorTab listens for this
    window.dispatchEvent(new CustomEvent('synth:save-file', { detail: { tabId: activeTab.id } }))
  }, [activeTab, isEditorDirty, isSaving])

  const handleFileClose = useCallback(() => {
    if (activeTab) closeTab(activeTab.id)
  }, [activeTab, closeTab])

  const handleCommitCopy = useCallback(() => {
    if (activeTab?.data.commitHash) {
      navigator.clipboard.writeText(activeTab.data.commitHash)
      notify({ text: t('commit.copied'), type: 'info', category: 'connection' })
    }
  }, [activeTab, t, notify])

  const handleCommitClose = useCallback(() => {
    if (activeTab) closeTab(activeTab.id)
  }, [activeTab, closeTab])

  // ---- Selection mode & bulk operations (from ChatTab) ----
  const selectionState = useChatStore(s => sessionId ? s.selectionBySession[sessionId] : undefined)
  const selectionMode = selectionState?.mode ?? false
  const selectedIndices = selectionState?.indices ?? new Set<number>()
  const selectedCount = selectedIndices.size
  const sessionMessages = sessionId ? useChatStore.getState().messagesBySession[sessionId] || [] : []
  const totalMessageCount = sessionMessages.length

  const handleToggleSelectionMode = useCallback(() => {
    if (!sessionId) return
    useChatStore.getState().toggleSelectionMode(sessionId)
  }, [sessionId])

  const handleSelectAll = useCallback(() => {
    if (!sessionId) return
    useChatStore.getState().selectAllMessages(sessionId)
  }, [sessionId])

  const handleClearSelection = useCallback(() => {
    if (!sessionId) return
    useChatStore.getState().clearSelection(sessionId)
  }, [sessionId])

  const afterBulkReload = useCallback(async () => {
    if (!sessionId) return
    const result = await synthApi.getSessionMessages(sessionId)
    useChatStore.getState().setMessages(sessionId, result.messages)
    useChatStore.getState().clearSelection(sessionId)
  }, [sessionId])

  const handleBulkPin = useCallback(async () => {
    if (!sessionId) return
    const indices = [...selectedIndices]
    if (indices.length === 0) return
    // Determine target state: if ALL are pinned → unpin, else → pin
    const selectedMsgs = indices.map(i => sessionMessages[i]).filter(Boolean)
    const allPinned = selectedMsgs.length > 0 && selectedMsgs.every(m => m.pinned)
    const targetState = !allPinned
    try {
      await synthApi.batchMessages(sessionId, 'pin', indices, targetState)
      await afterBulkReload()
      notify({ text: targetState ? `Закреплено: ${indices.length}` : `Откреплено: ${indices.length}`, type: 'info', category: 'message', sessionId })
    } catch (e) {
      notify({ text: `Ошибка: ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, selectedIndices, sessionMessages, afterBulkReload, notify])

  const handleBulkToggle = useCallback(async () => {
    if (!sessionId) return
    const indices = [...selectedIndices]
    if (indices.length === 0) return
    // Determine target state: if ALL are disabled → enable, else → disable
    const selectedMsgs = indices.map(i => sessionMessages[i]).filter(Boolean)
    const allDisabled = selectedMsgs.length > 0 && selectedMsgs.every(m => m.disabled)
    const targetState = !allDisabled
    try {
      await synthApi.batchMessages(sessionId, 'toggle', indices, targetState)
      await afterBulkReload()
      notify({ text: targetState ? `Отключено: ${indices.length}` : `Включено: ${indices.length}`, type: 'info', category: 'message', sessionId })
    } catch (e) {
      notify({ text: `Ошибка: ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, selectedIndices, sessionMessages, afterBulkReload, notify])

  const handleBulkDelete = useCallback(async () => {
    if (!sessionId) return
    const indices = [...selectedIndices]
    if (indices.length === 0) return
    if (!window.confirm(`Удалить ${indices.length} сообщений?`)) return
    try {
      await synthApi.batchMessages(sessionId, 'delete', indices)
      await afterBulkReload()
      notify({ text: `Удалено сообщений: ${indices.length}`, type: 'info', category: 'message', sessionId })
    } catch (e) {
      notify({ text: `Ошибка: ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, selectedIndices, afterBulkReload, notify])

  const handleForward = useCallback(() => {
    if (!sessionId) return
    const indices = [...selectedIndices]
    if (indices.length === 0) return
    useUIStore.getState().enterForwardMode(sessionId, indices, 'forward')
  }, [sessionId, selectedIndices])

  const handleMerge = useCallback(() => {
    if (!sessionId) return
    useUIStore.getState().enterForwardMode(sessionId, [], 'merge')
  }, [sessionId])

  // Register forward confirm action
  const forwardCallbackRef = useRef(false)
  const handleForwardConfirm = useCallback(async (targetSessionId: string, position: 'after' | 'before', summarize: boolean) => {
    const fm = useUIStore.getState().forwardMode
    if (!fm.active || !fm.sourceSessionId || !sessionId) return

    try {
      const msgs = useChatStore.getState().messagesBySession[sessionId] || []
      
      if (fm.mode === 'forward') {
        const sorted = [...fm.sourceIndices].sort((a, b) => a - b)
        const selectedMsgs = sorted.map(i => msgs[i]).filter(Boolean)
        if (selectedMsgs.length === 0) return
        const lastSelected = selectedMsgs[selectedMsgs.length - 1]
        // Use seq numbers, not indices
        const fromSeq = selectedMsgs[0].seq ?? sorted[0] + 1
        const toSeq = lastSelected.role === 'user' && selectedMsgs.length > 1
          ? selectedMsgs[selectedMsgs.length - 2].seq ?? sorted[sorted.length - 2] + 1
          : lastSelected.seq ?? sorted[sorted.length - 1] + 1

        await synthApi.mergeMessages(targetSessionId, sessionId, { sourceRange: [fromSeq, toSeq], position })

        if (lastSelected.role === 'user') {
          useChatStore.getState().setRetryInput(targetSessionId, lastSelected.content)
        }
        notify({ text: 'Сообщения скопированы', type: 'success', category: 'message', sessionId })
      } else {
        await synthApi.addSessionReference(targetSessionId, sessionId, {
          messageRange: [1, sessionMessages.length || 9999],
          position,
          autoSummarize: summarize,
        })
        notify({ text: 'Ссылка на сессию добавлена', type: 'success', category: 'message', sessionId })
      }
      useUIStore.getState().cancelForwardMode()
    } catch (e) {
      notify({ text: `Ошибка: ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, sessionMessages.length, notify])

  // Register the callback so LeftPanel can call it
  useUIStore.getState().forwardConfirmAction = handleForwardConfirm
  if (!forwardCallbackRef.current) {
    forwardCallbackRef.current = true
  }

  return (
    <header className="flex h-9 items-center justify-between px-3 bg-background">
      <div className="flex items-center gap-3 min-w-0">
        {!leftPanel.isOpen && (
          <button
            onClick={toggleLeftPanel}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
            title={t('header.showLeftPanel')}
          >
            <Icon name="layout-left" className="h-5 w-5" />
          </button>
        )}

        <span className="font-semibold text-foreground shrink-0">{headerTitle}</span>

        {/* Chat context — always visible */}
        {isChatTab && (
          <>
            <div className="flex items-center gap-1 ml-1">
              <div
                className="flex items-center gap-1"
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
              {!isSubagentSession && (
                <button
                  onClick={handleSummarize}
                  disabled={!canSummarize || summarizing}
                  title={canSummarize ? t('rightPanel.context.summarizeNow') : t('rightPanel.context.notEnoughMessages')}
                  className={cn(
                    'shrink-0 rounded p-1 transition-colors',
                    canSummarize && !summarizing
                      ? 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover'
                      : 'text-muted-foreground opacity-30 cursor-default',
                  )}
                >
                  <Icon name="subtract" className="size-3.5 text-amber-400" />
                </button>
              )}
              {!isSubagentSession && (
                <button
                  onClick={handleClearSession}
                  title={t('leftPanel.clearSession')}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
                >
                  <Icon name="close" className="size-3.5 text-destructive" />
                </button>
              )}

              {/* Selection toggle — always visible */}
              {!selectionMode && (
                <button
                  onClick={handleToggleSelectionMode}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
                  title="Режим выделения"
                >
                  <Icon name="checkbox-multiple" className="size-3.5" />
                </button>
              )}
            </div>

            {/* Selection toolbar */}
            {selectionMode && (
              <div className="flex items-center gap-1 ml-1">
                <button
                  onClick={handleToggleSelectionMode}
                  className="rounded px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10"
                >
                  ✕ Выйти
                </button>
                <button
                  onClick={handleSelectAll}
                  className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-interactive-hover"
                >
                  Выделить всё
                </button>
                <button
                  onClick={handleClearSelection}
                  className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-interactive-hover"
                >
                  Снять
                </button>
                <span className="text-[11px] text-muted-foreground mx-0.5">
                  {selectedCount}/{totalMessageCount}
                </span>
                <button
                  onClick={handleBulkPin}
                  disabled={selectedCount === 0}
                  className="rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-interactive-hover disabled:opacity-30"
                  title="Закрепить"
                >
                  📌
                </button>
                <button
                  onClick={handleBulkToggle}
                  disabled={selectedCount === 0}
                  className="rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-interactive-hover disabled:opacity-30"
                  title="Отключить"
                >
                  👁
                </button>
                <button
                  onClick={handleBulkDelete}
                  disabled={selectedCount === 0}
                  className="rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-30"
                  title="Удалить"
                >
                  🗑
                </button>
                <button
                  onClick={handleForward}
                  disabled={selectedCount === 0}
                  className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-interactive-hover disabled:opacity-30"
                  title="Переслать"
                >
                  ↗ Переслать
                </button>
              </div>
            )}

            {/* Merge button — always visible, independent of selection */}
            <button
              onClick={handleMerge}
              className="shrink-0 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors ml-1"
              title="Слияние"
            >
              🔗 Слияние
            </button>
          </>
        )}

        {/* File viewer toolbar */}
        {isFileViewer && activeTab && (
          <div className="flex items-center gap-1 ml-1">
            <span className="text-xs font-mono text-muted-foreground truncate max-w-[260px]">
              {activeTab.data.filePath}
            </span>
            <button
              onClick={handleFileEdit}
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
              title={t('file.edit')}
            >
              <Icon name="edit-2" className="size-3.5" />
            </button>
            <button
              onClick={handleFileDownload}
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
              title={t('file.download')}
            >
              <Icon name="download" className="size-3.5" />
            </button>
          </div>
        )}

        {/* File editor toolbar */}
        {isFileEditor && activeTab && (
          <div className="flex items-center gap-1 ml-1">
            <span className="text-xs font-mono text-muted-foreground truncate max-w-[260px]">
              {activeTab.data.filePath}
            </span>
            <span className={cn(
              'text-xs',
              editingState === 'saving' && 'text-yellow-500',
              editingState === 'saved' && 'text-green-500',
              editingState === 'error' && 'text-red-500',
              isEditorDirty && 'text-yellow-500',
              (!editingState || editingState === 'idle') && 'text-muted-foreground',
            )}>
              {editingState === 'saving' ? t('file.saving')
                : editingState === 'saved' ? t('file.saved')
                : editingState === 'error' ? t('file.saveError')
                : isEditorDirty ? t('common.modified')
                : ''}
            </span>
            <button
              onClick={handleFileSave}
              disabled={!isEditorDirty || isSaving}
              className={cn(
                'shrink-0 inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                isEditorDirty && !isSaving
                  ? 'text-primary hover:bg-primary/10'
                  : 'text-muted-foreground opacity-50 cursor-default',
              )}
              title={t('common.save')}
            >
              <Icon name="save" className="size-3.5" />
              {isSaving ? t('file.saving') : t('common.save')}
            </button>
            <button
              onClick={handleFileClose}
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
              title={t('common.close')}
            >
              <Icon name="x" className="size-3.5" />
            </button>
          </div>
        )}

        {/* Commit detail toolbar */}
        {isCommitDetail && activeTab && (
          <div className="flex items-center gap-1 ml-1">
            <code className="text-[10px] font-mono text-muted-foreground bg-interactive rounded px-1.5 py-px">
              {activeTab.data.commitHash?.slice(0, 7)}
            </code>
            <button
              onClick={handleCommitCopy}
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
              title={t('commit.copy')}
            >
              <Icon name="file-copy" className="size-3.5" />
            </button>
            <button
              onClick={handleCommitClose}
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
              title={t('common.close')}
            >
              <Icon name="x" className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <GlobalTransportIndicator />
        <NotificationPopup />
        <QuickSettingsPopup onSettingsClick={onSettingsClick} />

        {(user?.roles?.includes('ADMIN') || user?.roles?.includes('AUDITOR')) && (
          <button
            onClick={() => setLogsDialogOpen(true)}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
            title={t('header.logs')}
          >
            <Icon name="file-list" className="h-5 w-5" />
          </button>
        )}

        <button
          onClick={() => setSettingsDialogOpen(true)}
          className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
          title={t('header.settings')}
        >
          <Icon name="settings-3" className="h-5 w-5" />
        </button>

        {!rightPanel.isOpen && (
          <button
            onClick={toggleRightPanel}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
            title={t('header.showRightPanel')}
          >
            <Icon name="layout-right" className="h-5 w-5" />
          </button>
        )}
      </div>
    </header>
  )
}
