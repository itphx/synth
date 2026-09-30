import { useState, useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useChatStore } from '@/stores/chatStore'
import { useNotification } from '@/hooks/useNotification'
import { usePanelSettingSave } from '@/hooks/usePanelSettingSave'
import { synthApi } from '@/lib/api/synthApi'
import { Toggle } from '../ui/Toggle'
import { Icon } from '../icon/Icon'
import { PanelTab } from './PanelTab'

/** Ключ pending для всей секции оптимизации контекста (сохраняется одним запросом). */
const CONTEXT_SAVE_KEY = 'context.optimization'

export function ContextTab() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const stickyNotesBySession = useChatStore(s => s.stickyNotesBySession)
  const setStickyNotes = useChatStore(s => s.setStickyNotes)

  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((t) => t.id === activeTabId)
  const sessionId = activeTab?.data?.sessionId
  const stickyNotes = sessionId ? stickyNotesBySession[sessionId] || [] : []
  const { run, isPending } = usePanelSettingSave({ sessionId })

  const [windowEnabled, setWindowEnabled] = useState(false)
  const [sumEnabled, setSumEnabled] = useState(false)
  const [swMode, setSwMode] = useState<'messages' | 'tokens'>('messages')
  const [swMessageLimit, setSwMessageLimit] = useState(10)
  const [swTokenThreshold, setSwTokenThreshold] = useState(80)
  const [sumMode, setSumMode] = useState<'messages' | 'tokens'>('messages')
  const [afterN, setAfterN] = useState(10)
  const [tokenThreshold, setTokenThreshold] = useState(50)
  const [headMessages, setHeadMessages] = useState(2)
  const [tailMessages, setTailMessages] = useState(3)

  useEffect(() => {
    if (!sessionId) return
    synthApi.getOptimization(sessionId)
      .then((data) => {
        const mode = data.context_optimization
        setWindowEnabled(mode === 'sliding_window')
        setSumEnabled(mode === 'summarization')
        setSwMode((data.sliding_window_mode as 'messages' | 'tokens') || 'messages')
        setSwMessageLimit(data.sliding_window_message_limit)
        setSwTokenThreshold(data.sliding_window_token_threshold)
        setSumMode((data.summarization_trigger_mode as 'messages' | 'tokens') || 'messages')
        setAfterN(data.summarize_after_n)
        setTokenThreshold(data.summarize_token_threshold)
        setHeadMessages(data.summarization_head_messages)
        setTailMessages(data.summarization_tail_messages)
      })
      .catch(() => {})
  }, [sessionId])

  const mode = sumEnabled ? 'summarization' : windowEnabled ? 'sliding_window' : 'none'

  const handleSave = async (newMode: string, rollback?: () => void) => {
    if (!sessionId) return
    await run({
      key: CONTEXT_SAVE_KEY,
      run: () => synthApi.updateOptimization(sessionId, {
        context_optimization: newMode,
        sliding_window_mode: swMode,
        sliding_window_message_limit: swMessageLimit,
        sliding_window_token_threshold: swTokenThreshold,
        summarization_enabled: true,
        summarization_trigger_mode: sumMode,
        summarize_after_n: afterN,
        summarize_token_threshold: tokenThreshold,
        summarization_head_messages: headMessages,
        summarization_tail_messages: tailMessages,
      }),
      onSuccess: (result) => {
        useSessionsStore.setState((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId ? { ...sess, ...result } : sess,
          ),
        }))
      },
      onError: () => rollback?.(),
    })
  }

  const toggleWindow = async () => {
    if (!sessionId) return
    const prevWindow = windowEnabled
    const prevSum = sumEnabled
    const next = !windowEnabled
    setWindowEnabled(next)
    if (next) setSumEnabled(false)
    const newMode = next ? 'sliding_window' : sumEnabled ? 'summarization' : 'none'
    await handleSave(newMode, () => {
      setWindowEnabled(prevWindow)
      setSumEnabled(prevSum)
    })
  }

  const toggleSum = async () => {
    if (!sessionId) return
    const prevWindow = windowEnabled
    const prevSum = sumEnabled
    const next = !sumEnabled
    setSumEnabled(next)
    if (next) setWindowEnabled(false)
    const newMode = next ? 'summarization' : windowEnabled ? 'sliding_window' : 'none'
    await handleSave(newMode, () => {
      setWindowEnabled(prevWindow)
      setSumEnabled(prevSum)
    })
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
      <PanelTab>
        <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
          {t('rightPanel.context.notLoaded')}
        </div>
      </PanelTab>
    )
  }

  return (
    <PanelTab
      footer={
        <button
          onClick={() => handleSave(mode)}
          disabled={isPending(CONTEXT_SAVE_KEY)}
          className="w-full rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isPending(CONTEXT_SAVE_KEY) ? t('rightPanel.context.saving') : t('common.save')}
        </button>
      }
    >
        {/* Заметки — alwaysOpen */}
        <Block title={t('rightPanel.context.optimization.sticky_notes')}>
          {stickyNotes.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('rightPanel.context.noStickyNotes')}</p>
          ) : (
            stickyNotes.map((note) => (
              <div key={note.id} className="flex items-center gap-2 rounded bg-interactive py-1">
                <span className={`flex-1 text-xs truncate ${note.disabled ? 'text-muted-foreground line-through' : 'text-foreground'}`} title={note.content}>
                  {note.content}
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
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('rightPanel.context.hint.stickyNotes')}
          </p>
        </Block>

        {/* Скользящее окно */}
        <Block
          title={t('rightPanel.context.optimization.sliding_window')}
          enabled={windowEnabled}
          onToggle={toggleWindow}
          pending={isPending(CONTEXT_SAVE_KEY)}
        >
          <SectionHeader label={t('rightPanel.context.sectionWindowSize')} />
          <RadioSetting
            label={t('rightPanel.context.windowMessages')}
            value={swMessageLimit}
            onChange={(v) => { setSwMessageLimit(v); handleSave(mode) }}
            min={1}
            max={200}
            selected={swMode === 'messages'}
            onSelect={() => { setSwMode('messages'); handleSave(mode) }}
          />
          <RadioSetting
            label={t('rightPanel.context.windowTokens')}
            value={swTokenThreshold}
            onChange={(v) => { setSwTokenThreshold(v); handleSave(mode) }}
            min={10}
            max={100}
            selected={swMode === 'tokens'}
            onSelect={() => { setSwMode('tokens'); handleSave(mode) }}
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
          pending={isPending(CONTEXT_SAVE_KEY)}
        >
          <SectionHeader label={t('rightPanel.context.triggersGroup')} />
          <RadioSetting
            label={t('rightPanel.context.afterN')}
            value={afterN}
            onChange={(v) => { setAfterN(v); handleSave(mode) }}
            min={1}
            max={200}
            selected={sumMode === 'messages'}
            onSelect={() => { setSumMode('messages'); handleSave(mode) }}
          />
          <RadioSetting
            label={t('rightPanel.context.tokenThreshold')}
            value={tokenThreshold}
            onChange={(v) => { setTokenThreshold(v); handleSave(mode) }}
            min={10}
            max={100}
            selected={sumMode === 'tokens'}
            onSelect={() => { setSumMode('tokens'); handleSave(mode) }}
          />
          <SectionHeader label={t('rightPanel.context.compressionGroup')} />
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
    </PanelTab>
  )
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div>
      <span className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground/60">{label}</span>
    </div>
  )
}

