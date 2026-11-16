// TerminalsSection: карточки терминалов во вкладке «Фоновые процессы»
// правой панели (PROP-132, Ф4б).
//
// Источник истины — серверный список `GET /terminals?project_id=<активный
// проект>&include_exited=true` (завершённые терминалы — в т.ч. восстановленные
// после рестарта ядра — тоже видны); live-обновление — события `terminal.*`
// (реестр терминалов) плюс перечитывание раз в 5 с, пока секция открыта
// (как список фоновых прогонов).
//
// Карточка: оболочка, каталог (сокращённый), статус, привязанная сессия,
// бейдж «только просмотр» (`can_write=false`) и действия «Открыть» /
// «Остановить» (DELETE — с подтверждением).

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { confirm } from '@/lib/confirm'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/formatDate'
import { openTerminalTab } from '@/lib/terminalTabs'
import { shortenPath } from '@/lib/terminalContext'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { useNotification } from '@/hooks/useNotification'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useTerminalsStore } from '@/stores/terminalsStore'

/** Период перечитывания списка терминалов, мс (секция открыта). */
const LIST_REFRESH_MS = 5000

/** Общий стиль бейджа (как в «Памяти»/«Процессах»). */
const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа статуса терминала. */
const STATUS_CLASS: Record<string, string> = {
  starting: 'bg-primary/15 text-primary',
  running: 'bg-status-success/15 text-status-success',
  exited: 'bg-muted text-muted-foreground',
}

export interface TerminalsSectionProps {
  /** Активный проект (список терминалов проекта). */
  projectId: string | null
  /** Сессия активной вкладки — для фильтра «только текущая сессия». */
  currentSessionId: string | null
  /** Фильтр «только текущая сессия». */
  onlyCurrent: boolean
}

