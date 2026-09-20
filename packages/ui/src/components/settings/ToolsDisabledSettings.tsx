import { useEffect, useMemo, useState } from 'react'
import type { PromptToolDetail } from '@itphx/synth-shared'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useMcpStore } from '@/stores/mcpStore'
import { useNotification } from '@/hooks/useNotification'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '../icon/Icon'
import { SettingsCard } from './settings-layout'
import { cn } from '@/lib/utils'

/**
 * AD-071 §2.6: instance-wide жёсткое отключение встроенных инструментов
 * администратором. Группы capability + точечные тулы (список из `toolsDetail`
 * активной сессии). `runtime` неотключаем (ядро сессии).
 */
const DISABLEABLE_GROUPS = [
  'file_read',
  'file_write',
  'shell',
  'search',
  'web',
  'git_read',
  'git_write',
  'task',
  'mcp',
] as const

const RUNTIME_CAPABILITY = 'runtime'

export function ToolsDisabledSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const {
    toolsDisabled,
    toolsDisabledLoading,
    toolsDisabledError,
    fetchToolsDisabled,
    saveToolsDisabled,
  } = useMcpStore()
  const bumpToolsDisabledTick = useUIStore((s) => s.bumpToolsDisabledTick)
  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const sessionId = centerTabs.find((tab) => tab.id === activeTabId)?.data?.sessionId

  const [tools, setTools] = useState<PromptToolDetail[]>([])
  const [saving, setSaving] = useState(false)
  const [draftCapabilities, setDraftCapabilities] = useState<Set<string>>(new Set())
  const [draftTools, setDraftTools] = useState<Set<string>>(new Set())

  useEffect(() => {
    void fetchToolsDisabled()
  }, [fetchToolsDisabled])

  // Список точечных тулов — из toolsDetail активной сессии (источник capabilities).
  useEffect(() => {
    if (!sessionId) {
      setTools([])
      return
    }
    let cancelled = false
    synthApi.getSessionPrompt(sessionId)
      .then((r) => { if (!cancelled) setTools(r.toolsDetail ?? []) })
      .catch(() => { if (!cancelled) setTools([]) })
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    if (!toolsDisabled) return
    setDraftCapabilities(new Set(toolsDisabled.capabilities))
    setDraftTools(new Set(toolsDisabled.tools))
  }, [toolsDisabled])

  const builtinTools = useMemo(
    () => tools.filter((tool) => !tool.capabilities.includes(RUNTIME_CAPABILITY)),
    [tools],
  )
  const runtimeTools = useMemo(
    () => tools.filter((tool) => tool.capabilities.includes(RUNTIME_CAPABILITY)),
    [tools],
  )

  const toggleCapability = (capability: string) => {
    setDraftCapabilities((prev) => {
      const next = new Set(prev)
      if (next.has(capability)) next.delete(capability)
      else next.add(capability)
      return next
    })
  }

  const toggleTool = (name: string) => {
    setDraftTools((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await saveToolsDisabled({
        capabilities: [...draftCapabilities],
        tools: [...draftTools],
      })
      // Статистика/таблицы MCP перезапрашивают данные без рестарта.
      bumpToolsDisabledTick()
      notify({ text: t('mcpAdmin.tools.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('mcpAdmin.tools.saveError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title={t('mcpAdmin.tools.title')}
      description={t('mcpAdmin.tools.description')}
    >
      {toolsDisabledError && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{toolsDisabledError}</div>
      )}
      {toolsDisabledLoading && !toolsDisabled && (
        <div className="text-center text-muted-foreground py-4 text-sm">{t('common.loading')}</div>
      )}

      {/* Группы capability */}
      <div className="space-y-1.5" data-testid="tools-disabled-groups">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t('mcpAdmin.tools.groups')}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {DISABLEABLE_GROUPS.map((capability) => (
            <label
              key={capability}
              className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 cursor-pointer hover:bg-interactive-hover/50"
            >
              <input
                type="checkbox"
                data-testid={`tools-disabled-group-${capability}`}
                checked={draftCapabilities.has(capability)}
                onChange={() => toggleCapability(capability)}
                className="accent-primary"
              />
              <span className="text-xs text-foreground">{t(`mcpAdmin.tools.group.${capability}`)}</span>
              <span className="ml-auto text-[0.625rem] text-muted-foreground/60 font-mono">{capability}</span>
            </label>
          ))}
          {/* runtime — ядро сессии, неотключаем */}
          <label
            data-testid="tools-disabled-runtime"
            className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 bg-interactive-hover/30 px-2.5 py-1.5 opacity-70 cursor-not-allowed"
            title={t('mcpAdmin.tools.runtimeHint')}
          >
            <input type="checkbox" checked disabled className="accent-primary" />
            <span className="text-xs text-foreground">{t('mcpAdmin.tools.group.runtime')}</span>
            <span className="ml-auto inline-flex items-center gap-1 text-[0.625rem] text-muted-foreground/60">
              <Icon name="shield" className="size-3" />
              {t('mcpAdmin.tools.notDisableable')}
            </span>
          </label>
        </div>
      </div>

      {/* Точечные тулы */}
      <div className="space-y-1.5" data-testid="tools-disabled-tools">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t('mcpAdmin.tools.perTool')}
        </div>
        {tools.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">{t('mcpAdmin.tools.noSession')}</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-72 overflow-y-auto pr-1">
            {builtinTools.map((tool) => {
              const disabledByGroup = tool.capabilities.some((c) => draftCapabilities.has(c))
              return (
                <label
                  key={tool.name}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 cursor-pointer hover:bg-interactive-hover/50',
                    disabledByGroup && 'opacity-50',
                  )}
                  title={tool.capabilities.join(', ')}
                >
                  <input
                    type="checkbox"
                    data-testid={`tools-disabled-tool-${tool.name}`}
                    checked={draftTools.has(tool.name)}
                    disabled={disabledByGroup}
                    onChange={() => toggleTool(tool.name)}
                    className="accent-primary"
                  />
                  <span className="text-xs font-mono truncate">{tool.name}</span>
                </label>
              )
            })}
            {runtimeTools.map((tool) => (
              <label
                key={tool.name}
                data-testid={`tools-disabled-runtime-tool-${tool.name}`}
                className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 px-2.5 py-1.5 opacity-60 cursor-not-allowed"
                title={t('mcpAdmin.tools.runtimeHint')}
              >
                <input type="checkbox" checked disabled className="accent-primary" />
                <span className="text-xs font-mono truncate">{tool.name}</span>
                <span className="ml-auto text-[0.625rem] text-muted-foreground/60">{t('mcpAdmin.tools.notDisableable')}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving || toolsDisabledLoading}
          className="shrink-0 px-4 py-2 rounded-lg bg-interactive-accent text-interactive-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </SettingsCard>
  )
}
