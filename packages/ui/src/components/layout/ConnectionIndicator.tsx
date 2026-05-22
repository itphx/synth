import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'

interface ConnectionIndicatorProps {
  sessionId: string
}

export function ConnectionIndicator({ sessionId }: ConnectionIndicatorProps) {
  const { t } = useI18n()
  const { connectionStatus, protocolMode, toggleProtocolMode } = useUIStore()

  const status = connectionStatus[sessionId] || 'disconnected'

  const label = status === 'ws' ? 'WS' : status === 'sse' ? 'SSE' : 'ERR'
  const dotColor =
    status === 'ws'
      ? 'bg-green-400'
      : status === 'sse'
        ? 'bg-yellow-400'
        : 'bg-red-400'
  const textColor =
    status === 'ws'
      ? 'text-green-400'
      : status === 'sse'
        ? 'text-yellow-400'
        : 'text-red-400'
  const tooltip =
    status === 'ws'
      ? t('connection.ws')
      : status === 'sse'
        ? t('connection.sse')
        : t('connection.disconnected')

  const isDisconnected = status === 'disconnected'

  return (
    <button
      onClick={() => {
        const current = protocolMode[sessionId] || 'ws'
        const next = current === 'ws' ? 'sse' : 'ws'
        toggleProtocolMode(sessionId)
        synthApi.updateSession(sessionId, { settings: { websocket_enabled: next === 'ws' } }).catch(() => {})
      }}
      disabled={isDisconnected}
      className={`flex items-center gap-1.5 text-xs font-medium transition-opacity ${
        isDisconnected
          ? 'opacity-50 cursor-not-allowed'
          : 'cursor-pointer hover:opacity-70'
      }`}
      title={tooltip}
    >
      <span className={`size-2 rounded-full shrink-0 ${dotColor}`} />
      <span className={textColor}>{label}</span>
    </button>
  )
}
