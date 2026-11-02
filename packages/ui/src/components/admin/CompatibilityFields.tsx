import { useState } from 'react'

import { Icon } from '@/components/icon/Icon'
import { SelectContent, SelectItem } from '@/components/ui/select'
import { useI18n } from '@/lib/i18n'
import {
  CACHE_FORMAT_OPTIONS,
  COMPATIBILITY_CUSTOM,
  MAX_TOKENS_FIELD_OPTIONS,
  REASONING_FIELD_OPTIONS,
  hasCompatibilityDraftChanges,
  type CompatibilityDraft,
  type CompatibilityTristate,
} from '@/lib/api/compatibility'
import { NATIVE_AUDIO_FORMATS, type NativeAudioFormat } from '@itphx/synth-shared/types'
import { MultiSelectField, SelectField, TextField } from '../ui/settings'

/** Варианты tri-state: «Авто / Да / Нет». */
const TRISTATE_OPTIONS: CompatibilityTristate[] = ['', 'true', 'false']

export interface CompatibilityFieldsProps {
  draft: CompatibilityDraft
  onChange: (next: CompatibilityDraft) => void
  /**
   * У сущности уже сохранены параметры совместимости: блок раскрыт по умолчанию
   * (пользователь сразу видит, что настроено). У новой сущности — свёрнут.
   */
  saved?: boolean
}

/**
 * Сворачиваемый блок «Расширенные параметры» для форм провайдера и модели.
 *
 * Семантика (общая для обеих панелей): не заданное поле = «авто» на сервере,
 * поэтому в payload уходят только выбранные значения, а полная очистка у
 * сущности с сохранёнными параметрами отправляет `compatibility: null`.
 */
