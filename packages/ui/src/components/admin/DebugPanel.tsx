import { useCallback, useEffect, useMemo, useState } from 'react'
import { synthApi, type DebugConfigData } from '@/lib/api/synthApi'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  FieldTooltip,
  SettingsActions,
  SettingsItem,
  SettingsPanel,
  SettingsSection,
  useSettingsDraft,
} from '../ui/settings'

type DebugConfig = DebugConfigData

const LEVEL_COLORS: Record<string, string> = {
  NONE: 'bg-secondary text-muted-foreground',
  DEBUG: 'bg-status-info/10 text-status-info',
  INFO: 'bg-status-success/10 text-status-success',
  WARNING: 'bg-status-warning/15 text-status-warning',
  ERROR: 'bg-status-error/10 text-status-error',
}

const DEFAULT_LEVELS = ['NONE', 'DEBUG', 'INFO', 'WARNING', 'ERROR']

type DebugCategoryKey = 'ai' | 'service'

const CATEGORY_ORDER: DebugCategoryKey[] = ['ai', 'service']

/** Группы сервисного уровня (всё остальное относится к AI). */
const SERVICE_GROUPS = new Set(['DEBUG', 'ROUTES', 'STORAGE', 'WEBSOCKET'])

const categoryOf = (group: string): DebugCategoryKey =>
  SERVICE_GROUPS.has(group) ? 'service' : 'ai'

interface DebugCategorySectionProps {
  categoryKey: DebugCategoryKey
  title: string
  /** Сохранённые на сервере уровни групп только этой категории (они же — дефолт для Reset). */
  groups: Record<string, string>
  availableLevels: string[]
  onSave: (groups: Record<string, string>) => Promise<void>
}

/**
 * Секция одной категории логов: собственный черновик уровней и свои
 * Save/Cancel/Reset (ADR-072). Save отправляет только группы этой категории.
 */
function DebugCategorySection({
  categoryKey,
  title,
  groups,
  availableLevels,
  onSave,
}: DebugCategorySectionProps) {
  const { t } = useI18n()
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null)

  const draft = useSettingsDraft<Record<string, string>>({
    value: groups,
    defaultValue: groups,
    onSave: async (next) => {
      setStatus(null)
      try {
        await onSave(next)
        setStatus({ text: t('admin.debug.saved'), ok: true })
        return next
      } catch (err) {
        setStatus({
          text: err instanceof Error ? err.message : t('admin.debug.saveError'),
          ok: false,
        })
        throw err
      }
    },
  })

  const current = draft.draft ?? groups

  return (
    <SettingsSection
      id={`debug-${categoryKey}`}
      title={title}
      tooltip={t(`settings.help.debug.section.debug-${categoryKey}`)}
    >
      {Object.entries(groups).map(([group, savedLevel]) => {
        const level = current[group] ?? savedLevel
        return (
          <SettingsItem key={group} className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span className="text-sm font-medium min-w-0 break-words">{group}</span>
                <FieldTooltip text={t('settings.help.debug.levels')} />
              </span>
              <span
                className={cn(
                  'px-2 py-0.5 rounded text-[0.6875rem] font-medium',
                  LEVEL_COLORS[level] || 'bg-secondary text-muted-foreground',
                )}
              >
                {level}
              </span>
            </div>
            <Select value={level} onValueChange={(value) => draft.update({ [group]: value })}>
              <SelectTrigger aria-label={group}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableLevels.map((lvl) => (
                  <SelectItem key={lvl} value={lvl}>{lvl}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsItem>
        )
      })}

      <SettingsActions
        onSave={() => void draft.save()}
        onCancel={() => draft.revert()}
        onReset={() => draft.resetToDefault()}
        saving={draft.saving}
        saveDisabled={!draft.dirty}
        cancelDisabled={!draft.dirty}
        isDefault={draft.isDefault}
        saveTestId={`debug-save-${categoryKey}`}
        cancelTestId={`debug-cancel-${categoryKey}`}
        resetTestId={`debug-reset-${categoryKey}`}
      />
      {status && (
        <span className={cn('text-sm', status.ok ? 'text-status-success' : 'text-status-error')}>
          {status.text}
        </span>
      )}
    </SettingsSection>
  )
}

export const DebugPanel = () => {
  const { t } = useI18n()
  const [config, setConfig] = useState<DebugConfig | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const data = await synthApi.getDebugConfig<DebugConfig>()
        setConfig(data)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const categories = useMemo(() => {
    const result: Record<DebugCategoryKey, Record<string, string>> = { ai: {}, service: {} }
    for (const [group, level] of Object.entries(config?.groups ?? {})) {
      result[categoryOf(group)][group] = level
    }
    return result
  }, [config])

  const availableLevels =
    config?.available_levels?.length ? config.available_levels : DEFAULT_LEVELS

  const handleSave = useCallback(
    async (groups: Record<string, string>) => {
      await synthApi.saveDebugConfig(groups)
      setConfig((prev) => (prev ? { ...prev, groups: { ...prev.groups, ...groups } } : prev))
    },
    [],
  )

  return (
    <SettingsPanel title={t('admin.debug.title')} description={t('admin.debug.description')}>
      {loading ? (
        <div className="bg-background rounded-xl border p-5 animate-pulse space-y-3">
          <div className="h-4 bg-muted rounded w-48" />
          <div className="h-4 bg-muted rounded w-32" />
        </div>
      ) : (
        CATEGORY_ORDER.filter((key) => Object.keys(categories[key]).length > 0).map((key) => (
          <DebugCategorySection
            key={key}
            categoryKey={key}
            title={t(`admin.debug.${key}`)}
            groups={categories[key]}
            availableLevels={availableLevels}
            onSave={handleSave}
          />
        ))
      )}
    </SettingsPanel>
  )
}
