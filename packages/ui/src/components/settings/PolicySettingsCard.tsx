import { useI18n } from '@/lib/i18n'
import type { ToolsPolicy } from '@/lib/api/synthApi'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsCard } from './settings-layout'

/**
 * AD-071 §2.3: карточка глобальной политики включения инструментов.
 * `scope` задаёт пространство i18n и эндпоинт-семейство:
 * - `tools` — встроенные инструменты (`tools.policy`, `toolsPolicy.*`);
 * - `mcp` — MCP-инструменты (`mcp.policy`, `mcpPolicy.*`).
 */
export function PolicySettingsCard({
  scope,
  value,
  loading,
  saving,
  error,
  onChange,
  onSave,
  className,
}: {
  scope: 'tools' | 'mcp'
  value: ToolsPolicy
  loading: boolean
  saving: boolean
  error?: string | null
  onChange: (value: ToolsPolicy) => void
  onSave: () => void
  className?: string
}) {
  const { t } = useI18n()
  const prefix = scope === 'tools' ? 'toolsPolicy' : 'mcpPolicy'
  const selectId = `${scope}-policy-select`

  return (
    <SettingsCard
      className={className}
      title={t(`${prefix}.title`)}
      description={t(`${prefix}.description`)}
    >
      {error && (
        <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor={selectId} className="text-sm font-medium">
          {t(`${prefix}.label`)}
        </label>
        {loading ? (
          <div role="status" aria-live="polite" className="text-center text-muted-foreground py-4 text-sm">
            {t('common.loading')}
          </div>
        ) : (
          <Select value={value} onValueChange={(next) => onChange(next as ToolsPolicy)}>
            <SelectTrigger id={selectId} className="w-full h-10" aria-label={t(`${prefix}.label`)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="consistency">{t(`${prefix}.consistency`)}</SelectItem>
              <SelectItem value="available">{t(`${prefix}.available`)}</SelectItem>
              <SelectItem value="auto">{t(`${prefix}.auto`)}</SelectItem>
            </SelectContent>
          </Select>
        )}
        <p className="text-xs text-muted-foreground">{t(`${prefix}.help`)}</p>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          data-testid={`${scope}-policy-save`}
          onClick={onSave}
          disabled={saving || loading}
          className="shrink-0 px-4 py-2 rounded-lg bg-interactive-accent text-interactive-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-[transform,opacity] duration-150 ease-out active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </SettingsCard>
  )
}