export function CompatibilityFields({ draft, onChange, saved = false }: CompatibilityFieldsProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(saved)
  const changed = hasCompatibilityDraftChanges(draft)

  const update = (patch: Partial<CompatibilityDraft>) => onChange({ ...draft, ...patch })

  const tristateLabel = (value: CompatibilityTristate) =>
    value === 'true'
      ? t('admin.compatibility.yes')
      : value === 'false'
        ? t('admin.compatibility.no')
        : t('admin.compatibility.auto')

  const reasoningAutoLabel = t('admin.compatibility.autoWith', { value: 'reasoning_content' })

  const tristateItems = TRISTATE_OPTIONS.map((value) => ({
    value,
    label: tristateLabel(value),
  }))

  // ADR-117: «Аудио нативно» — режим (авто / явный список / явный пустой список).
  const nativeAudioModeItems = [
    { value: '', label: t('admin.compatibility.nativeAudioAuto') },
    { value: COMPATIBILITY_CUSTOM, label: t('admin.compatibility.nativeAudioCustom') },
    { value: 'none', label: t('admin.compatibility.nativeAudioNone') },
  ]

  const nativeAudioFormatOptions = NATIVE_AUDIO_FORMATS.map((format) => ({
    value: format,
    label: format,
  }))

  return (
    <div className="min-w-0 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="compatibility-toggle"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground min-w-0"
        >
          <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3 shrink-0" />
          <span className="min-w-0 break-words">{t('admin.compatibility.title')}</span>
        </button>
        {changed && (
          <span
            data-testid="compatibility-badge"
            className="px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-secondary text-secondary-foreground"
          >
            {t('admin.compatibility.changed')}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground min-w-0 break-words">
        {t('admin.compatibility.hint')}
      </p>

      {open && (
        <div
          data-testid="compatibility-panel"
          className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-0"
        >
          <SelectField
            label={t('admin.compatibility.reasoningField')}
            tooltip={t('admin.compatibility.reasoningFieldHint')}
            value={draft.reasoningField}
            onValueChange={(value) => update({ reasoningField: value })}
            ariaLabel={t('admin.compatibility.reasoningField')}
            triggerTestId="compatibility-reasoning-field"
            items={[
              { value: '', label: reasoningAutoLabel },
              ...REASONING_FIELD_OPTIONS.map((value) => ({ value, label: value })),
              { value: COMPATIBILITY_CUSTOM, label: t('admin.compatibility.custom') },
            ]}
          >
            <SelectContent>
              <SelectItem value="">{reasoningAutoLabel}</SelectItem>
              {REASONING_FIELD_OPTIONS.map((value) => (
                <SelectItem key={value} value={value}>{value}</SelectItem>
              ))}
              <SelectItem value={COMPATIBILITY_CUSTOM}>{t('admin.compatibility.custom')}</SelectItem>
            </SelectContent>
          </SelectField>

          {draft.reasoningField === COMPATIBILITY_CUSTOM && (
            <TextField
              label={t('admin.compatibility.reasoningFieldCustom')}
              tooltip={t('admin.compatibility.reasoningFieldHint')}
              value={draft.reasoningFieldCustom}
              onChange={(e) => update({ reasoningFieldCustom: e.target.value })}
              placeholder="reasoning_content"
              data-testid="compatibility-reasoning-custom"
            />
          )}

          <SelectField
            label={t('admin.compatibility.requireReasoning')}
            tooltip={t('admin.compatibility.requireReasoningHint')}
            value={draft.requireReasoning}
            onValueChange={(value) => update({ requireReasoning: value as CompatibilityTristate })}
            ariaLabel={t('admin.compatibility.requireReasoning')}
            triggerTestId="compatibility-require-reasoning"
            items={tristateItems}
          >
            <SelectContent>
              {tristateItems.map((item) => (
                <SelectItem key={item.value || 'auto'} value={item.value}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          <SelectField
            label={t('admin.compatibility.maxTokensField')}
            tooltip={t('admin.compatibility.maxTokensFieldHint')}
            value={draft.maxTokensField}
            onValueChange={(value) =>
              update({ maxTokensField: value as CompatibilityDraft['maxTokensField'] })
            }
            ariaLabel={t('admin.compatibility.maxTokensField')}
            triggerTestId="compatibility-max-tokens-field"
            items={[
              { value: '', label: t('admin.compatibility.autoWith', { value: 'max_tokens' }) },
              ...MAX_TOKENS_FIELD_OPTIONS.map((value) => ({ value, label: value })),
            ]}
          >
            <SelectContent>
              <SelectItem value="">{t('admin.compatibility.autoWith', { value: 'max_tokens' })}</SelectItem>
              {MAX_TOKENS_FIELD_OPTIONS.map((value) => (
                <SelectItem key={value} value={value}>{value}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          <SelectField
            label={t('admin.compatibility.cacheFormat')}
            tooltip={t('admin.compatibility.cacheFormatHint')}
            value={draft.cacheFormat}
            onValueChange={(value) =>
              update({ cacheFormat: value as CompatibilityDraft['cacheFormat'] })
            }
            ariaLabel={t('admin.compatibility.cacheFormat')}
            triggerTestId="compatibility-cache-format"
            items={[
              { value: '', label: t('admin.compatibility.cacheFormatAuto') },
              ...CACHE_FORMAT_OPTIONS.map((value) => ({ value, label: value })),
            ]}
          >
            <SelectContent>
              <SelectItem value="">{t('admin.compatibility.cacheFormatAuto')}</SelectItem>
              {CACHE_FORMAT_OPTIONS.map((value) => (
                <SelectItem key={value} value={value}>{value}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          <SelectField
            label={t('admin.compatibility.requireAssistantAfterTool')}
            tooltip={t('admin.compatibility.requireAssistantAfterToolHint')}
            value={draft.requireAssistantAfterTool}
            onValueChange={(value) =>
              update({ requireAssistantAfterTool: value as CompatibilityTristate })
            }
            ariaLabel={t('admin.compatibility.requireAssistantAfterTool')}
            triggerTestId="compatibility-require-assistant-after-tool"
            items={tristateItems}
          >
            <SelectContent>
              {tristateItems.map((item) => (
                <SelectItem key={item.value || 'auto'} value={item.value}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          <SelectField
            label={t('admin.compatibility.streamUsage')}
            tooltip={t('admin.compatibility.streamUsageHint')}
            value={draft.streamUsage}
            onValueChange={(value) => update({ streamUsage: value as CompatibilityTristate })}
            ariaLabel={t('admin.compatibility.streamUsage')}
            triggerTestId="compatibility-stream-usage"
            items={tristateItems.map((item) => ({
              ...item,
              label: item.value === '' ? t('admin.compatibility.autoWith', { value: t('admin.compatibility.on') }) : item.label,
            }))}
          >
            <SelectContent>
              <SelectItem value="">{t('admin.compatibility.autoWith', { value: t('admin.compatibility.on') })}</SelectItem>
              {tristateItems
                .filter((item) => item.value !== '')
                .map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
            </SelectContent>
          </SelectField>

          <SelectField
            label={t('admin.compatibility.supportsToolChoice')}
            tooltip={t('admin.compatibility.supportsToolChoiceHint')}
            value={draft.supportsToolChoice}
            onValueChange={(value) => update({ supportsToolChoice: value as CompatibilityTristate })}
            ariaLabel={t('admin.compatibility.supportsToolChoice')}
            triggerTestId="compatibility-supports-tool-choice"
            items={tristateItems}
          >
            <SelectContent>
              {tristateItems.map((item) => (
                <SelectItem key={item.value || 'auto'} value={item.value}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          <SelectField
            label={t('admin.compatibility.requireFinishReason')}
            tooltip={t('admin.compatibility.requireFinishReasonHint')}
            value={draft.requireFinishReason}
            onValueChange={(value) =>
              update({ requireFinishReason: value as CompatibilityTristate })
            }
            ariaLabel={t('admin.compatibility.requireFinishReason')}
            triggerTestId="compatibility-require-finish-reason"
            items={tristateItems.map((item) => ({
              ...item,
              label: item.value === ''
                ? t('admin.compatibility.autoWith', { value: t('admin.compatibility.yes') })
                : item.label,
            }))}
          >
            <SelectContent>
              <SelectItem value="">
                {t('admin.compatibility.autoWith', { value: t('admin.compatibility.yes') })}
              </SelectItem>
              {tristateItems
                .filter((item) => item.value !== '')
                .map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
            </SelectContent>
          </SelectField>
          <SelectField
            label={t('admin.compatibility.supportsEffortUpdates')}
            tooltip={t('admin.compatibility.supportsEffortUpdatesHint')}
            value={draft.supportsEffortUpdates}
            onValueChange={(value) =>
              update({ supportsEffortUpdates: value as CompatibilityTristate })
            }
            ariaLabel={t('admin.compatibility.supportsEffortUpdates')}
            triggerTestId="compatibility-supports-effort-updates"
            items={tristateItems.map((item) => ({
              ...item,
              label: item.value === ''
                ? t('admin.compatibility.autoWith', { value: t('admin.compatibility.no') })
                : item.label,
            }))}
          >
            <SelectContent>
              <SelectItem value="">
                {t('admin.compatibility.autoWith', { value: t('admin.compatibility.no') })}
              </SelectItem>
              {tristateItems
                .filter((item) => item.value !== '')
                .map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
            </SelectContent>
          </SelectField>

          <SelectField
            label={t('admin.compatibility.supportsNativeVideo')}
            tooltip={t('admin.compatibility.supportsNativeVideoHint')}
            value={draft.supportsNativeVideo}
            onValueChange={(value) => update({ supportsNativeVideo: value as CompatibilityTristate })}
            ariaLabel={t('admin.compatibility.supportsNativeVideo')}
            triggerTestId="compatibility-supports-native-video"
            items={tristateItems}
          >
            <SelectContent>
              {tristateItems.map((item) => (
                <SelectItem key={item.value || 'auto'} value={item.value}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          <SelectField
            label={t('admin.compatibility.nativeAudioFormats')}
            tooltip={t('admin.compatibility.nativeAudioFormatsHint')}
            value={draft.nativeAudioFormatsMode}
            onValueChange={(value) =>
              update({ nativeAudioFormatsMode: value as CompatibilityDraft['nativeAudioFormatsMode'] })
            }
            ariaLabel={t('admin.compatibility.nativeAudioFormats')}
            triggerTestId="compatibility-native-audio-formats"
            items={nativeAudioModeItems}
          >
            <SelectContent>
              {nativeAudioModeItems.map((item) => (
                <SelectItem key={item.value || 'auto'} value={item.value}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          {draft.nativeAudioFormatsMode === COMPATIBILITY_CUSTOM && (
            <MultiSelectField
              label={t('admin.compatibility.nativeAudioFormatList')}
              tooltip={t('admin.compatibility.nativeAudioFormatListHint')}
              values={draft.nativeAudioFormats}
              options={nativeAudioFormatOptions}
              onChange={(next) => update({ nativeAudioFormats: next as NativeAudioFormat[] })}
              emptyText={t('admin.compatibility.nativeAudioFormatListEmpty')}
              testIdPrefix="compatibility-native-audio-format"
            />
          )}
        </div>
      )}

      {/* Подсказка «своё значение» — только когда выбран этот режим: иначе поле
          ввода пустое и выглядит как потерянное. */}
      {open && draft.reasoningField === COMPATIBILITY_CUSTOM && !draft.reasoningFieldCustom.trim() && (
        <p className="mt-1 text-xs text-muted-foreground min-w-0 break-words">
          {t('admin.compatibility.reasoningFieldCustomHint')}
        </p>
      )}
    </div>
  )
}
