/**
 * Настройки внешнего вида терминала (PROP-132, Ф4a).
 *
 * Раздел встраивается в «Настройки → Внешний вид». Хранение:
 * `ProfileData.preferences.terminal` (`PATCH /auth/profile/preferences`) +
 * локальный кэш `useUIStore.terminalPreferences` — терминал стартует сразу,
 * до ответа профиля.
 */

import { useMemo } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { profileService } from '@/lib/api/profileService'
import { useThemeSystem } from '@/contexts/useThemeSystem'
import { resolveTerminalTheme, TERMINAL_SCHEME_IDS } from '@/lib/theme/terminal'
import {
  DEFAULT_TERMINAL_PREFERENCES,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_OPTIONS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN,
  normalizeTerminalPreferences,
  type TerminalPreferences,
} from '@/lib/terminalPreferences'
import {
  NumberField,
  SelectField,
  SettingsActions,
  SettingsSection,
  ToggleField,
  useSettingsDraft,
} from '@/components/ui/settings'
import { SelectContent, SelectItem } from '@/components/ui/select'

export function TerminalSettings() {
  const { t } = useI18n()
  const { currentTheme } = useThemeSystem()
  const saved = useUIStore((s) => s.terminalPreferences)
  const setTerminalPreferences = useUIStore((s) => s.setTerminalPreferences)

  const draft = useSettingsDraft<TerminalPreferences>({
    value: saved,
    defaultValue: DEFAULT_TERMINAL_PREFERENCES,
    onSave: async (next) => {
      const normalized = normalizeTerminalPreferences(next)
      // Профиль — источник истины; локальный кэш обновляем сразу, чтобы
      // открытый терминал применил настройки без ожидания ответа.
      await profileService.syncToProfile('terminal', normalized)
      setTerminalPreferences(normalized)
      return normalized
    },
  })

  const current = draft.draft ?? saved
  const update = (patch: Partial<TerminalPreferences>) =>
    draft.setDraft({ ...current, ...patch })

  const palette = useMemo(
    () => resolveTerminalTheme(current.theme, currentTheme),
    [current.theme, currentTheme],
  )

  const schemeLabel = (id: string): string =>
    id === 'ui'
      ? t('settings.terminal.theme.ui')
      : t(`settings.terminal.theme.scheme.${id}`)

  const swatches = [
    palette.black,
    palette.red,
    palette.green,
    palette.yellow,
    palette.blue,
    palette.magenta,
    palette.cyan,
    palette.white,
  ]

  return (
    <SettingsSection
      id="terminal-appearance"
      title={t('settings.terminal.title')}
      description={t('settings.terminal.description')}
      tooltip={t('settings.help.terminal')}
    >
      <SelectField
        label={t('settings.terminal.theme.label')}
        description={t('settings.terminal.theme.description')}
        value={current.theme}
        onValueChange={(value) => update({ theme: value as TerminalPreferences['theme'] })}
        triggerTestId="terminal-theme-select"
        items={[
          { label: schemeLabel('ui'), value: 'ui' },
          ...TERMINAL_SCHEME_IDS.map((id) => ({ label: schemeLabel(id), value: id })),
        ]}
      >
        <SelectContent>
          <SelectItem value="ui">{schemeLabel('ui')}</SelectItem>
          {TERMINAL_SCHEME_IDS.map((id) => (
            <SelectItem key={id} value={id}>
              {schemeLabel(id)}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectField>

      {/* Превью палитры — видно, как будет выглядеть терминал. */}
      <div data-testid="terminal-palette-preview" className="flex flex-wrap items-center gap-1">
        {swatches.map((color, index) => (
          <span
            key={`${color}-${index}`}
            className="size-4 rounded-sm border border-border"
            style={{ backgroundColor: color }}
            title={color}
          />
        ))}
        <span
          className="ml-2 rounded px-2 py-0.5 text-xs"
          style={{ backgroundColor: palette.background, color: palette.foreground }}
        >
          {t('settings.terminal.palette.preview')}
        </span>
      </div>

      <SelectField
        label={t('settings.terminal.font.label')}
        description={t('settings.terminal.font.description')}
        value={current.fontFamily}
        onValueChange={(value) => update({ fontFamily: value })}
        triggerTestId="terminal-font-select"
        items={TERMINAL_FONT_OPTIONS.map((font) => ({ label: font, value: font }))}
      >
        <SelectContent>
          {TERMINAL_FONT_OPTIONS.map((font) => (
            <SelectItem key={font} value={font}>
              {font}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectField>

      {/* Превью шрифта. */}
      <div
        data-testid="terminal-font-preview"
        className="rounded-md border border-border bg-surface-subtle px-3 py-2 font-mono text-xs text-foreground"
        style={{
          fontFamily: `"${current.fontFamily}", monospace`,
          fontSize: `${current.fontSize}px`,
          lineHeight: current.lineHeight,
          letterSpacing: `${current.letterSpacing}px`,
        }}
      >
        {t('settings.terminal.font.preview')}
      </div>

      {/* Числовые поля, а не слайдеры: в разделе «Внешний вид» уже есть
          слайдер масштаба интерфейса, лишние `input[type=range]` ломают
          его контракт. */}
      <NumberField
        label={t('settings.terminal.fontSize.label')}
        suffix="px"
        value={String(current.fontSize)}
        min={TERMINAL_FONT_SIZE_MIN}
        max={TERMINAL_FONT_SIZE_MAX}
        step={1}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) update({ fontSize: value })
        }}
      />

      <NumberField
        label={t('settings.terminal.lineHeight.label')}
        value={current.lineHeight.toFixed(2)}
        min={TERMINAL_LINE_HEIGHT_MIN}
        max={TERMINAL_LINE_HEIGHT_MAX}
        step={0.05}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) update({ lineHeight: value })
        }}
      />

      <NumberField
        label={t('settings.terminal.letterSpacing.label')}
        suffix="px"
        value={String(current.letterSpacing)}
        min={0}
        max={4}
        step={0.5}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) update({ letterSpacing: value })
        }}
      />

      <SelectField
        label={t('settings.terminal.cursorStyle.label')}
        value={current.cursorStyle}
        onValueChange={(value) =>
          update({ cursorStyle: value as TerminalPreferences['cursorStyle'] })
        }
        triggerTestId="terminal-cursor-style-select"
        items={TERMINAL_CURSOR_STYLES.map((style) => ({
          label: t(`settings.terminal.cursorStyle.${style}`),
          value: style,
        }))}
      >
        <SelectContent>
          {TERMINAL_CURSOR_STYLES.map((style) => (
            <SelectItem key={style} value={style}>
              {t(`settings.terminal.cursorStyle.${style}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectField>

      <ToggleField
        label={t('settings.terminal.cursorBlink.label')}
        description={t('settings.terminal.cursorBlink.description')}
        enabled={current.cursorBlink}
        onToggle={() => update({ cursorBlink: !current.cursorBlink })}
      />

      <NumberField
        label={t('settings.terminal.scrollback.label')}
        description={t('settings.terminal.scrollback.description')}
        value={String(current.scrollback)}
        min={TERMINAL_SCROLLBACK_MIN}
        max={TERMINAL_SCROLLBACK_MAX}
        step={1000}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) update({ scrollback: value })
        }}
      />

      <ToggleField
        label={t('settings.terminal.bell.label')}
        description={t('settings.terminal.bell.description')}
        enabled={current.bell}
        onToggle={() => update({ bell: !current.bell })}
      />

      <SettingsActions
        align="start"
        onSave={() => void draft.save()}
        onCancel={() => draft.revert()}
        onReset={() => draft.resetToDefault()}
        saving={draft.saving}
        saveDisabled={!draft.dirty}
        cancelDisabled={!draft.dirty}
        isDefault={draft.isDefault}
        saveTestId="terminal-settings-save"
        cancelTestId="terminal-settings-cancel"
        resetTestId="terminal-settings-reset"
      />
    </SettingsSection>
  )
}
