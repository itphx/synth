// TerminalsSection: карточки терминалов во вкладке «Процессы»
// правой панели (PROP-132, Ф4б).
//
// Источник истины — серверный список `GET /terminals?project_id=<активный
// проект>&include_exited=true` (завершённые терминалы — в т.ч. восстановленные
// после рестарта ядра — тоже видны); live-обновление — события `terminal.*`
// (реестр терминалов) плюс перечитывание раз в 5 с, пока секция открыта
// (как список фоновых прогонов).
//
// Карточка: оболочка, каталог (сокращённый), статус, привязанная сессия,
// «Время работы», бейдж «только просмотр» (`can_write=false`) и действия
// «Открыть» / «Остановить» (DELETE — с подтверждением).
//
// **Средний клик по карточке** закрывает терминал: завершённый — сразу,
// живой — после пробы переднего плана (`GET /terminals/:id/foreground`):
// в фокусе оболочка → закрываем, в фокусе обычная команда → не закрываем
// (тост), факт неизвестен → спрашиваем человека.

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { synthApi } from '@/lib/api/synthApi'
import type { TerminalForeground } from '@/lib/api/synthApi'
import { confirm } from '@/lib/confirm'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/formatDate'
import { formatDuration } from '@/lib/formatStats'
import { openTerminalTab } from '@/lib/terminalTabs'
import { shortenPath } from '@/lib/terminalContext'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { useNotification } from '@/hooks/useNotification'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useTerminalsStore } from '@/stores/terminalsStore'
import { useUIStore } from '@/stores/useUIStore'
import { PanelSectionEmpty, PanelSectionHeader } from './PanelSection'

/** Период перечитывания списка терминалов, мс (секция открыта). */
const LIST_REFRESH_MS = 5000
/** Тикер «время работы» — раз в секунду. */
const ELAPSED_TICK_MS = 1000

/** Общий стиль бейджа (как в «Памяти»/«Процессах»). */
const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа статуса терминала. */
const STATUS_CLASS: Record<string, string> = {
  starting: 'bg-primary/15 text-primary',
  running: 'bg-status-success/15 text-status-success',
  exited: 'bg-muted text-muted-foreground',
}

/**
 * Время работы терминала: живой — от создания до «сейчас», завершённый —
 * от создания до последней активности.
 */
function terminalUptimeMs(
  terminal: { createdAt: number; lastActivityAt: number; status: string },
  now: number,
): number | undefined {
  const created = terminal.createdAt
  if (!created) return undefined
  if (terminal.status === 'exited') {
    return Math.max(0, (terminal.lastActivityAt || created) - created)
  }
  return Math.max(0, now - created)
}

export interface TerminalsSectionProps {
  /** Активный проект (список терминалов проекта). */
  projectId: string | null
  /** Сессия активного контекста — терминалы привязываются к ней. */
  sessionId: string | null
  /** Показывать только терминалы этой сессии (иначе — весь проект). */
  sessionOnly: boolean
}

