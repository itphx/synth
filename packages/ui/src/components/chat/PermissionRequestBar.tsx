import { useState, useEffect, type ReactNode } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { getToolIcon, getToolDisplayName } from '@/lib/toolIcons'
import { usePermissionStore } from '@/stores/permissionStore'
import { useTransportStore } from '@/stores/transportStore'
import { useNotification } from '@/hooks/useNotification'
import { DiffView } from './DiffView'
import {
  findTokenRange,
  splitTokenSegments,
} from '@/lib/permissionHighlight'
import { describePermissionCause } from '@/lib/permissionCause'

interface PermissionRequestBarProps {
  sessionId: string
}

/**
 * Предел строк диффа на файл в превью: остаток показывается счётчиком
 * («ещё N»), а не полным диффом — иначе полоса подтверждения разрасталась
 * на сотни строк.
 */
const MAX_PREVIEW_LINES = 40

/**
 * Класс подсветки «виновника» — только токены темы (`--status-caution`,
 * тот же оранжевый, что индикатор статуса `approval` в дереве сессий).
 */
const HIGHLIGHT_CLASS = 'rounded-sm bg-status-caution/25 px-0.5 text-status-caution'

/**
 * Текст с подсвеченным фрагментом.
 *
 * Механизм — как у `@`-упоминаний агентов (`SecretPlaceholder`): текст
 * разбивается на сегменты, нужный оборачивается в `<span>` с классом.
 * Без `dangerouslySetInnerHTML` и без `<mark>`.
 */
function HighlightedText({ text, token }: { text: string; token?: string }): ReactNode {
  const segments = token
    ? splitTokenSegments(text, token)
    : [{ type: 'text' as const, value: text }]
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'hit' ? (
          <span key={i} className={HIGHLIGHT_CLASS} data-testid="permission-highlight">
            {seg.value}
          </span>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </>
  )
}

/** Значение параметра вызова — строкой; не-строки — компактным JSON. */
function formatParamValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Ask-полоса подтверждений над полем ввода (ADR-029).
 * Показывает текущий запрос permission.asked, при ответе — следующий.
 *
 * Человеку показывается **причина** («Что вызвало вопрос»), собранная из
 * структурного триггера ядра: путь/код/команда, ради которых спросили, и
 * подсветка подозрительного участка. LLM-текст причины (`reason`) спрятан
 * в свёрнутый блок «Технические детали» — он адресован модели, а не человеку.
 */
