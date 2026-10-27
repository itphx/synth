import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import {
  synthApi,
  type AttachmentsSettings,
  type AttachmentsSettingsInfo,
} from '@/lib/api/synthApi'
import { Icon } from '../icon/Icon'
import {
  InfoField,
  NumberField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  TextField,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'

/** Байт в MiB: 1024-основание (как в UI-лимитах вложений). */
export const MIB_BYTES = 1024 * 1024

/** Бейдж состояния (источник/переопределение) — общий вид с админкой «Метрики». */
const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа источника настройки. */
const SOURCE_BADGE_CLASS: Record<AttachmentsSettingsInfo['source'], string> = {
  env: 'bg-status-warning/15 text-status-warning',
  runtime: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
}

/** Поля секции `attachments` — env-локи проверяются по этому списку. */
const ATTACHMENTS_FIELDS = [
  'enabled',
  'modalities',
  'maxBytesPerFile',
  'maxFilesPerMessage',
  'maxBytesPerSession',
  'gcDays',
  'workspaceFallback',
  'allowedMimePrefixes',
] as const

/**
 * Черновик формы (ADR-072): числа — строками, чтобы пользователь мог стереть
 * значение и ввести новое, а MIME-список — одной строкой через запятую.
 */
export interface AttachmentsForm {
  enabled: boolean
  image: boolean
  pdf: boolean
  audio: boolean
  video: boolean
  /** Максимум на файл, MiB (целое). */
  maxFileMiB: string
  /** Файлов в сообщении. */
  maxFilesPerMessage: string
  /** Лимит на сессию, MiB. */
  maxSessionMiB: string
  /** Срок хранения осиротевших вложений, дней (`0` — не удалять). */
  gcDays: string
  workspaceFallback: boolean
  /** Белый список MIME-префиксов одной строкой через запятую. */
  mimePrefixes: string
}

/** Байты → MiB для поля ввода: до 2 знаков, без лишних нулей. */
export function bytesToMiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0'
  return String(Number((bytes / MIB_BYTES).toFixed(2)))
}

/** MiB из поля ввода → байты; `null` — значение не число. */
export function mibToBytes(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.round(parsed * MIB_BYTES)
}

/** Целое неотрицательное из поля ввода; `null` — не число/не целое/отрицательное. */
function parseIntField(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null
  return parsed
}

/** MIME-список из строки: пустые элементы отбрасываются. */
export function parseMimePrefixes(text: string): { values: string[]; hasEmpty: boolean } {
  const parts = text.split(',')
  const values: string[] = []
  let hasEmpty = false
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed) values.push(trimmed)
    else hasEmpty = true
  }
  // Пустая строка целиком — не ошибка: список просто не задан.
  if (!text.trim()) hasEmpty = false
  return { values, hasEmpty }
}

/** MIME-список → строка для поля ввода. */
export function formatMimePrefixes(values: string[]): string {
  return values.join(', ')
}

/** Настройки сервера → черновик формы. */
export function formFromAttachments(settings: AttachmentsSettings): AttachmentsForm {
  return {
    enabled: settings.enabled,
    image: settings.modalities.image,
    pdf: settings.modalities.pdf,
    audio: settings.modalities.audio,
    video: settings.modalities.video,
    maxFileMiB: bytesToMiB(settings.maxBytesPerFile),
    maxFilesPerMessage: String(settings.maxFilesPerMessage),
    maxSessionMiB: bytesToMiB(settings.maxBytesPerSession),
    gcDays: String(settings.gcDays),
    workspaceFallback: settings.workspaceFallback,
    mimePrefixes: formatMimePrefixes(settings.allowedMimePrefixes),
  }
}

/**
 * Поле зафиксировано env? Поддерживаем и точечные имена (`modalities.image`),
 * и групповые (`modalities` — блокирует все модальности).
 */
export function isEnvLockedField(envLocked: readonly string[], field: string): boolean {
  return envLocked.some((locked) => locked === field || field.startsWith(`${locked}.`))
}

/**
 * Тело PUT: полный набор настроек без env-зафиксированных полей.
 *
 * Порядок в API заменяет runtime-секцию целиком (не мержит), поэтому отправляем
 * все поля: неизменённые берутся из сохранённых настроек (байты без потерь от
 * пересчёта MiB), изменённые — из черновика. Поля из `envLocked` не отправляются:
 * значение задано через env и переопределяется только там (иначе сервер вернёт 409).
 */