export const TerminalsSection: React.FC<TerminalsSectionProps> = ({
  projectId,
  currentSessionId,
  onlyCurrent,
}) => {
  const { t, locale } = useI18n()
  const { notify } = useNotification()

  const terminalsById = useTerminalsStore((s) => s.terminalsById)
  const order = useTerminalsStore((s) => s.order)
  const loadTerminals = useTerminalsStore((s) => s.load)
  const closeTerminal = useTerminalsStore((s) => s.close)
  const createTerminal = useTerminalsStore((s) => s.create)
  const loadError = useTerminalsStore((s) => s.error)

  const sessions = useSessionsStore((s) => s.sessions)
  const sessionNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const session of sessions) map.set(session.id, session.name || session.id)
    return map
  }, [sessions])

  const [busy, setBusy] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // Список терминалов проекта: первичная загрузка + перечитывание раз в 5 с,
  // пока секция открыта. `includeExited` — вместе с завершёнными: терминал,
  // восстановленный после рестарта ядра, иначе в списке не виден.
  useEffect(() => {
    if (!projectId) return
    void loadTerminals({ projectId, includeExited: true })
    const timer = setInterval(() => {
      void loadTerminals({ projectId, includeExited: true })
    }, LIST_REFRESH_MS)
    return () => clearInterval(timer)
  }, [projectId, loadTerminals])

  const terminals = useMemo(() => {
    const list = order
      .map((id) => terminalsById[id])
      .filter((terminal): terminal is NonNullable<typeof terminal> => !!terminal)
    return list
      .filter((terminal) => (projectId ? terminal.projectId === projectId : true))
      .filter((terminal) =>
        onlyCurrent && currentSessionId ? terminal.sessionId === currentSessionId : true,
      )
  }, [currentSessionId, onlyCurrent, order, projectId, terminalsById])

  /** Открытие терминала в центральной вкладке. */
  const handleOpen = useCallback((terminalId: string) => {
    const terminal = useTerminalsStore.getState().terminalsById[terminalId]
    if (!terminal) return
    openTerminalTab(terminal)
  }, [])

  /** Остановка терминала (сервер убивает PTY) — с подтверждением. */
  const handleStop = useCallback(
    async (terminalId: string) => {
      const terminal = useTerminalsStore.getState().terminalsById[terminalId]
      const name = terminal?.title || terminal?.shell || terminalId
      const ok = await confirm({
        title: t('terminals.confirm.stopTitle'),
        message: t('terminals.confirm.stopMessage', { name }),
        confirmLabel: t('terminals.action.stop'),
        variant: 'danger',
        icon: 'stop',
      })
      if (!ok) return
      setBusy(terminalId)
      try {
        await closeTerminal(terminalId)
        notify({
          text: t('terminals.stopped'),
          type: 'success',
          category: 'system',
        })
      } catch (err) {
        notify({
          text: t('terminals.failed', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setBusy(null)
      }
    },
    [closeTerminal, notify, t],
  )

  /** Создание терминала проекта (шапка секции и пустое состояние). */
  const handleCreate = useCallback(async () => {
    if (!projectId) return
    setCreating(true)
    try {
      const created = await createTerminal({
        projectId,
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      })
      if (!created) {
        notify({
          text: t('terminal.create.failed'),
          type: 'error',
          category: 'error',
        })
        return
      }
      openTerminalTab(created)
    } finally {
      setCreating(false)
    }
  }, [createTerminal, currentSessionId, notify, projectId, t])

  if (!projectId) {
    return (
      <div
        className="py-6 text-center text-muted-foreground"
        data-testid="terminals-no-project"
      >
        <Icon name="terminal-box" className="mx-auto mb-2 size-8 opacity-40" />
        <p className="text-sm">{t('terminals.noProject')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-2" data-testid="terminals-section">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('terminals.title')}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs text-muted-foreground" data-testid="terminals-count">
            {t('terminals.count', { count: terminals.length })}
          </span>
          {/* Создание доступно всегда (не только в пустом состоянии): у проекта
              уже могут быть терминалы, а нужен ещё один. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={() => void handleCreate()}
            disabled={creating || !projectId}
            title={t('terminals.create')}
            aria-label={t('terminals.create')}
            data-testid="terminals-create-header"
          >
            <Icon
              name={creating ? 'loader-2' : 'add'}
              className={cn('size-3.5', creating && 'animate-spin')}
            />
          </Button>
        </div>
      </div>

      {loadError && (
        <div
          role="alert"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          data-testid="terminals-error"
        >
          {t('terminals.requestError', { error: loadError })}
        </div>
      )}

      {terminals.length === 0 ? (
        <div className="py-6 text-center text-muted-foreground" data-testid="terminals-empty">
          <Icon name="terminal-box" className="mx-auto mb-2 size-8 opacity-40" />
          <p className="text-sm">{t('terminals.empty')}</p>
          <p className="mt-1 text-xs opacity-80">{t('terminals.emptyHint')}</p>
          <Button
            variant="outline-primary"
            size="sm"
            className="mt-3"
            onClick={() => void handleCreate()}
            disabled={creating}
            data-testid="terminals-create"
          >
            <Icon name="terminal-box" className="size-3.5" />
            {t('terminals.create')}
          </Button>
        </div>
      ) : (
        <ul className="space-y-2 min-w-0" data-testid="terminals-list">
          {terminals.map((terminal) => (
            <li
              key={terminal.id}
              data-testid={`terminals-item-${terminal.id}`}
              data-status={terminal.status}
              className="min-w-0 space-y-2 rounded-lg border border-border bg-surface-inset p-3"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Icon name="terminal-box" className="size-4 shrink-0 text-muted-foreground" />
                <span
                  className="min-w-0 flex-1 truncate text-sm font-medium"
                  title={terminal.title || terminal.shell || terminal.id}
                >
                  {terminal.title || terminal.shell || terminal.id}
                </span>
                <span
                  className={cn(
                    BADGE,
                    STATUS_CLASS[terminal.status] ?? 'bg-muted text-muted-foreground',
                  )}
                  data-testid={`terminals-status-${terminal.id}`}
                >
                  {t(`terminal.status.${terminal.status}`)}
                </span>
                {terminal.can_write === false && (
                  <span
                    className={cn(BADGE, 'bg-surface-muted text-muted-foreground')}
                    data-testid={`terminals-readonly-${terminal.id}`}
                  >
                    {t('terminal.readOnly')}
                  </span>
                )}
              </div>

              <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-muted-foreground min-w-0">
                <Row label={t('terminals.row.cwd')} value={shortenPath(terminal.cwd)} mono />
                <Row label={t('terminals.row.shell')} value={terminal.shell} mono />
                <Row
                  label={t('terminals.row.session')}
                  value={
                    terminal.sessionId
                      ? (sessionNames.get(terminal.sessionId) ?? terminal.sessionId)
                      : t('terminals.row.noSession')
                  }
                  mono
                />
                {terminal.lastActivityAt > 0 && (
                  <Row
                    label={t('terminals.row.activity')}
                    value={formatDateTime(new Date(terminal.lastActivityAt).toISOString(), locale)}
                  />
                )}
              </dl>

              <div className="flex flex-wrap items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleOpen(terminal.id)}
                  title={t('terminals.action.open')}
                  aria-label={t('terminals.action.open')}
                  data-testid={`terminals-open-${terminal.id}`}
                >
                  <Icon name="external-link" className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="hover:text-destructive"
                  onClick={() => void handleStop(terminal.id)}
                  disabled={busy === terminal.id}
                  title={t('terminals.action.stop')}
                  aria-label={t('terminals.action.stop')}
                  data-testid={`terminals-stop-${terminal.id}`}
                >
                  <Icon name="stop" className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Строка «лейбл — значение» в карточке терминала. */
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-2 min-w-0">
      <dt className="shrink-0 font-medium">{label}:</dt>
      <dd
        className={cn(
          'min-w-0 break-words text-right',
          mono && 'font-mono text-[0.6875rem]',
        )}
      >
        {value}
      </dd>
    </div>
  )
}
