import { useEffect, useState } from 'react'
import type { SessionMode } from '@itphx/synth-shared'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { useNotification } from '@/hooks/useNotification'
import { useUIStore } from '@/stores/useUIStore'
import { Icon } from '../icon/Icon'

interface ModeOption {
  mode: SessionMode
  labelKey: 'chat.mode.plan' | 'chat.mode.act' | 'chat.mode.yolo'
  icon: string
  activeClass: string
  hintKey?: 'chat.mode.yoloHint'
}

const MODE_OPTIONS: ModeOption[] = [
  {
    mode: 'plan',
    labelKey: 'chat.mode.plan',
    icon: 'todo',
    activeClass: 'bg-status-warning/15 text-status-warning',
  },
  {
    mode: 'act',
    labelKey: 'chat.mode.act',
    icon: 'rocket',
    activeClass: 'bg-status-success/15 text-status-success',
  },
  {
    mode: 'yolo',
    labelKey: 'chat.mode.yolo',
    icon: 'alert-triangle',
    activeClass: 'bg-status-error/15 text-status-error',
    hintKey: 'chat.mode.yoloHint',
  },
]

export function PlanActModeToggle({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const { deviceType } = useDevice()
  const centralNarrow = useUIStore((s) => s.centralNarrow)
  const isMobile = deviceType !== 'desktop' || centralNarrow
  const { notify } = useNotification()
  const sessionMode = useSessionsStore((s) => s.sessions.find((ses) => ses.id === sessionId)?.mode)
  const modeApplicable = useSessionsStore((s) => s.sessions.find((ses) => ses.id === sessionId)?.mode_applicable ?? true)
  const [mode, setMode] = useState<SessionMode>('act')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setMode(sessionMode ?? 'act')
  }, [sessionMode, sessionId])

  const handleChange = async (next: SessionMode) => {
    if (busy || next === mode) return
    setBusy(true)
    try {
      await useSessionsStore.getState().setSessionMode(sessionId, next)
      setMode(next)
      const msgKey = next === 'plan' ? 'chat.mode.planEnabled' : next === 'act' ? 'chat.mode.actEnabled' : 'chat.mode.yoloEnabled'
      notify({
        text: t(msgKey),
        type: 'success',
        category: 'message',
        sessionId,
      })
    } catch (e) {
      notify({
        text: `${t('chat.mode.error')} ${(e as Error).message}`,
        type: 'error',
        category: 'error',
        sessionId,
      })
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || !modeApplicable

  return (
    <div
      className={`flex shrink-0 items-center gap-0.5 rounded-lg border border-border/80 bg-surface-subtle p-0.5 transition-opacity ${
        disabled ? 'opacity-60' : ''
      }`}
      role="group"
      aria-label={disabled ? t('chat.mode.unavailable') : t('chat.mode.title')}
      aria-disabled={disabled}
      title={disabled ? t('chat.mode.unavailable') : t('chat.mode.title')}
    >
      {MODE_OPTIONS.map((opt) => {
        const active = mode === opt.mode
        return (
          <button
            key={opt.mode}
            type="button"
            onClick={() => handleChange(opt.mode)}
            disabled={disabled}
            aria-pressed={active}
            aria-label={!modeApplicable ? t('chat.mode.unavailable') : t(opt.labelKey)}
            className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              active
                ? opt.activeClass
                : 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover'
            }`}
          >
            <Icon name={opt.icon} className="size-3 shrink-0" />
            {!isMobile && <span className="@max-[212px]:hidden">{t(opt.labelKey)}</span>}
          </button>
        )
      })}
    </div>
  )
}
