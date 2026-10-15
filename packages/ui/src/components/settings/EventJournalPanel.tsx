import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { synthApi, type EventJournalEntry } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { SettingsSection } from '../ui/settings'

/** Ограничение журнала: сколько последних записей запрашивать. */
const JOURNAL_LIMIT = 50

export interface EventJournalPanelProps {
  /** Дополнительные действия в шапке секции (например, переход в «Логи и аудит»). */
  extraActions?: ReactNode
}

/**
 * ADR-089: журнал решений Router. Переиспользуется в разделе «События» и в
 * категории «События» модала «Логи и аудит».
 */
export function EventJournalPanel({ extraActions }: EventJournalPanelProps) {
  const { t } = useI18n()

  const [journal, setJournal] = useState<EventJournalEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadJournal = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { entries } = await synthApi.getEventJournal(JOURNAL_LIMIT)
      setJournal(entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('events.journal.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadJournal()
  }, [loadJournal])

  return (
    <SettingsSection
      title={t('events.journal.title')}
      description={t('events.journal.description')}
      actions={
        <>
          {extraActions}
          <Button
            variant="outline"
            data-testid="events-journal-refresh"
            onClick={() => void loadJournal()}
            disabled={loading}
          >
            <Icon name="refresh" className="size-3.5" />
            {t('common.refresh')}
          </Button>
        </>
      }
    >
      {error && (
        <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading && journal === null && (
        <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
      )}

      {journal && journal.length === 0 && (
        <div className="text-center text-muted-foreground py-6">
          <Icon name="time" className="size-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">{t('events.journal.empty')}</p>
        </div>
      )}

      {journal && journal.length > 0 && (
        <div className="space-y-2 min-w-0" data-testid="events-journal-list">
          {journal.map((entry, index) => {
            const reason =
              entry.decision && (entry.decision.kind === 'queue' || entry.decision.kind === 'drop')
                ? entry.decision.reason
                : undefined
            const principalId = entry.principalId ?? entry.event.identity?.principalId
            return (
              <div
                key={`${entry.event.id}-${index}`}
                data-testid={`events-journal-${index}`}
                className="p-3 rounded-lg border border-border bg-surface-inset space-y-1 min-w-0"
              >
                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                  <span className="rounded px-1.5 py-0.5 text-[0.625rem] font-medium bg-muted text-muted-foreground">
                    {entry.decision?.kind ?? t('events.journal.noDecision')}
                  </span>
                  <span className="text-xs text-muted-foreground break-words">
                    {entry.event.source} · {entry.event.type}
                  </span>
                  <span className="text-[0.6875rem] text-muted-foreground ml-auto">
                    {formatDateTime(entry.ts)}
                  </span>
                </div>
                {reason && (
                  <div className="text-xs text-muted-foreground break-words">
                    <span className="font-medium">{t('events.journal.reason')}:</span> {reason}
                  </div>
                )}
                {(entry.keyId || principalId) && (
                  <div className="text-xs text-muted-foreground break-words font-mono">
                    {entry.keyId && <span className="mr-2">{t('events.journal.key')}: {entry.keyId}</span>}
                    {principalId && <span>{t('events.journal.principal')}: {principalId}</span>}
                  </div>
                )}
                {entry.error && (
                  <div className="text-xs text-destructive break-words">
                    <span className="font-medium">{t('events.journal.error')}:</span> {entry.error}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </SettingsSection>
  )
}

/** Дата/время записи журнала; при некорректном значении возвращает исходное. */
function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}
