import { useState, useEffect } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { getToolIcon, getToolDisplayName } from '@/lib/toolIcons'
import { usePermissionStore } from '@/stores/permissionStore'
import { useTransportStore } from '@/stores/transportStore'

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
  const requests = usePermissionStore((s) => s.requestsBySession[sessionId])
  const [expanded, setExpanded] = useState(false)
  const currentApprovalId = requests?.[0]?.approvalId

  // При переходе к следующему запросу (ответ/таймаут) — снова сворачиваем
  useEffect(() => {
    setExpanded(false)
  }, [currentApprovalId])

  if (!requests || requests.length === 0) return null
  const current = requests[0]
  if (!current) return null

  const waitingCount = requests.length - 1
  const toolDisplayName = getToolDisplayName(current.toolName)
  const hasDetails = !!current.reason || Object.keys(current.params).length > 0

  const handleAction = (approved: boolean, once?: boolean) => {
    usePermissionStore.getState().removeRequest(sessionId, current.approvalId)
    useTransportStore.getState().sendPermissionReply(sessionId, current.approvalId, approved, once)
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
            <span className="text-[10px] text-muted-foreground shrink-0">
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
          <button
            onClick={() => handleAction(true, false)}
            className="rounded px-2 py-0.5 text-[11px] font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
            title={t('permission.bar.allowSessionHint')}
          >
            {t('permission.bar.allowSession')}
          </button>
          <button
            onClick={() => handleAction(true, true)}
            className="rounded px-2 py-0.5 text-[11px] font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
            title={t('permission.bar.allowOnceHint')}
          >
            {t('permission.bar.allowOnce')}
          </button>
          <button
            onClick={() => handleAction(false)}
            className="rounded px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 transition-colors"
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
              <div className="text-[11px] font-medium text-muted-foreground mb-0.5">
                {t('permission.bar.params')}
              </div>
              <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap overflow-x-auto font-mono leading-relaxed">
                {JSON.stringify(current.params, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
