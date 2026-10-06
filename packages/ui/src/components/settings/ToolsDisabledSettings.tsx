import { useEffect, useMemo, useState } from 'react'
import type { PromptToolDetail, ToolsDisabledConfig } from '@itphx/synth-shared'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useMcpStore } from '@/stores/mcpStore'
import { useNotification } from '@/hooks/useNotification'
import { synthApi, type ToolsPolicy } from '@/lib/api/synthApi'
import { Icon } from '../icon/Icon'
import {
  DefaultsBadge,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  useSettingsDraft,
} from '../ui/settings'
import { PolicySettingsCard } from './PolicySettingsCard'
import { cn } from '@/lib/utils'

/**
 * AD-071 §2.6 / AD-072: instance-wide управление встроенными инструментами
 * администратором. Галочка = инструмент включён; снятие добавляет группу/тул
 * в `tools.disabled`, установка — убирает. Группы capability + точечные тулы
 * (список из `toolsDetail` активной сессии). `runtime` неотключаем (ядро сессии).
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
const EMPTY_DISABLED: ToolsDisabledConfig = { capabilities: [], tools: [] }

export function ToolsDisabledSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const toolsDisabled = useMcpStore(s => s.toolsDisabled)
  const toolsDisabledDefaults = useMcpStore(s => s.toolsDisabledDefaults)
  const toolsDisabledLoading = useMcpStore(s => s.toolsDisabledLoading)
  const toolsDisabledError = useMcpStore(s => s.toolsDisabledError)
  const fetchToolsDisabled = useMcpStore(s => s.fetchToolsDisabled)
  const saveToolsDisabled = useMcpStore(s => s.saveToolsDisabled)
  const bumpToolsDisabledTick = useUIStore((s) => s.bumpToolsDisabledTick)
  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const sessionId = centerTabs.find((tab) => tab.id === activeTabId)?.data?.sessionId

  const [tools, setTools] = useState<PromptToolDetail[]>([])
  const [saving, setSaving] = useState(false)

  // Черновик отключений: галочка снята ⇔ элемент в наборе.
  // Дефолт — серверный (config.yaml `tools.disabled`); до загрузки — пусто.
  const draft = useSettingsDraft<ToolsDisabledConfig>({
    value: toolsDisabled,
    defaultValue: toolsDisabledDefaults ?? EMPTY_DISABLED,
  })

  // Политика включения инструментов (AD-071 §2.3): глобальный режим отправки
  // определений в запрос к модели.
  const [toolsPolicy, setToolsPolicy] = useState<ToolsPolicy>('consistency')
  const [savedToolsPolicy, setSavedToolsPolicy] = useState<ToolsPolicy>('consistency')
  const [toolsPolicyDefault, setToolsPolicyDefault] = useState<ToolsPolicy>('consistency')
  const [toolsPolicyLoading, setToolsPolicyLoading] = useState(true)
  const [toolsPolicySaving, setToolsPolicySaving] = useState(false)
  const [toolsPolicyError, setToolsPolicyError] = useState<string | null>(null)

  useEffect(() => {
    void fetchToolsDisabled()
  }, [fetchToolsDisabled])

  useEffect(() => {
    let cancelled = false
    synthApi
      .getToolsPolicyInfo()
      .then(({ policy, defaults }) => {
        if (!cancelled) {
          setToolsPolicy(policy)
          setSavedToolsPolicy(policy)
          setToolsPolicyDefault(defaults)
        }
      })
      .catch((e) => {
        if (!cancelled) setToolsPolicyError(e instanceof Error ? e.message : 'HTTP')
      })
      .finally(() => {
        if (!cancelled) setToolsPolicyLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

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

  const builtinTools = useMemo(
    () => tools.filter((tool) => !tool.capabilities.includes(RUNTIME_CAPABILITY)),
    [tools],
  )
  const runtimeTools = useMemo(
    () => tools.filter((tool) => tool.capabilities.includes(RUNTIME_CAPABILITY)),
    [tools],
  )

  const draftCapabilities = draft.draft?.capabilities ?? EMPTY_DISABLED.capabilities
  const draftTools = draft.draft?.tools ?? EMPTY_DISABLED.tools

  const toggleDisabledCapability = (capability: string) => {
    draft.setDraft((prev) => {
      const base = prev ?? EMPTY_DISABLED
      const capabilities = base.capabilities.includes(capability)
        ? base.capabilities.filter((c) => c !== capability)
        : [...base.capabilities, capability]
      return { ...base, capabilities }
    })
  }

  const toggleDisabledTool = (name: string) => {
    draft.setDraft((prev) => {
      const base = prev ?? EMPTY_DISABLED
      const names = base.tools.includes(name)
        ? base.tools.filter((n) => n !== name)
        : [...base.tools, name]
      return { ...base, tools: names }
    })
  }

  const handleToolsPolicySave = async () => {
    setToolsPolicySaving(true)
    setToolsPolicyError(null)
    try {
      const saved = await synthApi.saveToolsPolicy(toolsPolicy)
      setToolsPolicy(saved)
      setSavedToolsPolicy(saved)
      notify({ text: t('common.saved'), type: 'success', category: 'system' })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'HTTP'
      setToolsPolicyError(message)
      notify({
        text: `${t('common.saveError')}: ${message}`,
        type: 'error',
        category: 'error',
      })
    } finally {
      setToolsPolicySaving(false)
    }
  }

  const handleToolsPolicyReset = async () => {
    setToolsPolicySaving(true)
    setToolsPolicyError(null)
    try {
      const policy = await synthApi.resetToolsPolicy()
      setToolsPolicy(policy)
      setSavedToolsPolicy(policy)
      notify({ text: t('common.saved'), type: 'success', category: 'system' })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'HTTP'
      setToolsPolicyError(message)
      notify({
        text: `${t('common.saveError')}: ${message}`,
        type: 'error',
        category: 'error',
      })
    } finally {
      setToolsPolicySaving(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await saveToolsDisabled(draft.draft ?? EMPTY_DISABLED)
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

  const handleReset = async () => {
    try {
      const config = await synthApi.resetToolsDisabled()
      useMcpStore.setState({ toolsDisabled: config })
      draft.setDraft(config)
      notify({ text: t('mcpAdmin.tools.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('mcpAdmin.tools.saveError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    }
  }

  return (
    <SettingsPanel
      title={t('mcpAdmin.tools.title')}
      description={t('mcpAdmin.tools.description')}
    >
      <SettingsSection actions={draft.isDefault ? <DefaultsBadge /> : undefined}>
        {toolsDisabledError && (
          <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{toolsDisabledError}</div>
        )}
        {toolsDisabledLoading && !toolsDisabled && (
          <div className="text-center text-muted-foreground py-4 text-sm">{t('common.loading')}</div>
        )}

        <p className="text-xs text-muted-foreground">{t('mcpAdmin.tools.checkHint')}</p>

        {/* Группы capability */}
        <div className="space-y-1.5" data-testid="tools-disabled-groups">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('mcpAdmin.tools.groups')}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {DISABLEABLE_GROUPS.map((capability) => {
              const enabled = !draftCapabilities.includes(capability)
              return (
                <label
                  key={capability}
                  className={cn(
                    'flex min-h-10 items-center gap-2 rounded-lg border border-border/60 bg-surface-inset px-2.5 py-1.5 cursor-pointer min-w-0',
                    'transition-colors duration-150 ease-out hover:bg-interactive-hover',
                    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                    !enabled && 'bg-interactive-selection',
                  )}
                >
                  <input
                    type="checkbox"
                    data-testid={`tools-disabled-group-${capability}`}
                    checked={enabled}
                    onChange={() => toggleDisabledCapability(capability)}
                    className="size-4 shrink-0 accent-primary focus-visible:outline-none"
                    aria-label={t(`mcpAdmin.tools.group.${capability}`)}
                  />
                  <span className={cn('text-xs min-w-0 break-words', enabled ? 'text-foreground' : 'text-muted-foreground')}>
                    {t(`mcpAdmin.tools.group.${capability}`)}
                  </span>
                  <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground/60 font-mono">{capability}</span>
                </label>
              )
            })}
            {/* runtime — ядро сессии, всегда включён */}
            <label
              data-testid="tools-disabled-runtime"
              className="flex min-h-10 items-center gap-2 rounded-lg border border-dashed border-border/60 bg-surface-inset px-2.5 py-1.5 opacity-70 cursor-not-allowed min-w-0"
              title={t('mcpAdmin.tools.runtimeHint')}
            >
              <input
                type="checkbox"
                checked
                disabled
                className="size-4 shrink-0 accent-primary"
                aria-label={t('mcpAdmin.tools.group.runtime')}
              />
              <span className="text-xs text-foreground min-w-0 break-words">{t('mcpAdmin.tools.group.runtime')}</span>
              <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[0.625rem] text-muted-foreground/60">
                <Icon name="shield" className="size-3" aria-hidden="true" />
                {t('mcpAdmin.tools.alwaysOn')}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {builtinTools.map((tool) => {
                const disabledByGroup = tool.capabilities.some((c) => draftCapabilities.includes(c))
                const enabled = !disabledByGroup && !draftTools.includes(tool.name)
                return (
                  <label
                    key={tool.name}
                    className={cn(
                      'flex min-h-10 items-center gap-2 rounded-lg border border-border/60 bg-surface-inset px-2.5 py-1.5 cursor-pointer min-w-0',
                      'transition-colors duration-150 ease-out hover:bg-interactive-hover',
                      'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                      disabledByGroup ? 'cursor-not-allowed opacity-50' : !enabled && 'bg-interactive-selection',
                    )}
                    title={tool.capabilities.join(', ')}
                  >
                    <input
                      type="checkbox"
                      data-testid={`tools-disabled-tool-${tool.name}`}
                      checked={enabled}
                      disabled={disabledByGroup}
                      onChange={() => toggleDisabledTool(tool.name)}
                      className="size-4 shrink-0 accent-primary focus-visible:outline-none"
                      aria-label={tool.name}
                    />
                    <span className={cn('text-xs font-mono truncate min-w-0', enabled ? 'text-foreground' : 'text-muted-foreground')}>
                      {tool.name}
                    </span>
                  </label>
                )
              })}
              {runtimeTools.map((tool) => (
                <label
                  key={tool.name}
                  data-testid={`tools-disabled-runtime-tool-${tool.name}`}
                  className="flex min-h-10 items-center gap-2 rounded-lg border border-dashed border-border/60 bg-surface-inset px-2.5 py-1.5 opacity-60 cursor-not-allowed min-w-0"
                  title={t('mcpAdmin.tools.runtimeHint')}
                >
                  <input type="checkbox" checked disabled className="size-4 shrink-0 accent-primary" aria-label={tool.name} />
                  <span className="text-xs font-mono truncate min-w-0">{tool.name}</span>
                  <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground/60">{t('mcpAdmin.tools.alwaysOn')}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <SettingsActions
          onSave={handleSave}
          onCancel={() => draft.revert()}
          onReset={handleReset}
          saving={saving}
          saveDisabled={toolsDisabledLoading || !draft.dirty}
          cancelDisabled={!draft.dirty}
          resetDisabled={toolsDisabledLoading}
          isDefault={draft.isDefault}
          saveTestId="tools-disabled-save"
          cancelTestId="tools-disabled-cancel"
          resetTestId="tools-disabled-reset"
        />
      </SettingsSection>

      {/* Политика встроенных инструментов (AD-071 §2.3): режим отправки определений
          в запрос к модели. Идёт после отключений — они исключения из него.
          MCP управляется отдельной политикой. */}
      <PolicySettingsCard
        scope="tools"
        value={toolsPolicy}
        savedValue={savedToolsPolicy}
        loading={toolsPolicyLoading}
        saving={toolsPolicySaving}
        error={toolsPolicyError}
        onChange={setToolsPolicy}
        onSave={handleToolsPolicySave}
        onReset={handleToolsPolicyReset}
        isDefault={toolsPolicy === toolsPolicyDefault}
      />
    </SettingsPanel>
  )
}