function Block({
  title,
  children,
  enabled,
  onToggle,
  pending = false,
}: {
  title: string
  children: React.ReactNode
  enabled?: boolean
  onToggle?: () => void
  /** Идёт сохранение (тумблеры сохраняют сразу) — индикация на Toggle. */
  pending?: boolean
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-foreground">{title}</span>
        {onToggle && enabled !== undefined && (
          <Toggle enabled={enabled} onToggle={onToggle} pending={pending} />
        )}
      </div>
      {children && <div className="space-y-1.5">{children}</div>}
    </div>
  )
}

function RadioSetting({
  label,
  value,
  onChange,
  min,
  max,
  suffix = '',
  selected,
  onSelect,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  suffix?: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <div className={`flex items-center justify-between gap-2 ${selected ? '' : 'opacity-40'}`}>
      <div className="flex items-center gap-2">
        <button
          onClick={onSelect}
          data-compact
          className={`flex items-center justify-center size-4 rounded-full border-2 transition-colors shrink-0 ${
            selected ? 'border-primary bg-primary' : 'border-border bg-transparent'
          }`}
        >
          {selected && <span className="size-1.5 rounded-full bg-primary-foreground" />}
        </button>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => selected && onChange(Math.max(min, value - 1))}
          disabled={!selected}
          data-compact
          className="flex h-5 w-5 items-center justify-center rounded text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
        >
          −
        </button>
        <input
          type="number"
          value={value}
          onChange={(e) => { if (selected) onChange(Math.min(max, Math.max(min, parseInt(e.target.value) || 0))) }}
          disabled={!selected}
          className="w-12 rounded bg-interactive px-1 py-0.5 text-center text-xs text-foreground outline-none tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield] disabled:pointer-events-none"
          min={min}
          max={max}
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
        <button
          onClick={() => selected && onChange(Math.min(max, value + 1))}
          disabled={!selected}
          data-compact
          className="flex h-5 w-5 items-center justify-center rounded text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
        >
          +
        </button>
      </div>
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
          data-compact
          className="flex h-5 w-5 items-center justify-center rounded text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        >
          −
        </button>
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Math.min(max, Math.max(min, parseInt(e.target.value) || 0)))}
          className="w-12 rounded bg-interactive px-1 py-0.5 text-center text-xs text-foreground outline-none tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
          min={min}
          max={max}
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          data-compact
          className="flex h-5 w-5 items-center justify-center rounded text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        >
          +
        </button>
      </div>
    </div>
  )
}