export function PermissionRequestBar({ sessionId }: PermissionRequestBarProps) {
  const { t } = useI18n()
  const { notify } = useNotification()
  const requests = usePermissionStore((s) => s.requestsBySession[sessionId])
  const [expanded, setExpanded] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // Свернутые файлы превью (по ключу `индекс:путь`).
  const [collapsedPreview, setCollapsedPreview] = useState<Record<string, boolean>>({})
  const currentApprovalId = requests?.[0]?.approvalId

  // При переходе к следующему запросу (ответ/таймаут) — снова сворачиваем
  // и перезапускаем отсчёт таймера.
  useEffect(() => {
    setExpanded(false)
    setDetailsOpen(false)
    setNow(Date.now())
    setCollapsedPreview({})
  }, [currentApprovalId])

  // Тик обратного отсчёта каждую секунду. После «Остановить таймер» (held) или
  // при timeoutMs <= 0 («без таймаута») — таймер не тикает.
  useEffect(() => {
    const current = requests?.[0]
    if (current?.held || (current?.timeoutMs ?? 0) <= 0) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [requests?.[0]?.held, requests?.[0]?.approvalId, requests?.[0]?.timeoutMs])

  if (!requests || requests.length === 0) return null
  const current = requests[0]
  if (!current) return null

  const waitingCount = requests.length - 1
  const toolDisplayName = getToolDisplayName(current.toolName)
  const trigger = current.trigger
  const cause = describePermissionCause(trigger)
  // Токен-виновник: путь/код/команда, ради которых спросили.
  const culpritToken = cause?.token
  const causeText = cause ? t(cause.key, cause.params) : ''
  // Токен найден в тексте причины (иначе показываем его отдельной строкой).
  const causeShowsToken = !!culpritToken && !!causeText
    && findTokenRange(causeText, culpritToken) !== null
  const hasTechnical = !!trigger && (!!current.reason || !!trigger.matchedRule || !!trigger.messageId)
  const hasParams = Object.keys(current.params).length > 0
  // Раскрытие по «Подробнее»: параметры вызова (команда — отдельным блоком).
  // Прежний текст причины уехал в «Технические детали» — он адресован модели.
  const hasDetails = hasParams
  // Превью изменений: дифф по файлам, которые тул собирается изменить.
  const previewFiles = current.preview?.files ?? []
  const savePatterns = current.save ?? []
  // Shell без выводимых паттернов (`save: []`): сессионный грант выдать нельзя —
  // иначе он был бы шире одобренного. Остаётся только разовое разрешение.
  const sessionGrantUnavailable = current.toolName === 'execute_shell'
    && Array.isArray(current.save)
    && current.save.length === 0

  // Параметры вызова: `command` (для shell) — отдельным блоком, остальные
  // ключи — списком «ключ: значение».
  const paramEntries = Object.entries(current.params)
  const commandEntry = current.toolName === 'execute_shell'
    ? paramEntries.find(([key]) => key === 'command')
    : undefined
  const commandValue = typeof commandEntry?.[1] === 'string' ? (commandEntry[1] as string) : undefined
  const otherParams = paramEntries.filter(([key]) => key !== commandEntry?.[0])
  // Токен найден в тексте команды? (иначе показываем его отдельной строкой)
  const tokenInCommand = !!culpritToken && !!commandValue
    && findTokenRange(commandValue, culpritToken) !== null

  const handleAction = async (approved: boolean, once?: boolean) => {
    const sent = await useTransportStore
      .getState()
      .sendPermissionReply(sessionId, current.approvalId, approved, once)
    if (!sent) {
      // Ответ не доставлен (сеть/HTTP): запрос остаётся открытым — убирать
      // полосу нельзя, иначе пользователь думает, что ответил, а ask висит
      // до таймаута.
      notify({
        text: t('permission.bar.replyFailed'),
        type: 'error',
        category: 'system',
        sessionId,
      })
      return
    }
    usePermissionStore.getState().removeRequest(sessionId, current.approvalId)
    if (approved && once === false) {
      const text = current.toolName === 'execute_shell' && savePatterns.length > 0
        ? t('permission.bar.grantedShell', { patterns: savePatterns.map((p) => `\`${p}\``).join(', ') })
        : t('permission.bar.grantedForSession', { tool: toolDisplayName })
      notify({
        text,
        type: 'success',
        category: 'system',
        sessionId,
      })
    }
  }

  // Обратный отсчёт от askedAt + timeoutMs. Формат: «мм:сс» / «N сек».
  const askedMs = new Date(current.askedAt).getTime()
  const remainingSec = Math.max(0, Math.round((askedMs + current.timeoutMs - now) / 1000))
  const formatRemaining = (sec: number) => {
    if (sec < 60) return `${sec} сек`
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  const handleHold = async () => {
    const sent = await useTransportStore.getState().sendPermissionHold(sessionId, current.approvalId)
    if (!sent) {
      // «Остановить таймер» не доставлен — локально таймер не снимаем (иначе
      // UI думает, что запрос без таймаута, а бэкенд его сбросит).
      notify({
        text: t('permission.bar.replyFailed'),
        type: 'error',
        category: 'system',
        sessionId,
      })
      return
    }
    usePermissionStore.getState().holdRequest(sessionId, current.approvalId)
  }

  return (
    // `mt-2` — зазор сверху: висящее предупреждение и полоса отделяются
    // так же, как полоса и область ввода (`mt-2` у `ChatInput`).
    <div className="shrink-0 mx-auto mt-2 w-4/5 rounded-lg border border-primary/30 bg-primary/5">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Icon
          name={getToolIcon(current.toolName)}
          className="size-3.5 text-primary shrink-0"
        />
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs text-foreground/90 hover:text-foreground transition-colors min-w-0"
          title={hasDetails ? (expanded ? t('permission.bar.hide') : t('permission.bar.details')) : undefined}
        >
          <span className="truncate">
            {t('permission.bar.request', { tool: toolDisplayName })}
          </span>
          {waitingCount > 0 && (
            <span className="text-[0.625rem] text-muted-foreground shrink-0">
              {t('permission.bar.waiting', { count: String(waitingCount) })}
            </span>
          )}
          {hasDetails && (
            <Icon
              name={expanded ? 'arrow-up-s' : 'arrow-down-s'}
              className="size-3 shrink-0 text-muted-foreground"
            />
          )}
        </button>

        <div className="flex items-center gap-1 ml-auto shrink-0">
          {current.held || current.timeoutMs <= 0 ? (
            <span className="flex items-center gap-1 px-2 py-0.5 text-[0.625rem] text-muted-foreground">
              <Icon name="time" className="size-3 shrink-0" />
              {t('permission.bar.noTimeout')}
            </span>
          ) : (
            <>
              <span
                className="flex items-center gap-1 px-2 py-0.5 text-[0.625rem] tabular-nums text-muted-foreground"
                title={t('permission.bar.timeoutTitle')}
              >
                <Icon name="time" className="size-3 shrink-0" />
                {formatRemaining(remainingSec)}
              </span>
              <button
                onClick={handleHold}
                className="flex items-center gap-1 rounded px-2 py-0.5 text-[0.625rem] text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
                title={t('permission.bar.stopTimerHint')}
              >
                <Icon name="stop" className="size-3 shrink-0" />
                {t('permission.bar.stopTimer')}
              </button>
            </>
          )}
          {sessionGrantUnavailable ? (
            <span
              data-testid="permission-save-unavailable"
              title={t('permission.bar.saveUnavailable')}
              className="rounded px-2 py-0.5 text-[0.6875rem] text-muted-foreground cursor-help"
            >
              {t('permission.bar.saveUnavailableShort')}
            </span>
          ) : (
            <button
              onClick={() => handleAction(true, false)}
              className="rounded px-2 py-0.5 text-[0.6875rem] font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
              title={t('permission.bar.allowSessionHint')}
            >
              {t('permission.bar.allowSession')}
            </button>
          )}
          <button
            onClick={() => handleAction(true, true)}
            className="rounded px-2 py-0.5 text-[0.6875rem] font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
            title={t('permission.bar.allowOnceHint')}
          >
            {t('permission.bar.allowOnce')}
          </button>
          <button
            onClick={() => handleAction(false)}
            className="rounded px-2 py-0.5 text-[0.6875rem] text-destructive hover:bg-destructive/10 transition-colors"
          >
            {t('permission.bar.deny')}
          </button>
        </div>
      </div>

      {savePatterns.length > 0 && (
        <div
          className="px-3 pb-1.5 text-[0.6875rem] text-muted-foreground"
          data-testid="permission-save-patterns"
        >
          {t('permission.bar.savePatterns', {
            patterns: savePatterns.map((p) => `\`${p}\``).join(', '),
          })}
        </div>
      )}

      {/* Человеческая причина: что именно вызвало вопрос. Видна всегда —
          это главное, ради чего человек смотрит в полосу. */}
      {(cause || current.reason) && (
        <div className="px-3 pb-1.5 text-xs" data-testid="permission-cause">
          <span className="font-medium text-foreground/80">
            {cause ? t('permission.bar.cause') : t('permission.bar.reason')}:{' '}
          </span>
          {cause ? (
            <span className="text-foreground/90">
              <HighlightedText text={causeText} token={causeShowsToken ? culpritToken : undefined} />
            </span>
          ) : (
            // Старый сервер (без `trigger`): прежний текст причины — он и есть
            // причина, спрятать нечего.
            <span className="whitespace-pre-wrap text-muted-foreground">{current.reason}</span>
          )}
          {cause && culpritToken && !causeShowsToken && (
            <div className="mt-0.5 text-[0.6875rem] text-muted-foreground" data-testid="permission-suspicious">
              {t('permission.bar.suspicious', { token: culpritToken })}
            </div>
          )}
          {cause && causeShowsToken && (
            <div className="mt-0.5 text-[0.625rem] text-muted-foreground/80">
              {t('permission.bar.highlightHint')}
            </div>
          )}
        </div>
      )}

      {/* Технические детали: прежний LLM-текст причины, правило и id
          сообщения — адресованы модели и админу, человеку по умолчанию не
          нужны. Свёрнуто. */}
      {hasTechnical && (
        <div className="px-3 pb-1.5" data-testid="permission-technical-block">
          <button
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((v) => !v)}
            data-testid="permission-technical-toggle"
            className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground hover:text-foreground transition-colors"
          >
            <Icon
              name={detailsOpen ? 'arrow-down-s' : 'arrow-right-s'}
              className="size-3 shrink-0"
            />
            <span>{t('permission.bar.technical')}</span>
          </button>
          {detailsOpen && (
            <div className="pt-1 space-y-1" data-testid="permission-technical">
              {current.reason && (
                <div className="text-[0.6875rem] text-muted-foreground whitespace-pre-wrap">
                  <span className="font-medium text-foreground/80">{t('permission.bar.reason')}: </span>
                  {current.reason}
                </div>
              )}
              {trigger?.matchedRule && (
                <div className="text-[0.6875rem] text-muted-foreground font-mono break-all">
                  {t('permission.bar.technicalRule', { rule: trigger.matchedRule })}
                </div>
              )}
              {trigger?.messageId && (
                <div className="text-[0.6875rem] text-muted-foreground font-mono break-all">
                  {t('permission.bar.technicalMessage', { message: trigger.messageId })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {previewFiles.length > 0 && (
        <div className="px-3 pb-2 pt-1 space-y-1 border-t border-primary/15" data-testid="permission-preview">
          {previewFiles.map((file, index) => {
            const key = `${index}:${file.path}`
            const collapsed = collapsedPreview[key] === true
            const lines = file.diff.split('\n')
            const shown = lines.length > MAX_PREVIEW_LINES ? lines.slice(0, MAX_PREVIEW_LINES) : lines
            const hidden = lines.length - shown.length
            return (
              <div key={key}>
                <button
                  onClick={() => setCollapsedPreview((prev) => ({ ...prev, [key]: !collapsed }))}
                  aria-expanded={!collapsed}
                  className="flex items-center gap-1.5 w-full min-w-0 text-[0.6875rem] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Icon
                    name={collapsed ? 'arrow-right-s' : 'arrow-down-s'}
                    className="size-3 shrink-0"
                  />
                  <span className="font-mono truncate">{file.path}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums text-[0.625rem]">
                    <span className="diff-added px-1 rounded-sm">+{file.additions}</span>
                    <span className="diff-removed px-1 rounded-sm">−{file.deletions}</span>
                  </span>
                </button>
                {!collapsed && (
                  <div className="pl-4 mt-0.5">
                    <DiffView diff={shown.join('\n')} />
                    {hidden > 0 && (
                      <div className="text-[0.625rem] text-muted-foreground mt-0.5">
                        … {t('common.showMore', { count: String(hidden) })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {expanded && hasParams && (
        <div className="px-3 pb-2 space-y-1.5 border-t border-primary/15">
          <div>
            <div className="text-[0.6875rem] font-medium text-muted-foreground mb-0.5">
              {t('permission.bar.params')}
            </div>
            {/* Команда — отдельным блоком: JSON-экранирование мешало искать
                токен-виновник, а он подсвечен прямо в тексте команды. */}
            {commandValue !== undefined && (
              <div className="mb-1">
                <div className="text-[0.625rem] text-muted-foreground mb-0.5">
                  {t('permission.bar.command')}
                </div>
                <pre
                  className="text-[0.6875rem] text-muted-foreground whitespace-pre-wrap break-all overflow-x-auto font-mono leading-relaxed"
                  data-testid="permission-command"
                >
                  <HighlightedText
                    text={commandValue}
                    token={tokenInCommand ? culpritToken : undefined}
                  />
                </pre>
                {/* Токен не нашёлся в тексте команды (путь нормализован в
                    абсолютный, а в команде относительный) — показываем его
                    отдельной строкой, без пустого блока подсветки. */}
                {culpritToken && !tokenInCommand && (
                  <div className="mt-0.5 text-[0.625rem] text-muted-foreground" data-testid="permission-suspicious-in-command">
                    {t('permission.bar.suspicious', { token: culpritToken })}
                  </div>
                )}
              </div>
            )}
            {otherParams.length > 0 && (
              <dl className="text-[0.6875rem] text-muted-foreground space-y-0.5" data-testid="permission-params">
                {otherParams.map(([key, value]) => (
                  <div key={key} className="flex gap-1.5 min-w-0">
                    <dt className="shrink-0 font-mono text-foreground/70">{key}:</dt>
                    <dd className="min-w-0 font-mono break-all whitespace-pre-wrap">{formatParamValue(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
