import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import type { SteerMode } from '@itphx/synth-shared/types'

interface SendModeOption {
  mode: SteerMode
  labelKey:
    | 'chat.steer.mode.queue'
    | 'chat.steer.mode.steer'
    | 'chat.steer.mode.interrupt'
  hintKey:
    | 'chat.steer.mode.queueHint'
    | 'chat.steer.mode.steerHint'
    | 'chat.steer.mode.interruptHint'
  icon: string
}

/**
 * ADR-104: режимы отправки во время активного хода.
 * `queue` — в очередь, `steer` — вмешаться в ход, `interrupt` — прервать
 * текущую генерацию (ход продолжается, этап 2).
 */
const SEND_MODE_OPTIONS: readonly SendModeOption[] = [
  {
    mode: 'queue',
    labelKey: 'chat.steer.mode.queue',
    hintKey: 'chat.steer.mode.queueHint',
    icon: 'time',
  },
  {
    mode: 'steer',
    labelKey: 'chat.steer.mode.steer',
    hintKey: 'chat.steer.mode.steerHint',
    icon: 'send-plane',
  },
  {
    mode: 'interrupt',
    labelKey: 'chat.steer.mode.interrupt',
    hintKey: 'chat.steer.mode.interruptHint',
    icon: 'stop',
  },
]

/**
 * Селектор режима отправки композера (`queue` — в очередь, `steer` — вмешаться
 * в ход). Показывается только при активном ходе: без хода вмешиваться некуда,
 * сообщение уходит обычной очередью.
 *
 * Тач-таргеты — не меньше 40px (ADR-044): атрибут `data-compact` выводит кнопки
 * из-под правила «компактные кнопки тулбара на мобильных» (`styles/index.css`),
 * иначе CSS ужал бы их до 28px.
 */
export function SendModeSelector({
  value,
  onChange,
}: {
  value: SteerMode
  onChange: (mode: SteerMode) => void
}) {
  const { t } = useI18n()
  const { deviceType, isTouch } = useDevice()
  // На телефоне/планшете — только иконки (подпись не влезает в один ряд тулбара).
  const compact = deviceType !== 'desktop'
  const largeTarget = isTouch || compact

  return (
    <div
      role="group"
      aria-label={t('chat.steer.mode.label')}
      title={t('chat.steer.mode.title')}
      data-testid="send-mode-selector"
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/80 bg-surface-subtle p-0.5"
    >
      {SEND_MODE_OPTIONS.map((opt) => {
        const active = value === opt.mode
        return (
          <button
            key={opt.mode}
            type="button"
            data-compact
            data-testid={`send-mode-${opt.mode}`}
            aria-pressed={active}
            aria-label={t(opt.labelKey)}
            title={`${t(opt.labelKey)} — ${t(opt.hintKey)}`}
            onClick={() => onChange(opt.mode)}
            className={cn(
              'flex items-center justify-center gap-1 rounded-md px-2 text-[0.6875rem] font-medium transition-colors',
              largeTarget ? 'min-h-10 min-w-10' : 'min-h-[1.75rem] min-w-[1.75rem]',
              active
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover'
            )}
          >
            <Icon name={opt.icon} className="size-3.5 shrink-0" />
            {!compact && <span className="@max-[212px]:hidden">{t(opt.labelKey)}</span>}
          </button>
        )
      })}
    </div>
  )
}
