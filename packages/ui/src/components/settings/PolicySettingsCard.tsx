import { useI18n } from '@/lib/i18n'
import type { ToolsPolicy } from '@/lib/api/synthApi'
import {
  DefaultsBadge,
  SelectField,
  SettingsActions,
  SettingsSection,
} from '../ui/settings'
import { SelectContent, SelectItem } from '../ui/select'

/**
 * ADR-071 §2.3 / ADR-072: карточка глобальной политики включения инструментов.
 * `scope` задаёт пространство i18n и эндпоинт-семейство:
 * - `tools` — встроенные инструменты (`tools.policy`, `toolsPolicy.*`);
 * - `mcp` — MCP-инструменты (`mcp.policy`, `mcpPolicy.*`);
 * - `skills` — скиллы (`skills.policy`, `skillsPolicy.*`).
 */
export function PolicySettingsCard({
  scope,
  value,
  savedValue,
  loading,
  saving,
  error,
  onChange,
  onSave,
  onReset,
  isDefault,
  className,
  tooltip,
  fieldTooltip,
  id,
  advanced = false,
}: {
  scope: 'tools' | 'mcp' | 'skills'
  value: ToolsPolicy
  savedValue: ToolsPolicy
  loading: boolean
  saving: boolean
  error?: string | null
  onChange: (value: ToolsPolicy) => void
  onSave: () => void
  onReset?: () => void
  isDefault?: boolean
  className?: string
  /** Подсказка-иконка (ⓘ) в заголовке секции. */
  tooltip?: string
  /** Подсказка-иконка (ⓘ) рядом с лейблом выбора политики. */
  fieldTooltip?: string
  /** Якорь секции для поиска и фокуса (`data-settings-section`). */
  id?: string
  /** Секция относится к продвинутым настройкам. */
  advanced?: boolean
}) {
  const { t } = useI18n()
  const prefix = scope === 'tools' ? 'toolsPolicy' : scope === 'mcp' ? 'mcpPolicy' : 'skillsPolicy'
  const dirty = value !== savedValue

  return (
    <SettingsSection
      id={id}
      className={className}
      title={t(`${prefix}.title`)}
      description={t(`${prefix}.description`)}
      tooltip={tooltip}
      actions={isDefault ? <DefaultsBadge /> : undefined}
      advanced={advanced}
    >
      {error && (
        <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div role="status" aria-live="polite" className="text-center text-muted-foreground py-4 text-sm">
          {t('common.loading')}
        </div>
      ) : (
        <SelectField
          label={t(`${prefix}.label`)}
          description={t(`${prefix}.help`)}
          tooltip={fieldTooltip}
          value={value}
          onValueChange={(next) => onChange(next as ToolsPolicy)}
          ariaLabel={t(`${prefix}.label`)}
        >
          <SelectContent>
            <SelectItem value="consistency">{t(`${prefix}.consistency`)}</SelectItem>
            <SelectItem value="available">{t(`${prefix}.available`)}</SelectItem>
            <SelectItem value="auto">{t(`${prefix}.auto`)}</SelectItem>
          </SelectContent>
        </SelectField>
      )}

      <SettingsActions
        onSave={onSave}
        onCancel={() => onChange(savedValue)}
        onReset={onReset}
        saveDisabled={loading || !dirty}
        saving={saving}
        cancelDisabled={loading || !dirty}
        resetDisabled={loading}
        isDefault={isDefault}
        saveTestId={`${scope}-policy-save`}
        cancelTestId={`${scope}-policy-cancel`}
        resetTestId={`${scope}-policy-reset`}
      />
    </SettingsSection>
  )
}
