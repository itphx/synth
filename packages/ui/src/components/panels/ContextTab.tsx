import { useState, useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useChatStore } from '@/stores/chatStore'
import { useNotification } from '@/hooks/useNotification'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '../icon/Icon'

const WINDOW_TYPES = [
  { value: 'messages', labelKey: 'rightPanel.context.windowType.messages' },
  { value: 'tokens', labelKey: 'rightPanel.context.windowType.tokens' },
] as const

export function ContextTab() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const { sessions } = useSessionsStore()
  const { stickyNotesBySession, setStickyNotes } = useChatStore()

  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((t) => t.id === activeTabId)
  const sessionId = activeTab?.data?.sessionId
  const stickyNotes = sessionId ? stickyNotesBySession[sessionId] || [] : []

  const [windowEnabled, setWindowEnabled] = useState(false)
  const [sumEnabled, setSumEnabled] = useState(false)
  const [windowType, setWindowType] = useState<string>('messages')
  const [windowLimit, setWindowLimit] = useState(10)
  const [afterN, setAfterN] = useState(10)
  const [contextPercent, setContextPercent] = useState(50)
  const [headMessages, setHeadMessages] = useState(2)
  const [tailMessages, setTailMessages] = useState(3)
  const [windowThreshold, setWindowThreshold] = useState(80)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    synthApi.getOptimization(sessionId)
      .then((data) => {
        const mode = data.context_optimization
        setWindowEnabled(mode === 'sliding_window')
        setSumEnabled(mode === 'summarization')
        setWindowType(data.sliding_window_type)
        setWindowLimit(data.sliding_window_limit)
        setAfterN(data.summarize_after_n)
        setContextPercent(data.summarize_context_percent)
        setHeadMessages(data.summarization_head_messages)
        setTailMessages(data.summarization_tail_messages)
        setWindowThreshold(data.context_window_threshold)
      })
      .catch(() => {})
  }, [sessionId])

  const mode = sumEnabled ? 'summarization' : windowEnabled ? 'sliding_window' : 'none'

  const handleSave = async (newMode: string) => {
    if (!sessionId) return
    setSaving(true)
    try {
      const result = await synthApi.updateOptimization(sessionId, {
        context_optimization: newMode,
        sliding_window_type: windowType,
        sliding_window_limit: windowLimit,
        summarization_enabled: true,
        summarize_after_n: afterN,
        summarize_context_percent: contextPercent,
        summarization_head_messages: headMessages,
        summarization_tail_messages: tailMessages,
        context_window_threshold: windowThreshold,
      })
      useSessionsStore.setState((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId ? { ...sess, ...result } : sess,
        ),
      }))
      notify({ text: t('rightPanel.context.saved'), type: 'success', category: 'system', sessionId })
    } catch {
      notify({ text: t('rightPanel.context.saveError'), type: 'error', category: 'error', sessionId })
    } finally {
      setSaving(false)
    }
  }

  const toggleWindow = async () => {
    if (!sessionId) return
    const next = !windowEnabled
    setWindowEnabled(next)
    if (next) setSumEnabled(false)
    const newMode = next ? 'sliding_window' : sumEnabled ? 'summarization' : 'none'
    await handleSave(newMode)
  }

  const toggleSum = async () => {
    if (!sessionId) return
    const next = !sumEnabled
    setSumEnabled(next)
    if (next) setWindowEnabled(false)
    const newMode = next ? 'summarization' : windowEnabled ? 'sliding_window' : 'none'
    await handleSave(newMode)
  }

  const handleNoteDelete = async (noteId: string) => {
    if (!sessionId) return
    try {
      const result = await synthApi.deleteStickyNote(sessionId, noteId)
      setStickyNotes(sessionId, result.notes)
    } catch {
      notify({ text: t('common.saveError'), type: 'error', category: 'error', sessionId })
    }
  }

  const handleNoteToggle = async (noteId: string, disabled: boolean) => {
    if (!sessionId) return
    try {
      const result = await synthApi.updateStickyNote(sessionId, noteId, { disabled })
      setStickyNotes(sessionId, result.notes)
    } catch {
      // ignore
    }
  }

  if (!sessionId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('rightPanel.context.notLoaded')}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Заметки */}
        <Block title={t('rightPanel.context.optimization.sticky_notes')} alwaysOpen>
          {stickyNotes.length === 0 ? (
            <p className="text-xs text-muted-foreground">Нет заметок</p>
          ) : (
            stickyNotes.map((note) => (
              <div key={note.id} className="flex items-center gap-2 rounded bg-interactive px-2 py-1">
                <span className="flex-1 text-xs text-foreground truncate">
                  {note.disabled && <span className="text-muted-foreground line-through">[откл] </span>}
                  {note.content.slice(0, 60)}
                </span>
                <button
                  onClick={() => handleNoteToggle(note.id, !note.disabled)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  title={note.disabled ? 'Включить' : 'Отключить'}
                >
                  <Icon name={note.disabled ? 'eye-off' : 'eye'} className="size-3" />
                </button>
                <button
                  onClick={() => handleNoteDelete(note.id)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                  title="Удалить"
                >
                  <Icon name="close" className="size-3" />
                </button>
              </div>
            ))
          )}
        </Block>

        {/* Скользящее окно */}
        <Block
          title={t('rightPanel.context.optimization.sliding_window')}
          enabled={windowEnabled}
          onToggle={toggleWindow}
        >
          <select
            value={windowType}
            onChange={(e) => { setWindowType(e.target.value); handleSave(mode) }}
            className="w-full rounded border border-border bg-input px-2 py-1.5 text-xs text-foreground"
          >
            {WINDOW_TYPES.map((wt) => (
              <option key={wt.value} value={wt.value}>{t(wt.labelKey)}</option>
            ))}
          </select>
          <NumberSetting
            label={t('rightPanel.context.windowLimit')}
            value={windowLimit}
            onChange={(v) => { setWindowLimit(v); handleSave(mode) }}
            min={1}
            max={windowType === 'tokens' ? 200000 : 200}
          />
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('rightPanel.context.hint.slidingWindow')}
          </p>
        </Block>

        {/* Суммаризация */}
        <Block
          title={t('rightPanel.context.optimization.summarization')}
          enabled={sumEnabled}
          onToggle={toggleSum}
        >
          <NumberSetting
            label={t('rightPanel.context.afterN')}
            value={afterN}
            onChange={(v) => { setAfterN(v); handleSave(mode) }}
            min={1}
            max={200}
          />
          <NumberSetting
            label={t('rightPanel.context.contextPercent')}
            value={contextPercent}
            onChange={(v) => { setContextPercent(v); handleSave(mode) }}
            min={1}
            max={100}
            suffix="%"
          />
          <NumberSetting
            label={t('rightPanel.context.headMessages')}
            value={headMessages}
            onChange={(v) => { setHeadMessages(v); handleSave(mode) }}
            min={1}
            max={20}
          />
          <NumberSetting
            label={t('rightPanel.context.tailMessages')}
            value={tailMessages}
            onChange={(v) => { setTailMessages(v); handleSave(mode) }}
            min={1}
            max={20}
          />
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('rightPanel.context.hint.summarization')}
          </p>
        </Block>

        {/* Общий порог окна */}
        {(windowEnabled || sumEnabled) && (
          <Block title={t('rightPanel.context.sectionCommon')} alwaysOpen>
            <NumberSetting
              label={t('rightPanel.context.windowThreshold')}
              value={windowThreshold}
              onChange={(v) => { setWindowThreshold(v); handleSave(mode) }}
              min={10}
              max={100}
              suffix="%"
            />
          </Block>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-4 space-y-2">
        <button
          onClick={() => handleSave(mode)}
          disabled={saving}
          className="w-full rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? t('rightPanel.context.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}

function Block({
  title,
  children,
  enabled,
  onToggle,
  alwaysOpen,
}: {
  title: string
  children: React.ReactNode
  enabled?: boolean
  onToggle?: () => void
  alwaysOpen?: boolean
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-foreground">{title}</span>
        {onToggle && enabled !== undefined && (
          <button
            onClick={onToggle}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              enabled ? 'bg-primary' : 'bg-interactive'
            }`}
          >
            <div
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-card shadow-sm transition-transform ${
                enabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        )}
      </div>
      {children && <div className="space-y-2">{children}</div>}
    </div>
  )
}

function NumberSetting({
  label,
  value,
  onChange,
  min,
  max,
  suffix = '',
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  suffix?: string
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(Math.max(min, value - 1))}
          className="flex h-5 w-5 items-center justify-center rounded text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        >
          −
        </button>
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Math.min(max, Math.max(min, parseInt(e.target.value) || 0)))}
          className="w-12 rounded bg-interactive px-1 py-0.5 text-center text-xs text-foreground outline-none tabular-nums"
          min={min}
          max={max}
        />
        <span className="text-xs text-muted-foreground">{suffix}</span>
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          className="flex h-5 w-5 items-center justify-center rounded text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        >
          +
        </button>
      </div>
    </div>
  )
}