export const TerminalsSection: React.FC<TerminalsSectionProps> = ({
  projectId,
  sessionId,
  sessionOnly,
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
  const [now, setNow] = useState(() => Date.now())

  // Список терминалов проекта: первичная загрузка + перечитывание раз в 5 с,
  // пока секция открыта. `includeExited` — вместе с завершёнными: терминал,
  // восстановленный после рестарта ядра, иначе в списке не виден.
  useEffect(() => {
    if (!projectId && !sessionId) return
    const options = projectId
      ? { projectId, includeExited: true }
      : { sessionId: sessionId!, includeExited: true }
    void loadTerminals(options)
    const timer = setInterval(() => {
      void loadTerminals(options)
    }, LIST_REFRESH_MS)
    return () => clearInterval(timer)
  }, [projectId, sessionId, loadTerminals])

  // Тикер «время работы» живых терминалов.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const terminals = useMemo(() => {
    const list = order
      .map((id) => terminalsById[id])
      .filter((terminal): terminal is NonNullable<typeof terminal> => !!terminal)
    return list
      .filter((terminal) => (projectId ? terminal.projectId === projectId : true))
      .filter((terminal) =>
        sessionOnly && sessionId ? terminal.sessionId === sessionId : true,
      )
  }, [sessionId, sessionOnly, order, projectId, terminalsById])

  /** Открытие терминала в центральной вкладке. */
  const handleOpen = useCallback((terminalId: string) => {
    const terminal = useTerminalsStore.getState().terminalsById[terminalId]
    if (!terminal) return
    openTerminalTab(terminal)
  }, [])

  /** Закрытие терминала: DELETE + закрытие открытой вкладки. */
  const closeTerminalById = useCallback(
    async (terminalId: string) => {
      const closed = await closeTerminal(terminalId)
      if (!closed) return
      // Вкладка закрытого терминала больше не нужна.
      useUIStore.getState().closeTab(`terminal-${terminalId}`)
      notify({ text: t('terminals.stopped'), type: 'success', category: 'system' })
    },
    [closeTerminal, notify, t],
  )

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
        await closeTerminalById(terminalId)
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
    [closeTerminalById, notify, t],
  )

  /**
   * Средний клик по карточке терминала — закрыть его.
   *
   * Завершённый терминал закрываем сразу. Живой — сначала проба переднего
   * плана: в фокусе оболочка → закрываем; в фокусе обычная команда → не
   * закрываем (тост-предупреждение); факт неизвестен (проба не удалась или
   * сервер не ответил) → подтверждение человека.
   */
  const handleMiddleClick = useCallback(
    async (terminalId: string) => {
      if (busy) return
      setBusy(terminalId)
      try {
        const terminal = useTerminalsStore.getState().terminalsById[terminalId]
        if (!terminal) return
        const name = terminal.title || terminal.shell || terminal.id

        if (terminal.status === 'exited') {
          await closeTerminalById(terminalId)
          return
        }

        let foreground: TerminalForeground | null = null
        try {
          foreground = await synthApi.getTerminalForeground(terminalId)
        } catch {
          foreground = null
        }

        // В терминале идёт обычная команда — закрывать его нельзя.
        if (foreground && !foreground.isShell) {
          notify({
            text: t('terminals.busy', { command: foreground.command ?? '' }),
            type: 'warning',
            category: 'system',
          })
          return
        }
        if (foreground?.isShell) {
          await closeTerminalById(terminalId)
          return
        }

        // Факт неизвестен — спрашиваем человека.
        const ok = await confirm({
          title: t('terminals.confirm.stopTitle'),
          message: t('terminals.confirm.stopMessage', { name }),
          confirmLabel: t('terminals.action.stop'),
          variant: 'danger',
          icon: 'stop',
        })
        if (!ok) return
        await closeTerminalById(terminalId)
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
    [busy, closeTerminalById, notify, t],
  )

  /** Создание терминала проекта (шапка секции). */
  const handleCreate = useCallback(async () => {
    if (!projectId) return
    setCreating(true)
    try {
      const created = await createTerminal({
        projectId,
        ...(sessionId ? { sessionId } : {}),
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
  }, [createTerminal, notify, projectId, sessionId, t])

  if (!projectId && !sessionId) {
    return (
      <PanelSectionEmpty
        icon="terminal-box"
        title={t('terminals.noProject')}
        hint={t('terminals.emptyHint')}
        testId="terminals-no-project"
      />
    )
  }

  return (
    <div className="space-y-2" data-testid="terminals-section">
      <PanelSectionHeader
        title={t('terminals.title')}
        count={t('terminals.count', { count: terminals.length })}
        testId="terminals-section"
        actions={
          // Создание доступно всегда (не только в пустом состоянии): у проекта
          // уже могут быть терминалы, а нужен ещё один.
          projectId ? (
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
          ) : undefined
        }
      />

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
        <PanelSectionEmpty
          icon="terminal-box"
          title={t('terminals.empty')}
          hint={t('terminals.emptyHint')}
          testId="terminals-empty"
        />
      ) : (
        <ul className="space-y-2 min-w-0" data-testid="terminals-list">
          {terminals.map((terminal) => {
            const uptimeMs = terminalUptimeMs(terminal, now)
            return (
              <li
                key={terminal.id}
                data-testid={`terminals-item-${terminal.id}`}
                data-status={terminal.status}
                className="min-w-0 space-y-2 rounded-lg border border-border bg-surface-inset p-3"
                onMouseDown={(event) => {
                  // Средняя кнопка не должна запускать автоскролл браузера.
                  if (event.button === 1) event.preventDefault()
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  void handleMiddleClick(terminal.id)
                }}
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
                  {uptimeMs !== undefined && (
                    <Row
                      label={t('terminals.row.uptime')}
                      value={formatDuration(uptimeMs)}
                    />
                  )}
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
            )
          })}
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
