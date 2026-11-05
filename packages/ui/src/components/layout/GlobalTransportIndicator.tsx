import { useUIStore } from '@/stores/useUIStore'
import { useTransportStore } from '@/stores/transportStore'
import { useI18n } from '@/lib/i18n'

const MODE_ORDER: Array<'auto' | 'ws' | 'sse'> = ['auto', 'ws', 'sse']

/**
 * Индикатор транспорта в шапке.
 *
 * Клик — переподключение (`restart()`), Shift+клик — циклическая смена режима
 * `auto → ws → sse`. Цвет точки/подписи — по фазе связи (`phase`), а не по
 * булеву `connected`: `connecting`/`reconnecting` — предупреждение.
 */
export function GlobalTransportIndicator() {
  const { t } = useI18n()
  const transportMode = useUIStore(s => s.transportMode)
  const setTransportMode = useUIStore(s => s.setTransportMode)
  const phase = useTransportStore((s) => s.phase)

  const label = t(`transport.${transportMode}` as never)
  const tooltip = t(`transport.${transportMode}Desc` as never)

  const colorClass =
    phase === 'online'
      ? 'bg-status-success'
      : phase === 'offline'
        ? 'bg-status-error'
        : 'bg-status-warning'

  const labelColor =
    phase === 'online'
      ? 'text-status-success'
      : phase === 'offline'
        ? 'text-status-error'
        : 'text-status-warning'

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey) {
      const idx = MODE_ORDER.indexOf(transportMode)
      const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length]!
      setTransportMode(next)
      return
    }
    useTransportStore.getState().restart()
  }

  return (
    <button
      onClick={handleClick}
      data-phase={phase}
      className="flex items-center gap-1.5 text-xs font-medium rounded px-2 py-1 cursor-pointer hover:bg-interactive-hover transition-colors"
      title={`${t('transport.reconnect')} · ${tooltip}`}
      aria-label={`${label} · ${t('transport.reconnect')}`}
    >
      <span className={`size-2 rounded-full shrink-0 ${colorClass}`} />
      <span className={`device-hide-label ${labelColor}`}>{label}</span>
    </button>
  )
}
