import { useState, useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useNotification } from '@/hooks/useNotification'
import { synthApi } from '@/lib/api/synthApi'

const OPTIMIZATION_MODES = [
  { value: 'none', labelKey: 'rightPanel.context.optimization.none' },
  { value: 'sliding_window', labelKey: 'rightPanel.context.optimization.sliding_window' },
  { value: 'summarization', labelKey: 'rightPanel.context.optimization.summarization' },
  { value: 'sticky_notes', labelKey: 'rightPanel.context.optimization.sticky_notes' },
] as const

const WINDOW_TYPES = [
  { value: 'messages', labelKey: 'rightPanel.context.windowType.messages' },
  { value: 'tokens', labelKey: 'rightPanel.context.windowType.tokens' },
] as const

export function ContextTab() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const { sessions } = useSessionsStore()

  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((t) => t.id === activeTabId)
  const sessionId = activeTab?.data?.sessionId

  const session = sessions.find((s) => s.id === sessionId)

  const [mode, setMode] = useState<string>('none')
  const [windowType, setWindowType] = useState<string>('messages')
  const [windowLimit, setWindowLimit] = useState(10)
  const [sumEnabled, setSumEnabled] = useState(false)
  const [afterN, setAfterN] = useState(10)
  const [contextPercent, setContextPercent] = useState(50)
  const [headMessages, setHeadMessages] = useState(2)
  const [tailMessages, setTailMessages] = useState(3)
  const [windowThreshold, setWindowThreshold] = useState(80)
  const [saving, setSaving] = useState(false)
  const [summarizing, setSummarizing] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    synthApi.getOptimization(sessionId)
      .then((data) => {
        setMode(data.context_optimization)
        setWindowType(data.sliding_window_type)
        setWindowLimit(data.sliding_window_limit)
        setSumEnabled(data.summarization_enabled)
        setAfterN(data.summarize_after_n)
        setContextPercent(data.summarize_context_percent)
        setHeadMessages(data.summarization_head_messages)
        setTailMessages(data.summarization_tail_messages)
        setWindowThreshold(data.context_window_threshold)
      })
      .catch(() => {})
  }, [sessionId])

  const handleSave = async () => {
    if (!sessionId) return
    setSaving(true)
    try {
      await synthApi.updateOptimization(sessionId, {
        context_optimization: mode,
        sliding_window_type: windowType,
        sliding_window_limit: windowLimit,
        summarization_enabled: sumEnabled,
        summarize_after_n: afterN,
        summarize_context_percent: contextPercent,
        summarization_head_messages: headMessages,
        summarization_tail_messages: tailMessages,
        context_window_threshold: windowThreshold,
      })
      notify({ text: t('rightPanel.context.saved'), type: 'success', category: 'system', sessionId })
    } catch {
      notify({ text: t('rightPanel.context.saveError'), type: 'error', category: 'error', sessionId })
    } finally {
      setSaving(false)
    }
  }

  const handleSummarize = async () => {
    if (!sessionId) return
    setSummarizing(true)
    try {
      const result = await synthApi.summarizeSession(sessionId)
      notify({
        text: t('rightPanel.context.summarized'),
        type: 'success',
        category: 'system',
        sessionId,
      })
    } catch {
      notify({ text: t('rightPanel.context.summarizeError'), type: 'error', category: 'error', sessionId })
    } finally {
      setSummarizing(false)
    }
  }

  const handleCheck = async () => {
    if (!sessionId) return
    try {
      const result = await synthApi.checkOptimization(sessionId)
      const sw = result.sliding_window.triggered ? '✓' : '—'
      const sum = result.summarization.triggered ? '✓' : '—'
      const extra = result.summarization_pending ? ' (pending)' : ''
      notify({
        text: `SW=${sw} SUM=${sum}${extra}`,
        type: 'info',
        category: 'system',
        sessionId,
      })
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
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Режим оптимизации */}
        <Section title={t('rightPanel.context.sectionOptimization')}>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="w-full rounded border border-border bg-input px-2 py-1.5 text-xs text-foreground"
          >
            {OPTIMIZATION_MODES.map((o) => (
              <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
            ))}
          </select>
        </Section>

        {/* Скользящее окно */}
        {mode === 'sliding_window' && (
          <Section title={t('rightPanel.context.sectionSlidingWindow')}>
            <select
              value={windowType}
              onChange={(e) => setWindowType(e.target.value)}
              className="w-full rounded border border-border bg-input px-2 py-1.5 text-xs text-foreground"
            >
              {WINDOW_TYPES.map((wt) => (
                <option key={wt.value} value={wt.value}>{t(wt.labelKey)}</option>
              ))}
            </select>
            <NumberSetting
              label={t('rightPanel.context.windowLimit')}
              value={windowLimit}
              onChange={setWindowLimit}
              min={1}
              max={windowType === 'tokens' ? 200000 : 200}
            />
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('rightPanel.context.hint.slidingWindow')}
            </p>
          </Section>
        )}

        {/* Суммаризация */}
        {mode === 'summarization' && (
          <Section title={t('rightPanel.context.sectionSummarization')}>
            <ToggleSetting
              label={t('rightPanel.context.summarizationEnabled')}
              enabled={sumEnabled}
              onChange={setSumEnabled}
            />
            <NumberSetting
              label={t('rightPanel.context.afterN')}
              value={afterN}
              onChange={setAfterN}
              min={1}
              max={200}
            />
            <NumberSetting
              label={t('rightPanel.context.contextPercent')}
              value={contextPercent}
              onChange={setContextPercent}
              min={1}
              max={100}
              suffix="%"
            />
            <NumberSetting
              label={t('rightPanel.context.headMessages')}
              value={headMessages}
              onChange={setHeadMessages}
              min={1}
              max={20}
            />
            <NumberSetting
              label={t('rightPanel.context.tailMessages')}
              value={tailMessages}
              onChange={setTailMessages}
              min={1}
              max={20}
            />
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('rightPanel.context.hint.summarization')}
            </p>
          </Section>
        )}

        {/* Заметки */}
        {mode === 'sticky_notes' && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Заметки сессии попадают в системный промпт и доступны через панель в верхней части чата.
          </p>
        )}

        {/* Общие настройки */}
        {(mode === 'sliding_window' || mode === 'summarization') && (
          <Section title={t('rightPanel.context.sectionCommon')}>
            <NumberSetting
              label={t('rightPanel.context.windowThreshold')}
              value={windowThreshold}
              onChange={setWindowThreshold}
              min={10}
              max={100}
              suffix="%"
            />
          </Section>
        )}
      </div>

      {/* Кнопки */}
      <div className="shrink-0 border-t border-border p-4 space-y-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? t('rightPanel.context.saving') : t('common.save')}
        </button>
        {mode === 'summarization' && (
          <button
            onClick={handleSummarize}
            disabled={summarizing}
            className="w-full rounded-lg border border-border px-4 py-2 text-xs font-medium text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
          >
            {summarizing ? t('rightPanel.context.summarizing') : t('rightPanel.context.summarizeNow')}
          </button>
        )}
        <button
          onClick={handleCheck}
          className="w-full rounded-lg border border-border px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors"
        >
          {t('rightPanel.context.checkTriggers')}
        </button>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide mb-2">{title}</div>
      <div className="space-y-2">{children}</div>
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

function ToggleSetting({
  label,
  enabled,
  onChange,
}: {
  label: string
  enabled: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-foreground">{label}</span>
      <button
        onClick={() => onChange(!enabled)}
        className={`relative h-5 w-9 rounded-full transition-colors ${
          enabled ? 'bg-primary' : 'bg-interactive'
        }`}
      >
        <div
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform ${
            enabled ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  )
}
