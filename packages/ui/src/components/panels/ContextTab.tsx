import { useState, useEffect } from 'react'
import type { McpServerEffective } from '@itphx/synth-shared'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useChatStore } from '@/stores/chatStore'
import { useNotification } from '@/hooks/useNotification'
import { synthApi } from '@/lib/api/synthApi'
import { cn } from '@/lib/utils'
import { DEFAULT_CHARS_PER_TOKEN } from '@/lib/formatStats'
import { Toggle } from '../ui/Toggle'
import { Icon } from '../icon/Icon'

/** AD-071 §2.6: оценка токенов с `~`, если ratio не калиброван. */
function formatMcpTokens(estTokens: number | undefined, ratio: number | undefined): string {
  if (estTokens === undefined) return '\u2014'
  const calibrated = ratio !== undefined && ratio !== DEFAULT_CHARS_PER_TOKEN
  return `${calibrated ? '' : '~'}${estTokens.toLocaleString()}`
}

export function ContextTab() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const { stickyNotesBySession, setStickyNotes } = useChatStore()

  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((t) => t.id === activeTabId)
  const sessionId = activeTab?.data?.sessionId
  const stickyNotes = sessionId ? stickyNotesBySession[sessionId] || [] : []

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
  const [saving, setSaving] = useState(false)

  // AD-071 §2.4/§2.6: эффективный MCP-скоуп сессии — таблица с переключателями.
  const [mcpServers, setMcpServers] = useState<McpServerEffective[]>([])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpToggling, setMcpToggling] = useState<string | null>(null)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const streamFinishTick = useChatStore((s) =>
    sessionId ? s.streamFinishTickBySession[sessionId] ?? 0 : 0,
  )
  const toolsDisabledTick = useUIStore((s) => s.toolsDisabledTick)

  useEffect(() => {
    if (!sessionId) {
      setMcpServers([])
      return
    }
    let cancelled = false
    setMcpLoading(true)
    setMcpError(null)
    synthApi.getSessionMcpEffective(sessionId)
      .then((r) => { if (!cancelled) setMcpServers(r.servers) })
      .catch((err) => {
        if (!cancelled) {
          setMcpServers([])
          setMcpError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => { if (!cancelled) setMcpLoading(false) })
    return () => { cancelled = true }
  }, [sessionId, streamFinishTick, toolsDisabledTick])

  /** AD-071 §2.4: точечный toggle MCP-сервера (включая opt-out системных). */
  const handleToggleMcpServer = async (server: McpServerEffective) => {
    if (!sessionId || mcpToggling) return
    setMcpToggling(server.name)
    setMcpError(null)
    try {
      const r = await synthApi.updateSessionMcp(sessionId, { name: server.name, enabled: !server.enabled })
      setMcpServers(r.servers)
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err))
    } finally {
      setMcpToggling(null)
    }
  }

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

  const handleSave = async (newMode: string) => {
    if (!sessionId) return
    setSaving(true)
    try {
      const result = await synthApi.updateOptimization(sessionId, {
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

        {/* AD-071 §2.4/§2.6: MCP-серверы сессии — переключатели вкл/выкл,
            уровень, статус, число тулов и оценка токенов. */}
        <Block title={t('rightPanel.context.mcp.title')}>
          {mcpLoading && mcpServers.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
          ) : mcpServers.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('rightPanel.context.mcp.empty')}</p>
          ) : (
            <div className="overflow-x-auto" data-testid="context-mcp-list">
              <table className="w-full text-[0.6875rem]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="px-2 py-0.5 text-left font-medium first:pl-0">{t('rightPanel.stats.colServer')}</th>
                    <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colLevel')}</th>
                    <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colStatus')}</th>
                    <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colTools')}</th>
                    <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.promptColTokens')}</th>
                    <th className="px-2 py-0.5 text-center font-medium last:pr-0">{t('rightPanel.context.mcp.colEnabled')}</th>
                  </tr>
                </thead>
                <tbody>
                  {mcpServers.map((server) => {
                    const status = server.status
                      ?? (server.enabled ? (server.connected ? 'connected' : 'error') : 'disabled')
                    return (
                      <tr
                        key={server.name}
                        data-testid={`context-mcp-${server.name}`}
                        className={cn('border-t border-border/30', !server.enabled && 'text-muted-foreground/60')}
                      >
                        <td className="px-2 py-1 text-left max-w-[7rem] truncate first:pl-0" title={server.name}>{server.name}</td>
                        <td className="px-2 py-1 text-center">{t(`rightPanel.stats.mcpLevel.${server.level}`)}</td>
                        <td className="px-2 py-1 text-center">
                          {t(`rightPanel.stats.mcpStatus.${status}`)}
                          {!server.enabled && server.reason && (
                            <span className="block text-[0.5625rem] text-muted-foreground/70">
                              {t(`rightPanel.stats.mcpReason.${server.reason}`)}
                            </span>
                          )}
                        </td>
                        <td
                          className="px-2 py-1 text-center tabular-nums"
                          title={server.tools && server.tools.length > 0 ? server.tools.join(', ') : undefined}
                        >
                          {server.tools?.length ?? 0}
                        </td>
                        <td className="px-2 py-1 text-center tabular-nums">{formatMcpTokens(server.estTokens, server.ratio)}</td>
                        <td className="px-2 py-1 text-center last:pr-0">
                          <Toggle
                            enabled={server.enabled}
                            onToggle={() => handleToggleMcpServer(server)}
                            ariaLabel={server.enabled ? t('mcp.disable') : t('mcp.enable')}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {mcpError && (
            <p className="text-xs text-destructive">{t('rightPanel.context.mcp.toggleError')}</p>
          )}
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('rightPanel.context.mcp.hint')}
          </p>
        </Block>
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

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="pt-1 pb-0">
      <span className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground/60">{label}</span>
    </div>
  )
}

function Block({
  title,
  children,
  enabled,
  onToggle,
}: {
  title: string
  children: React.ReactNode
  enabled?: boolean
  onToggle?: () => void
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-foreground">{title}</span>
        {onToggle && enabled !== undefined && (
          <Toggle enabled={enabled} onToggle={onToggle} />
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
