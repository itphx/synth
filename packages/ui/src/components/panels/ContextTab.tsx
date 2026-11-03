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

/**
 * Значения, изменённые в текущем обработчике: `setState` асинхронна, поэтому без
 * явного переопределения в запрос уходит предыдущее значение (лаг на одно изменение).
 */
type ContextOverrides = Partial<{
  swMode: 'messages' | 'tokens'
  swMessageLimit: number
  swTokenThreshold: number
  sumMode: 'messages' | 'tokens'
  afterN: number
  tokenThreshold: number
  sumKeepTokens: number
  compKeepTokens: number
  compThreshold: number
}>

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
  const [compEnabled, setCompEnabled] = useState(false)
  const [swMode, setSwMode] = useState<'messages' | 'tokens'>('messages')
  const [swMessageLimit, setSwMessageLimit] = useState(10)
  const [swTokenThreshold, setSwTokenThreshold] = useState(80)
  const [sumMode, setSumMode] = useState<'messages' | 'tokens'>('messages')
  const [afterN, setAfterN] = useState(10)
  const [tokenThreshold, setTokenThreshold] = useState(50)
  const [sumKeepTokens, setSumKeepTokens] = useState(5000)
  const [compKeepTokens, setCompKeepTokens] = useState(15000)
  const [compThreshold, setCompThreshold] = useState(85)

  useEffect(() => {
    if (!sessionId) return
    synthApi.getOptimization(sessionId)
      .then((data) => {
        // Legacy-сессия: `summarization_enabled: true` при `context_optimization:
        // 'none'` — сжатие фактически включено суммаризацией. Показываем
        // суммаризацию, иначе панель рисует «всё выключено», а движок сжимает.
        const legacySum = data.context_optimization === 'none' && data.summarization_enabled === true
        const mode = legacySum ? 'summarization' : data.context_optimization
        setWindowEnabled(mode === 'sliding_window')
        setSumEnabled(mode === 'summarization')
        setCompEnabled(mode === 'compaction')
        setSwMode((data.sliding_window_mode as 'messages' | 'tokens') || 'messages')
        setSwMessageLimit(data.sliding_window_message_limit)
        setSwTokenThreshold(data.sliding_window_token_threshold)
        setSumMode((data.summarization_trigger_mode as 'messages' | 'tokens') || 'messages')
        setAfterN(data.summarize_after_n)
        setTokenThreshold(data.summarize_token_threshold)
        setSumKeepTokens(data.summarization_keep_tokens ?? 5000)
        setCompKeepTokens(data.compaction_keep_tokens ?? 15000)
        setCompThreshold(data.compaction_token_threshold ?? 85)
      })
      .catch(() => {})
  }, [sessionId])

  const mode = compEnabled
    ? 'compaction'
    : sumEnabled
      ? 'summarization'
      : windowEnabled
        ? 'sliding_window'
        : 'none'

  const handleSave = async (newMode: string, overrides: ContextOverrides = {}, rollback?: () => void) => {
    if (!sessionId) return
    await run({
      key: CONTEXT_SAVE_KEY,
      run: () => synthApi.updateOptimization(sessionId, {
        context_optimization: newMode,
        sliding_window_mode: overrides.swMode ?? swMode,
        sliding_window_message_limit: overrides.swMessageLimit ?? swMessageLimit,
        sliding_window_token_threshold: overrides.swTokenThreshold ?? swTokenThreshold,
        // Legacy-флаг: любое сжатие (окно/суммаризация/компактизация) держит его
        // включённым; выключается только при полном отключении оптимизации —
        // иначе правка числа в legacy-сессии гасила сжатие.
        summarization_enabled: newMode !== 'none',
        summarization_trigger_mode: overrides.sumMode ?? sumMode,
        summarize_after_n: overrides.afterN ?? afterN,
        summarize_token_threshold: overrides.tokenThreshold ?? tokenThreshold,
        summarization_keep_tokens: overrides.sumKeepTokens ?? sumKeepTokens,
        compaction_keep_tokens: overrides.compKeepTokens ?? compKeepTokens,
        compaction_token_threshold: overrides.compThreshold ?? compThreshold,
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

  const toggleMode = async (target: 'window' | 'sum' | 'comp') => {
    if (!sessionId) return
    const prev = { window: windowEnabled, sum: sumEnabled, comp: compEnabled }
    const next = {
      window: target === 'window' ? !windowEnabled : false,
      sum: target === 'sum' ? !sumEnabled : false,
      comp: target === 'comp' ? !compEnabled : false,
    }
    setWindowEnabled(next.window)
    setSumEnabled(next.sum)
    setCompEnabled(next.comp)
    const newMode = next.comp
      ? 'compaction'
      : next.sum
        ? 'summarization'
        : next.window
          ? 'sliding_window'
          : 'none'
    await handleSave(newMode, {}, () => {
      setWindowEnabled(prev.window)
      setSumEnabled(prev.sum)
      setCompEnabled(prev.comp)
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
    <PanelTab>
      {/* Заметки — alwaysOpen */}
      <Block title={t('rightPanel.context.stickyNotes')}>
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
        onToggle={() => void toggleMode('window')}
        pending={isPending(CONTEXT_SAVE_KEY)}
      >
        <SectionHeader label={t('rightPanel.context.sectionWindowSize')} />
        <RadioSetting
          label={t('rightPanel.context.windowMessages')}
          value={swMessageLimit}
          onChange={(v) => {
            const prev = swMessageLimit
            setSwMessageLimit(v)
            handleSave(mode, { swMessageLimit: v }, () => setSwMessageLimit(prev))
          }}
          min={1}
          max={200}
          selected={swMode === 'messages'}
          onSelect={() => {
            const prev = swMode
            setSwMode('messages')
            handleSave(mode, { swMode: 'messages' }, () => setSwMode(prev))
          }}
        />
        <RadioSetting
          label={t('rightPanel.context.windowTokens')}
          value={swTokenThreshold}
          onChange={(v) => {
            const prev = swTokenThreshold
            setSwTokenThreshold(v)
            handleSave(mode, { swTokenThreshold: v }, () => setSwTokenThreshold(prev))
          }}
          min={10}
          max={100}
          selected={swMode === 'tokens'}
          onSelect={() => {
            const prev = swMode
            setSwMode('tokens')
            handleSave(mode, { swMode: 'tokens' }, () => setSwMode(prev))
          }}
        />
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t('rightPanel.context.hint.slidingWindow')}
        </p>
      </Block>

      {/* Суммаризация */}
      <Block
        title={t('rightPanel.context.optimization.summarization')}
        enabled={sumEnabled}
        onToggle={() => void toggleMode('sum')}
        pending={isPending(CONTEXT_SAVE_KEY)}
      >
        <SectionHeader label={t('rightPanel.context.triggersGroup')} />
        <RadioSetting
          label={t('rightPanel.context.afterN')}
          value={afterN}
          onChange={(v) => {
            const prev = afterN
            setAfterN(v)
            handleSave(mode, { afterN: v }, () => setAfterN(prev))
          }}
          min={1}
          max={200}
          selected={sumMode === 'messages'}
          onSelect={() => {
            const prev = sumMode
            setSumMode('messages')
            handleSave(mode, { sumMode: 'messages' }, () => setSumMode(prev))
          }}
        />
        <RadioSetting
          label={t('rightPanel.context.tokenThreshold')}
          value={tokenThreshold}
          onChange={(v) => {
            const prev = tokenThreshold
            setTokenThreshold(v)
            handleSave(mode, { tokenThreshold: v }, () => setTokenThreshold(prev))
          }}
          min={10}
          max={100}
          selected={sumMode === 'tokens'}
          onSelect={() => {
            const prev = sumMode
            setSumMode('tokens')
            handleSave(mode, { sumMode: 'tokens' }, () => setSumMode(prev))
          }}
        />
        <SectionHeader label={t('rightPanel.context.compressionGroup')} />
        <NumberSetting
          label={t('rightPanel.context.summarizationKeepTokens')}
          value={sumKeepTokens}
          onChange={(v) => {
            const prev = sumKeepTokens
            setSumKeepTokens(v)
            handleSave(mode, { sumKeepTokens: v }, () => setSumKeepTokens(prev))
          }}
          min={0}
          max={50000}
        />
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t('rightPanel.context.hint.summarization')}
        </p>
      </Block>

      {/* Компактизация */}
      <Block
        title={t('rightPanel.context.optimization.compaction')}
        enabled={compEnabled}
        onToggle={() => void toggleMode('comp')}
        pending={isPending(CONTEXT_SAVE_KEY)}
      >
        <SectionHeader label={t('rightPanel.context.triggersGroup')} />
        <NumberSetting
          label={t('rightPanel.context.compactionThreshold')}
          value={compThreshold}
          onChange={(v) => {
            const prev = compThreshold
            setCompThreshold(v)
            handleSave(mode, { compThreshold: v }, () => setCompThreshold(prev))
          }}
          min={1}
          max={100}
          suffix="%"
        />
        <SectionHeader label={t('rightPanel.context.compressionGroup')} />
        <NumberSetting
          label={t('rightPanel.context.compactionKeepTokens')}
          value={compKeepTokens}
          onChange={(v) => {
            const prev = compKeepTokens
            setCompKeepTokens(v)
            handleSave(mode, { compKeepTokens: v }, () => setCompKeepTokens(prev))
          }}
          min={0}
          max={100000}
        />
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t('rightPanel.context.hint.compaction')}
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
    <div className="rounded-lg border border-border bg-card p-3">
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
