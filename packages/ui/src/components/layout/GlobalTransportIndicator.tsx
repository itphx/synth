import { useUIStore } from '@/stores/useUIStore'
import { useTransportStore } from '@/stores/transportStore'
import { useI18n } from '@/lib/i18n'

const MODE_ORDER: Array<'auto' | 'ws' | 'sse'> = ['auto', 'ws', 'sse']

export function GlobalTransportIndicator() {
  const { t } = useI18n()
  const { transportMode, setTransportMode } = useUIStore()
  const connected = useTransportStore((s) => s.connected)

  const label = t(`transport.${transportMode}` as never)
  const tooltip = t(`transport.${transportMode}Desc` as never)

  const dotColor =
    transportMode === 'sse'
      ? 'bg-yellow-400'
      : connected
        ? 'bg-green-400'
        : 'bg-red-400'

  const labelColor =
    transportMode === 'sse'
      ? 'text-yellow-400'
      : connected
        ? 'text-green-400'
        : 'text-red-400'

  const handleClick = () => {
    const idx = MODE_ORDER.indexOf(transportMode)
    const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length]!
    setTransportMode(next)
  }

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-1.5 text-xs font-medium rounded px-2 py-1 cursor-pointer hover:bg-interactive-hover transition-colors"
      title={tooltip}
    >
      <span className={`size-2 rounded-full shrink-0 ${dotColor}`} />
      <span className={`device-hide-label ${labelColor}`}>{label}</span>
    </button>
  )
}
