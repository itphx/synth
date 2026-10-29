import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'

/** Режимы отправки, между которыми переключает композер (`interrupt` — только API). */
export type ComposerSendMode = 'queue' | 'steer'

interface ModeOption {
  mode: ComposerSendMode
  icon: string
  labelKey: 'chat.steer.mode.queue' | 'chat.steer.mode.steer'
  hintKey: 'chat.steer.mode.queueHint' | 'chat.steer.mode.steerHint'
  activeClass: string
}

const MODE_OPTIONS: ModeOption[] = [
  {
    mode: 'queue',
    icon: 'inbox',
    labelKey: 'chat.steer.mode.queue',
    hintKey: 'chat.steer.mode.queueHint',
    activeClass: 'bg-muted text-foreground',
  },
  {
    mode: 'steer',
    icon: 'corner-up-right',
    labelKey: 'chat.steer.mode.steer',
    hintKey: 'chat.steer.mode.steerHint',
    activeClass: 'bg-primary/15 text-primary',
  },
]

/**
 * ADR-104: **переключатель режима** отправки во время активного хода.
 *
 * Это не кнопка отправки: сегменты «В очередь» / «В ход» только выбирают, как
 * уйдёт следующее сообщение (обычная кнопка отправки рядом). Клик по
 * переключателю никогда не отправляет сообщение — иначе пользователь, ожидая
 * отправки, видел бы «ничего не произошло» (баг dogfooding: иконка «самолётик»
 * читалась как отправка).
 *
 * На узких экранах подписи скрыты (остаются иконки + `title`), тач-таргеты —
 * не меньше 40px (ADR-044): атрибут `data-compact` выводит кнопки из-под
 * правила «компактные кнопки тулбара на мобильных» (`styles/index.css`).
 */
export function SteerModeSwitch({
  mode,
  onChange,
  disabled,
}: {
  mode: ComposerSendMode
  onChange: (mode: ComposerSendMode) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const { deviceType, isTouch } = useDevice()
  // На телефоне/планшете и на тач-указателе — увеличенный таргет.
  const largeTarget = isTouch || deviceType !== 'desktop'
  const showLabels = deviceType === 'desktop'

  return (
    <div
      role="group"
      aria-label={t('chat.steer.mode.label')}
      title={t('chat.steer.mode.title')}
      data-testid="steer-mode"
      className={cn(
        'flex shrink-0 items-center gap-0.5 rounded-lg border border-border/80 bg-surface-subtle p-0.5 transition-opacity',
        disabled && 'opacity-60'
      )}
    >
      {MODE_OPTIONS.map((opt) => {
        const active = mode === opt.mode
        const label = t(opt.labelKey)
        return (
          <button
            key={opt.mode}
            type="button"
            data-compact
            data-testid={`steer-mode-${opt.mode}`}
            aria-pressed={active}
            aria-label={label}
            title={`${label} — ${t(opt.hintKey)}`}
            onClick={() => onChange(opt.mode)}
            disabled={disabled}
            className={cn(
              'inline-flex shrink-0 items-center justify-center gap-1 rounded-md text-xs font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed',
              largeTarget ? 'min-h-10 min-w-10 p-1.5' : 'px-1.5 py-1',
              active
                ? opt.activeClass
                : 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover'
            )}
          >
            <Icon name={opt.icon} className="size-4 shrink-0" />
            {showLabels && <span className="@max-[212px]:hidden">{label}</span>}
          </button>
        )
      })}
    </div>
  )
}
