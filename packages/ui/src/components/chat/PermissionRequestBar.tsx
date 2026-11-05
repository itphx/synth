import { useState, useEffect } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { getToolIcon, getToolDisplayName } from '@/lib/toolIcons'
import { usePermissionStore } from '@/stores/permissionStore'
import { useTransportStore } from '@/stores/transportStore'
import { useNotification } from '@/hooks/useNotification'
import { DiffView } from './DiffView'

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
 * Ask-полоса подтверждений над полем ввода (ADR-029).
 * Показывает текущий запрос permission.asked, при ответе — следующий.
 * Свёрнута по умолчанию: «подробнее» раскрывает параметры вызова и reason.
 */
export function PermissionRequestBar({ sessionId }: PermissionRequestBarProps) {
  const { t } = useI18n()
  const { notify } = useNotification()
  const requests = usePermissionStore((s) => s.requestsBySession[sessionId])
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // Свернутые файлы превью (по ключу `индекс:путь`).
  const [collapsedPreview, setCollapsedPreview] = useState<Record<string, boolean>>({})
  const currentApprovalId = requests?.[0]?.approvalId

  // При переходе к следующему запросу (ответ/таймаут) — снова сворачиваем
  // и перезапускаем отсчёт таймера.
  useEffect(() => {
    setExpanded(false)
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
  const hasDetails = !!current.reason || Object.keys(current.params).length > 0
  // Превью изменений: дифф по файлам, которые тул собирается изменить.
  const previewFiles = current.preview?.files ?? []
  const savePatterns = current.save ?? []
  // Shell без выводимых паттернов (`save: []`): сессионный грант выдать нельзя —
  // иначе он был бы шире одобренного. Остаётся только разовое разрешение.
  const sessionGrantUnavailable = current.toolName === 'execute_shell'
    && Array.isArray(current.save)
    && current.save.length === 0

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
    <div className="shrink-0 mx-auto w-4/5 rounded-lg border border-primary/30 bg-primary/5">
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

      {expanded && hasDetails && (
        <div className="px-3 pb-2 space-y-1.5 border-t border-primary/15">
          {current.reason && (
            <div className="pt-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">{t('permission.bar.reason')}: </span>
              <span className="whitespace-pre-wrap">{current.reason}</span>
            </div>
          )}
          {Object.keys(current.params).length > 0 && (
            <div>
              <div className="text-[0.6875rem] font-medium text-muted-foreground mb-0.5">
                {t('permission.bar.params')}
              </div>
              <pre className="text-[0.6875rem] text-muted-foreground whitespace-pre-wrap overflow-x-auto font-mono leading-relaxed">
                {JSON.stringify(current.params, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
