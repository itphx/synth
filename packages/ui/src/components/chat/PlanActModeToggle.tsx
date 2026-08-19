import { useEffect, useState } from 'react'
import type { SessionMode } from '@itphx/synth-shared'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
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
    activeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  },
  {
    mode: 'act',
    labelKey: 'chat.mode.act',
    icon: 'rocket',
    activeClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
  },
  {
    mode: 'yolo',
    labelKey: 'chat.mode.yolo',
    icon: 'alert-triangle',
    activeClass: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
    hintKey: 'chat.mode.yoloHint',
  },
]

export function PlanActModeToggle({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
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
            title={!modeApplicable ? t('chat.mode.unavailable') : opt.hintKey ? t(opt.hintKey) : undefined}
            className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              active
                ? opt.activeClass
                : 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50'
            }`}
          >
            <Icon name={opt.icon} className="size-3 shrink-0" />
            <span className="@max-[212px]:hidden">{t(opt.labelKey)}</span>
          </button>
        )
      })}
    </div>
  )
}
