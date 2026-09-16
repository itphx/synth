import { useState, useEffect } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { getToolIcon, getToolDisplayName } from '@/lib/toolIcons'
import { usePermissionStore } from '@/stores/permissionStore'
import { useTransportStore } from '@/stores/transportStore'
import { useNotification } from '@/hooks/useNotification'

interface PermissionRequestBarProps {
  sessionId: string
}

/**
 * Ask-полоса подтверждений над полем ввода (AD-029).
 * Показывает текущий запрос permission.asked, при ответе — следующий.
 * Свёрнута по умолчанию: «подробнее» раскрывает параметры вызова и reason.
 */
export function PermissionRequestBar({ sessionId }: PermissionRequestBarProps) {
  const { t } = useI18n()
  const { notify } = useNotification()
  const requests = usePermissionStore((s) => s.requestsBySession[sessionId])
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const currentApprovalId = requests?.[0]?.approvalId

  // При переходе к следующему запросу (ответ/таймаут) — снова сворачиваем
  // и перезапускаем отсчёт таймера.
  useEffect(() => {
    setExpanded(false)
    setNow(Date.now())
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

  const handleAction = (approved: boolean, once?: boolean) => {
    usePermissionStore.getState().removeRequest(sessionId, current.approvalId)
    useTransportStore.getState().sendPermissionReply(sessionId, current.approvalId, approved, once)
    if (approved && once === false) {
      notify({
        text: t('permission.bar.grantedForSession', { tool: toolDisplayName }),
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

  const handleHold = () => {
    usePermissionStore.getState().holdRequest(sessionId, current.approvalId)
    useTransportStore.getState().sendPermissionHold(sessionId, current.approvalId)
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
          <button
            onClick={() => handleAction(true, false)}
            className="rounded px-2 py-0.5 text-[0.6875rem] font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
            title={t('permission.bar.allowSessionHint')}
          >
            {t('permission.bar.allowSession')}
          </button>
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