export function buildAttachmentsBody(
  draft: AttachmentsForm,
  saved: AttachmentsForm,
  savedSettings: AttachmentsSettings,
  envLocked: readonly string[] = [],
): Partial<AttachmentsSettings> {
  const body: Partial<AttachmentsSettings> = {
    enabled: draft.enabled,
    modalities: {
      image: draft.image,
      pdf: draft.pdf,
      audio: draft.audio,
      video: draft.video,
    },
    maxBytesPerFile:
      draft.maxFileMiB === saved.maxFileMiB
        ? savedSettings.maxBytesPerFile
        : (mibToBytes(draft.maxFileMiB) ?? savedSettings.maxBytesPerFile),
    maxFilesPerMessage:
      draft.maxFilesPerMessage === saved.maxFilesPerMessage
        ? savedSettings.maxFilesPerMessage
        : (parseIntField(draft.maxFilesPerMessage) ?? savedSettings.maxFilesPerMessage),
    maxBytesPerSession:
      draft.maxSessionMiB === saved.maxSessionMiB
        ? savedSettings.maxBytesPerSession
        : (mibToBytes(draft.maxSessionMiB) ?? savedSettings.maxBytesPerSession),
    gcDays:
      draft.gcDays === saved.gcDays
        ? savedSettings.gcDays
        : (parseIntField(draft.gcDays) ?? savedSettings.gcDays),
    workspaceFallback: draft.workspaceFallback,
    allowedMimePrefixes:
      draft.mimePrefixes === saved.mimePrefixes
        ? [...savedSettings.allowedMimePrefixes]
        : parseMimePrefixes(draft.mimePrefixes).values,
  }

  for (const field of ATTACHMENTS_FIELDS) {
    if (isEnvLockedField(envLocked, field)) delete body[field]
  }
  return body
}

/** Ошибки валидации формы — i18n-ключи по полям (пусто — форма валидна). */
export interface AttachmentsFormErrors {
  maxFileMiB?: string
  maxFilesPerMessage?: string
  maxSessionMiB?: string
  gcDays?: string
  mime?: string
}

/** Валидация черновика: непустые/целые числа и отсутствие пустых MIME-элементов. */
export function validateAttachmentsForm(form: AttachmentsForm): AttachmentsFormErrors {
  const errors: AttachmentsFormErrors = {}
  // Сервер принимает лимиты только целыми байтами ≥ 1 (MiB → байты с округлением).
  const fileBytes = mibToBytes(form.maxFileMiB)
  if (fileBytes === null || fileBytes < 1) {
    errors.maxFileMiB = 'settings.attachments.limits.fileInvalid'
  }
  const files = parseIntField(form.maxFilesPerMessage)
  if (files === null || files < 1) {
    errors.maxFilesPerMessage = 'settings.attachments.limits.filesInvalid'
  }
  const sessionBytes = mibToBytes(form.maxSessionMiB)
  if (sessionBytes === null || sessionBytes < 1) {
    errors.maxSessionMiB = 'settings.attachments.limits.sessionInvalid'
  }
  if (parseIntField(form.gcDays) === null) {
    errors.gcDays = 'settings.attachments.storage.invalid'
  }
  if (parseMimePrefixes(form.mimePrefixes).hasEmpty) {
    errors.mime = 'settings.attachments.mime.empty'
  }
  return errors
}

/** Список включённых модальностей «работающего» набора — для строки статуса. */
function runningModalities(settings: AttachmentsSettings): string {
  const keys: Array<keyof AttachmentsSettings['modalities']> = ['image', 'pdf', 'audio', 'video']
  const enabled = keys.filter((key) => settings.modalities[key])
  if (enabled.length === 0) return '—'
  return enabled.join(', ')
}

