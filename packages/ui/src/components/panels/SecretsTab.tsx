import { useEffect, useState } from 'react'
import { Icon } from '@/components/icon/Icon'
import { synthApi } from '@/lib/api/synthApi'

interface SecretsTabProps {
  sessionId: string
}

function maskValue(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length)
  return `${value.slice(0, 4)}***`
}

/**
 * Вкладка «Словарь обфускации» (AD-036): карта плейсхолдеров ⟦SYNTH_SECRET_N⟧ → реальное значение.
 * Доступна только ADMIN/AUDITOR (права проверяются в RightPanel). Значения маскируются,
 * пока пользователь не нажмёт «Показать значения».
 */
export function SecretsTab({ sessionId }: SecretsTabProps) {
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    synthApi
      .getSessionSecrets(sessionId)
      .then((res) => {
        if (cancelled) setSecrets(res.secrets || {})
      })
      .catch(() => {
        // Эндпоинт может быть не готов — показываем пустое состояние
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (loading) {
    return <div className="p-4 text-xs text-muted-foreground text-center">...</div>
  }

  const entries = Object.entries(secrets)

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <Icon name="shield-keyhole" className="h-6 w-6 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">Секретов в этой сессии нет</p>
      </div>
    )
  }

  return (
    <div className="p-2">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-[0.625rem] text-muted-foreground/60 uppercase tracking-wide">
          Карта обфускации
        </span>
        <button
          onClick={() => setRevealed(!revealed)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
        >
          <Icon name={revealed ? 'eye-off' : 'eye'} className="size-3" />
          {revealed ? 'Скрыть значения' : 'Показать значения'}
        </button>
      </div>
      <div className="space-y-1">
        {entries.map(([placeholder, value]) => (
          <div
            key={placeholder}
            className="flex items-start justify-between gap-2 rounded-lg border border-border/50 bg-card px-2 py-1.5 text-xs"
          >
            <span className="font-mono text-[0.6875rem] text-foreground shrink-0">{placeholder}</span>
            <span
              className={`font-mono text-[0.6875rem] break-all text-right ${
                revealed ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              {revealed ? value : maskValue(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
