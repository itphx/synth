import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'

/**
 * ADR-104: тумблер «вмешаться» для отправки во время активного хода.
 *
 * Единственный элемент тулбара, выбирающий режим: выключен — сообщение уходит
 * в очередь (это и есть обычная кнопка отправки), включён — вбрасывается
 * в текущий ход на ближайшей границе шага. Отдельного «Прервать» здесь нет:
 * рядом стоит кнопка «Стоп», и дублировать её в контроле режима незачем.
 *
 * Тач-таргеты — не меньше 40px (ADR-044): атрибут `data-compact` выводит
 * кнопку из-под правила «компактные кнопки тулбара на мобильных»
 * (`styles/index.css`), иначе CSS ужал бы её до 28px. На десктопе — компактный
 * `p-1.5`, как у соседних кнопок тулбара.
 */
export function SteerToggle({
  active,
  onToggle,
  disabled,
}: {
  active: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const { deviceType, isTouch } = useDevice()
  // На телефоне/планшете и на тач-указателе — увеличенный таргет.
  const largeTarget = isTouch || deviceType !== 'desktop'
  const label = t('chat.steer.mode.steer')
  const hint = t('chat.steer.mode.steerHint')

  return (
    <button
      type="button"
      data-compact
      data-testid="steer-toggle"
      aria-pressed={active}
      aria-label={label}
      title={`${label} — ${hint}`}
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed',
        largeTarget ? 'min-h-10 min-w-10 p-1.5' : 'p-1.5',
        active
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover'
      )}
    >
      <Icon name="send-plane" className="size-5" />
    </button>
  )
}