/**
 * ADR-115 / ADR-072: админ-раздел «Мультимодальный ввод» — runtime-настройки
 * вложений сообщений (`GET/PUT/DELETE /settings/attachments`): мастер-выключатель,
 * поддерживаемые модальности, лимиты размера/количества, срок хранения
 * осиротевших файлов, сохранение несовместимых вложений в рабочий каталог и
 * белый список MIME. Мутации — ADMIN (guard сервера).
 *
 * Поля из `envLocked` в UI недоступны и в тело PUT не попадают: значение задано
 * через env и переопределяется только там. Изменения применяются сразу
 * (`restartRequired` для вложений — `false`).
 */
export function MultimodalSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [info, setInfo] = useState<AttachmentsSettingsInfo | null>(null)
  const [defaults, setDefaults] = useState<AttachmentsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const savedForm = useMemo(
    () => (info ? formFromAttachments(info.attachments) : null),
    [info],
  )
  const defaultForm = useMemo(
    () => (defaults ? formFromAttachments(defaults) : null),
    [defaults],
  )

  const draft = useSettingsDraft<AttachmentsForm>({
    value: savedForm,
    defaultValue: defaultForm,
  })

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await synthApi.getAttachmentsSettings()
      setInfo(res)
      setDefaults(res.defaults)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('settings.attachments.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const envLocked = info?.envLocked ?? []
  const locked = useCallback(
    (field: string) => isEnvLockedField(envLocked, field),
    [envLocked],
  )

  const current = draft.draft
  const errors = current ? validateAttachmentsForm(current) : {}
  const hasErrors = Object.keys(errors).length > 0

  const handleSave = useCallback(async () => {
    if (!draft.draft || !draft.saved || !info || hasErrors) return
    const body = buildAttachmentsBody(
      draft.draft,
      draft.saved,
      info.attachments,
      envLocked,
    )
    // Все поля зафиксированы env — отправлять нечего.
    if (Object.keys(body).length === 0) return
    setSaving(true)
    try {
      const res = await synthApi.updateAttachmentsSettings(body)
      setInfo(res)
      setDefaults(res.defaults)
      draft.setDraft(formFromAttachments(res.attachments))
      notify({ text: t('settings.attachments.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('settings.attachments.saveError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }, [draft, envLocked, hasErrors, info, notify, t])

  const handleReset = useCallback(async () => {
    setSaving(true)
    try {
      const res = await synthApi.resetAttachmentsSettings()
      setInfo(res)
      setDefaults(res.defaults)
      draft.setDraft(formFromAttachments(res.attachments))
      notify({ text: t('settings.attachments.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('settings.attachments.saveError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }, [draft, notify, t])

  const source = info?.source ?? 'default'
  const running = info?.running ?? null

  return (
    <SettingsPanel
      title={t('settings.attachments.title')}
      description={t('settings.attachments.description')}
    >
      {/* 1. Состояние: источник, признак runtime-override, что работает сейчас */}
      <SettingsSection
        id="attachments-status"
        title={t('settings.attachments.status.title')}
        description={t('settings.attachments.status.description')}
        tooltip={t('settings.help.attachments.section.attachments-status')}
      >
        {loadError && (
          <div
            role="alert"
            data-testid="attachments-load-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {loadError}
          </div>
        )}

        {loading && !info && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {info && (
          <>
            <div
              className="flex flex-wrap items-center gap-1.5 min-w-0"
              data-testid="attachments-badges"
            >
              <span
                data-testid="attachments-source-badge"
                className={cn(BADGE, SOURCE_BADGE_CLASS[source])}
              >
                {t(`settings.attachments.source.${source}`)}
              </span>
              {info.isOverridden && (
                <span
                  data-testid="attachments-overridden-badge"
                  className={cn(BADGE, 'bg-primary/15 text-primary')}
                >
                  {t('settings.attachments.status.overridden')}
                </span>
              )}
              <span
                data-testid="attachments-running-badge"
                className={cn(
                  BADGE,
                  running?.enabled
                    ? 'bg-status-success/15 text-status-success'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {running?.enabled
                  ? t('settings.attachments.state.enabled')
                  : t('settings.attachments.state.disabled')}
              </span>
            </div>

            <div className="space-y-1.5 min-w-0" data-testid="attachments-status">
              <InfoField
                label={t('settings.attachments.status.source')}
                value={t(`settings.attachments.source.${source}`)}
              />
              <InfoField
                label={t('settings.attachments.status.running')}
                value={
                  running?.enabled
                    ? t('settings.attachments.state.enabled')
                    : t('settings.attachments.state.disabled')
                }
              />
              <InfoField
                label={t('settings.attachments.status.runningModalities')}
                value={running ? runningModalities(running) : '—'}
                mono
              />
            </div>

            {info.restartRequired && (
              <div
                data-testid="attachments-restart-required"
                className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-3 text-xs text-status-warning min-w-0"
              >
                <Icon name="refresh" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{t('settings.attachments.restartRequired')}</span>
              </div>
            )}
          </>
        )}
      </SettingsSection>

      {/* 2. Мастер-выключатель */}
      <SettingsSection
        id="attachments-general"
        title={t('settings.attachments.general.title')}
        description={t('settings.attachments.general.description')}
        tooltip={t('settings.help.attachments.section.attachments-general')}
      >
        {current && (
          <>
            <ToggleField
              label={t('settings.attachments.enabled.label')}
              description={t('settings.attachments.enabled.hint')}
              tooltip={t('settings.help.attachments.enabled')}
              enabled={current.enabled}
              disabled={locked('enabled')}
              onToggle={() => draft.update({ enabled: !current.enabled })}
              ariaLabel={t('settings.attachments.enabled.label')}
            />
            {locked('enabled') && (
              <p
                data-testid="attachments-env-locked"
                className="text-xs text-status-warning break-words"
              >
                {t('settings.attachments.envLocked')}
              </p>
            )}
          </>
        )}
      </SettingsSection>

      {/* 3. Поддерживаемые модальности */}
      <SettingsSection
        id="attachments-modalities"
        title={t('settings.attachments.modalities.title')}
        description={t('settings.attachments.modalities.description')}
        tooltip={t('settings.help.attachments.section.attachments-modalities')}
      >
        {current && (
          <>
            <ToggleField
              label={t('settings.attachments.modalities.image')}
              description={t('settings.attachments.modalities.imageHint')}
              enabled={current.image}
              disabled={locked('modalities.image')}
              onToggle={() => draft.update({ image: !current.image })}
              ariaLabel={t('settings.attachments.modalities.image')}
            />
            <ToggleField
              label={t('settings.attachments.modalities.pdf')}
              description={t('settings.attachments.modalities.pdfHint')}
              enabled={current.pdf}
              disabled={locked('modalities.pdf')}
              onToggle={() => draft.update({ pdf: !current.pdf })}
              ariaLabel={t('settings.attachments.modalities.pdf')}
            />
            <ToggleField
              label={t('settings.attachments.modalities.audio')}
              description={t('settings.attachments.modalities.audioHint')}
              enabled={current.audio}
              disabled={locked('modalities.audio')}
              onToggle={() => draft.update({ audio: !current.audio })}
              ariaLabel={t('settings.attachments.modalities.audio')}
            />
            <ToggleField
              label={t('settings.attachments.modalities.video')}
              description={t('settings.attachments.modalities.videoHint')}
              enabled={current.video}
              disabled={locked('modalities.video')}
              onToggle={() => draft.update({ video: !current.video })}
              ariaLabel={t('settings.attachments.modalities.video')}
            />
          </>
        )}
      </SettingsSection>

      {/* 4. Лимиты: размер файла/сессии в MiB (в API — байты), файлов в сообщении */}
      <SettingsSection
        id="attachments-limits"
        title={t('settings.attachments.limits.title')}
        description={t('settings.attachments.limits.description')}
        tooltip={t('settings.help.attachments.section.attachments-limits')}
      >
        {current && (
          <>
            <NumberField
              label={t('settings.attachments.limits.maxFile')}
              description={t('settings.attachments.limits.maxFileHint')}
              tooltip={t('settings.help.attachments.maxFile')}
              step={1}
              suffix={t('settings.attachments.unitMiB')}
              value={current.maxFileMiB}
              onChange={(e) => draft.update({ maxFileMiB: e.target.value })}
              error={errors.maxFileMiB ? t(errors.maxFileMiB) : undefined}
              disabled={locked('maxBytesPerFile')}
              id="attachments-max-file"
              data-testid="attachments-max-file"
            />
            <NumberField
              label={t('settings.attachments.limits.maxFiles')}
              description={t('settings.attachments.limits.maxFilesHint')}
              tooltip={t('settings.help.attachments.maxFiles')}
              min={1}
              step={1}
              value={current.maxFilesPerMessage}
              onChange={(e) => draft.update({ maxFilesPerMessage: e.target.value })}
              error={errors.maxFilesPerMessage ? t(errors.maxFilesPerMessage) : undefined}
              disabled={locked('maxFilesPerMessage')}
              id="attachments-max-files"
              data-testid="attachments-max-files"
            />
            <NumberField
              label={t('settings.attachments.limits.maxSession')}
              description={t('settings.attachments.limits.maxSessionHint')}
              tooltip={t('settings.help.attachments.maxSession')}
              step={1}
              suffix={t('settings.attachments.unitMiB')}
              value={current.maxSessionMiB}
              onChange={(e) => draft.update({ maxSessionMiB: e.target.value })}
              error={errors.maxSessionMiB ? t(errors.maxSessionMiB) : undefined}
              disabled={locked('maxBytesPerSession')}
              id="attachments-max-session"
              data-testid="attachments-max-session"
            />
          </>
        )}
      </SettingsSection>

      {/* 5. Хранение: срок жизни осиротевших вложений */}
      <SettingsSection
        id="attachments-storage"
        title={t('settings.attachments.storage.title')}
        description={t('settings.attachments.storage.description')}
        tooltip={t('settings.help.attachments.section.attachments-storage')}
      >
        {current && (
          <NumberField
            label={t('settings.attachments.storage.gcDays')}
            description={t('settings.attachments.storage.gcDaysHint')}
            tooltip={t('settings.help.attachments.gcDays')}
            min={0}
            step={1}
            suffix={t('settings.attachments.unitDays')}
            value={current.gcDays}
            onChange={(e) => draft.update({ gcDays: e.target.value })}
            error={errors.gcDays ? t(errors.gcDays) : undefined}
            disabled={locked('gcDays')}
            id="attachments-gc-days"
            data-testid="attachments-gc-days"
          />
        )}
      </SettingsSection>

      {/* 6. Поведение: несовместимые вложения → рабочий каталог */}
      <SettingsSection
        id="attachments-behavior"
        title={t('settings.attachments.behavior.title')}
        description={t('settings.attachments.behavior.description')}
        tooltip={t('settings.help.attachments.section.attachments-behavior')}
      >
        {current && (
          <ToggleField
            label={t('settings.attachments.behavior.workspaceFallback')}
            description={t('settings.attachments.behavior.workspaceFallbackHint')}
            tooltip={t('settings.help.attachments.workspaceFallback')}
            enabled={current.workspaceFallback}
            disabled={locked('workspaceFallback')}
            onToggle={() => draft.update({ workspaceFallback: !current.workspaceFallback })}
            ariaLabel={t('settings.attachments.behavior.workspaceFallback')}
          />
        )}
      </SettingsSection>

      {/* 7. Белый список MIME + действия черновика */}
      <SettingsSection
        id="attachments-mime"
        title={t('settings.attachments.mime.title')}
        description={t('settings.attachments.mime.description')}
        tooltip={t('settings.help.attachments.section.attachments-mime')}
      >
        {current && (
          <>
            <TextField
              label={t('settings.attachments.mime.label')}
              description={t('settings.attachments.mime.hint')}
              tooltip={t('settings.help.attachments.mime')}
              placeholder={t('settings.attachments.mime.placeholder')}
              value={current.mimePrefixes}
              onChange={(e) => draft.update({ mimePrefixes: e.target.value })}
              error={errors.mime ? t(errors.mime) : undefined}
              disabled={locked('allowedMimePrefixes')}
              mono
              id="attachments-mime"
              data-testid="attachments-mime"
            />

            <SettingsActions
              onSave={() => void handleSave()}
              onCancel={() => draft.revert()}
              onReset={() => void handleReset()}
              saving={saving}
              saveDisabled={loading || !draft.dirty || hasErrors}
              cancelDisabled={!draft.dirty}
              resetDisabled={loading}
              isDefault={draft.isDefault}
              saveTestId="attachments-save"
              cancelTestId="attachments-cancel"
              resetTestId="attachments-reset"
            />
          </>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}
