import { useCallback, useEffect, useMemo, useState } from 'react'

import type { Schedule, Timer } from '@itphx/synth-shared/types'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
import { formatDuration } from '@/lib/formatStats'
import { formatRemaining } from '@/lib/formatDuration'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/Toggle'
import { useActiveProject } from '@/hooks/useActiveProject'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useTimersStore } from '@/stores/timersStore'
import { useUIStore } from '@/stores/useUIStore'
import { PanelTab } from '../PanelTab'
import { PanelSectionEmpty, PanelSectionHeader } from '../PanelSection'
import { AutomationCard, type AutomationCardAction, type AutomationCardField } from './AutomationCard'
import { AutomationHistory, type AutomationHistoryEntry } from './AutomationHistory'
import { ScheduleEditorDialog, type ScheduleEditorDraft } from './ScheduleEditorDialog'
import { TimerEditorDialog } from './TimerEditorDialog'
import { scheduleToInput } from './scheduleForm'

/**
 * Вкладка «Автоматизация» правой панели (PROP-141, этап 7b).
 *
 * Единый реестр автоматизации проекта: **расписания** (ADR-051 — агент
 * запускается по cron/интервалу), **таймеры** и **будильники** (PROP-141 —
 * отложенный возврат к работе). Эталон формы — вкладка «Процессы».
 *
 * **Скоуп показа** — текущий контекст, как в «Процессах»:
 * - есть сессия → по умолчанию только её автоматизации; тумблер «Весь
 *   проект» расширяет выборку до всех сессий проекта;
 * - сессии нет (выделенный проект) → всегда проект, тумблер скрыт;
 * - нет ни проекта, ни сессии → пустое состояние.
 *
 * Источники данных: расписания — `GET /schedules` (фильтр скоупа уходит на
 * сервер), таймеры/будильники — `GET /timers` + live-события `timer.*`
 * (стор `timersStore`). Списки перечитываются каждые 5 с, пока вкладка
 * активна; обратный отсчёт тикает раз в секунду.
 */

/** Период перечитывания списков, мс (вкладка активна). */
const LIST_REFRESH_MS = 5000
/** Тикер обратного отсчёта — раз в секунду. */
const COUNTDOWN_TICK_MS = 1000
/** Потолок комментария в карточке (символов). */
const COMMENT_MAX = 160

/** Фильтр вида автоматизации. */
type KindFilter = 'all' | 'schedule' | 'timer' | 'alarm'
/** Фильтр состояния (по умолчанию — «все», чип не нажат). */
type StatusFilter = 'all' | 'active' | 'paused' | 'error'
/** Скоуп показа. */
type AutomationScope = 'session' | 'project' | 'none'

const KIND_FILTERS: KindFilter[] = ['all', 'schedule', 'timer', 'alarm']
const STATUS_FILTERS: StatusFilter[] = ['active', 'paused', 'error']

/** Усечение длинного комментария. */
function truncate(text: string, max = COMMENT_MAX): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/**
 * Вкладка «Автоматизация»: расписания, таймеры и будильники проекта.
 */
export const AutomationTab: React.FC = () => {
  const { t, locale } = useI18n()
  const { notify } = useNotification()

  // Скоуп: сессия активного контекста и её проект.
  const { projectId, sessionId } = useActiveProject()

  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [wholeProject, setWholeProject] = useState(false)

  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Раскрытые блоки истории (по id автоматизации).
  const [openHistory, setOpenHistory] = useState<string[]>([])

  // Диалоги редактора.
  const [scheduleDialog, setScheduleDialog] = useState<{
    open: boolean
    schedule: Schedule | null
    draft: ScheduleEditorDraft | null
  }>({ open: false, schedule: null, draft: null })
  const [timerDialog, setTimerDialog] = useState<{
    open: boolean
    kind: 'timer' | 'alarm'
    timer: Timer | null
  }>({ open: false, kind: 'timer', timer: null })

  const sessions = useSessionsStore((s) => s.sessions)
  const sessionNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const session of sessions) map.set(session.id, session.name || session.id)
    return map
  }, [sessions])

  const timersById = useTimersStore((s) => s.byId)
  const timersOrder = useTimersStore((s) => s.order)
  const loadTimers = useTimersStore((s) => s.load)
  const upsertTimer = useTimersStore((s) => s.upsert)
  const removeTimer = useTimersStore((s) => s.remove)

  // Deep-link из вкладки «Память» (ADR-101): черновик расписания.
  const scheduleDraft = useUIStore((s) => s.scheduleDraft)
  const setScheduleDraft = useUIStore((s) => s.setScheduleDraft)

  /**
   * Скоуп показа: сессия (по умолчанию) или весь её проект.
   *
   * Тумблер «Весь проект» есть только у сессии; без сессии (выделенный
   * проект, файловая вкладка) скоуп всегда проектный, переключатель скрыт.
   */
  const scope: AutomationScope = useMemo(() => {
    if (!sessionId && !projectId) return 'none'
    if (sessionId && !wholeProject) return 'session'
    return projectId ? 'project' : 'session'
  }, [projectId, sessionId, wholeProject])

  /** Загрузка расписаний — фильтр скоупа уходит на сервер. */
  const loadSchedules = useCallback(async () => {
    if (scope === 'none') {
      setSchedules([])
      return
    }
    try {
      const { schedules: list } = await synthApi.getSchedules(
        scope === 'session' && sessionId
          ? { sessionId }
          : projectId
            ? { projectId }
            : undefined,
      )
      setSchedules(list)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('common.error'))
    }
  }, [projectId, scope, sessionId, t])

  /** Загрузка таймеров/будильников — фильтр скоупа уходит на сервер. */
  const refreshTimers = useCallback(async () => {
    if (scope === 'none') return
    if (scope === 'session' && sessionId) {
      await loadTimers({ sessionId })
      return
    }
    if (scope === 'project' && projectId) {
      await loadTimers({ projectId })
      return
    }
    await loadTimers()
  }, [loadTimers, projectId, scope, sessionId])

  // Списки: первичная загрузка + перечитывание раз в 5 с, пока вкладка активна.
  useEffect(() => {
    let disposed = false
    const refresh = async () => {
      await Promise.all([loadSchedules(), refreshTimers()])
      if (!disposed) setLoading(false)
    }
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, LIST_REFRESH_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [loadSchedules, refreshTimers])

  // Тикер обратного отсчёта.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  // Deep-link из вкладки «Память»: открыть редактор с предзаполненной формой.
  useEffect(() => {
    if (!scheduleDraft) return
    setScheduleDialog({ open: true, schedule: null, draft: scheduleDraft })
    setScheduleDraft(null)
  }, [scheduleDraft, setScheduleDraft])

  /** Таймеры/будильники в текущем скоупе (реестр общий — фильтр здесь). */
  const scopedTimers = useMemo(() => {
    const all = timersOrder
      .map((id) => timersById[id])
      .filter((timer): timer is Timer => !!timer)
    if (scope === 'session') return all.filter((timer) => timer.sessionId === sessionId)
    if (scope === 'project') return all.filter((timer) => timer.projectId === projectId)
    return []
  }, [timersById, timersOrder, scope, sessionId, projectId])

  const timerRecords = useMemo(
    () => scopedTimers.filter((timer) => timer.kind === 'timer'),
    [scopedTimers],
  )
  const alarmRecords = useMemo(
    () => scopedTimers.filter((timer) => timer.kind === 'alarm'),
    [scopedTimers],
  )

  /** Проходит ли запись через фильтр состояния. */
  const matchStatus = useCallback(
    (state: { active: boolean; paused: boolean; error: boolean }) => {
      if (statusFilter === 'all') return true
      if (statusFilter === 'active') return state.active
      if (statusFilter === 'paused') return state.paused
      return state.error
    },
    [statusFilter],
  )

  const visibleSchedules = useMemo(
    () =>
      (schedules ?? []).filter((schedule) =>
        matchStatus({
          active: schedule.enabled,
          paused: !schedule.enabled,
          error: schedule.lastStatus === 'error' || !!schedule.lastError,
        }),
      ),
    [matchStatus, schedules],
  )
  const visibleTimers = useMemo(
    () =>
      timerRecords.filter((timer) =>
        matchStatus({
          active: timer.status === 'active',
          paused: timer.status === 'paused',
          error: !!timer.lastError,
        }),
      ),
    [matchStatus, timerRecords],
  )
  const visibleAlarms = useMemo(
    () =>
      alarmRecords.filter((timer) =>
        matchStatus({
          active: timer.status === 'active',
          paused: timer.status === 'paused',
          error: !!timer.lastError,
        }),
      ),
    [matchStatus, alarmRecords],
  )

  /** Цель расписания (сессия/проект/пайплайн) — человекочитаемая строка. */
  const scheduleTargetLabel = useCallback(
    (schedule: Schedule): string => {
      const target = schedule.target
      if (target.mode === 'ephemeral') {
        const parts = [t('rightPanel.scheduler.target.ephemeral')]
        if (target.agentTemplate) {
          parts.push(`${t('rightPanel.scheduler.field.agent')}: ${target.agentTemplate}`)
        }
        if (target.project) {
          parts.push(`${t('rightPanel.scheduler.field.project')}: ${target.project}`)
        }
        return parts.join(' · ')
      }
      if (target.mode === 'pipeline') {
        return `${t('rightPanel.scheduler.target.pipelineRun')}: ${target.projectId} / ${target.pipelineId}`
      }
      const label =
        target.mode === 'queue'
          ? t('rightPanel.scheduler.target.queue')
          : t('rightPanel.scheduler.target.bound')
      return `${label}: ${sessionNames.get(target.sessionId) ?? target.sessionId}`
    },
    [sessionNames, t],
  )

  /** Триггер таймера/будильника — человекочитаемая строка. */
  const timerTriggerLabel = useCallback(
    (timer: Timer): string => {
      const repeat = timer.repeat
      if (repeat.mode === 'every') {
        return t('automation.trigger.everyMin', {
          minutes: String(Math.max(1, Math.round(repeat.everySec / 60))),
        })
      }
      if (repeat.mode === 'daily') {
        return t('automation.trigger.dailyAt', { time: repeat.time })
      }
      if (timer.kind === 'alarm') {
        return t('automation.trigger.at', { time: formatDateTime(timer.firesAt, locale) })
      }
      // Одноразовый таймер: задержка восстанавливается из createdAt→firesAt.
      const created = Date.parse(timer.createdAt)
      const fires = Date.parse(timer.firesAt)
      const minutes = Number.isFinite(created) && Number.isFinite(fires)
        ? Math.max(1, Math.round((fires - created) / 60_000))
        : 0
      return t('automation.trigger.in', { minutes: String(minutes) })
    },
    [locale, t],
  )

  /** Остаток до ближайшего срабатывания (тикер раз в секунду). */
  const remainingLabel = useCallback(
    (timer: Timer): string | undefined => {
      if (timer.status !== 'active') return undefined
      const fires = Date.parse(timer.firesAt)
      if (!Number.isFinite(fires)) return undefined
      return formatRemaining(fires - now)
    },
    [now],
  )

  /** Переключить раскрытие истории автоматизации. */
  const toggleHistory = useCallback((id: string) => {
    setOpenHistory((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
  }, [])

  /** Общий обработчик ошибки мутации. */
  const reportError = useCallback(
    (key: string, error: unknown) => {
      notify({
        text: t(key, { error: error instanceof Error ? error.message : t('common.error') }),
        type: 'error',
        category: 'error',
      })
    },
    [notify, t],
  )

  /** Включение/выключение расписания. */
  const handleToggleSchedule = useCallback(
    async (schedule: Schedule) => {
      setBusy(schedule.id)
      try {
        await synthApi.updateSchedule(schedule.id, {
          ...scheduleToInput(schedule),
          enabled: !schedule.enabled,
        })
        await loadSchedules()
      } catch (err) {
        reportError('automation.toggleError', err)
      } finally {
        setBusy(null)
      }
    },
    [loadSchedules, reportError],
  )

  /** Принудительный запуск расписания. */
  const handleRunSchedule = useCallback(
    async (schedule: Schedule) => {
      setBusy(schedule.id)
      try {
        await synthApi.runSchedule(schedule.id)
        await loadSchedules()
        notify({ text: t('automation.runSuccess'), type: 'success', category: 'system' })
      } catch (err) {
        reportError('automation.runError', err)
      } finally {
        setBusy(null)
      }
    },
    [loadSchedules, notify, reportError, t],
  )

  /** Удаление расписания. */
  const handleDeleteSchedule = useCallback(
    async (schedule: Schedule) => {
      const ok = await confirm({
        title: t('automation.deleteTitle'),
        message: t('automation.deleteConfirm', { name: schedule.name }),
        confirmLabel: t('common.delete'),
        variant: 'danger',
        icon: 'delete-bin',
      })
      if (!ok) return
      setBusy(schedule.id)
      try {
        await synthApi.deleteSchedule(schedule.id)
        await loadSchedules()
        notify({ text: t('automation.deleted'), type: 'success', category: 'system' })
      } catch (err) {
        reportError('automation.deleteError', err)
      } finally {
        setBusy(null)
      }
    },
    [loadSchedules, notify, reportError, t],
  )

  /** Пауза/возобновление таймера или будильника. */
  const handleToggleTimer = useCallback(
    async (timer: Timer) => {
      setBusy(timer.id)
      try {
        const updated =
          timer.status === 'paused'
            ? await synthApi.resumeTimer(timer.id)
            : await synthApi.pauseTimer(timer.id)
        upsertTimer(updated)
        notify({
          text: t(updated.status === 'paused' ? 'automation.paused' : 'automation.resumed'),
          type: 'success',
          category: 'system',
        })
        await refreshTimers()
      } catch (err) {
        reportError('automation.pauseError', err)
      } finally {
        setBusy(null)
      }
    },
    [notify, refreshTimers, reportError, t, upsertTimer],
  )

  /** Удаление таймера или будильника. */
  const handleDeleteTimer = useCallback(
    async (timer: Timer) => {
      const ok = await confirm({
        title: t('automation.deleteTitle'),
        message: t('automation.deleteConfirm', { name: timer.name || timer.comment }),
        confirmLabel: t('common.delete'),
        variant: 'danger',
        icon: 'delete-bin',
      })
      if (!ok) return
      setBusy(timer.id)
      try {
        await synthApi.removeTimer(timer.id)
        removeTimer(timer.id)
        notify({ text: t('automation.deleted'), type: 'success', category: 'system' })
        await refreshTimers()
      } catch (err) {
        reportError('automation.deleteError', err)
      } finally {
        setBusy(null)
      }
    },
    [notify, refreshTimers, removeTimer, reportError, t],
  )

  /** История запусков расписания (Job-история, ADR-051). */
  const loadScheduleHistory = useCallback(
    async (scheduleId: string): Promise<AutomationHistoryEntry[]> => {
      const { jobs } = await synthApi.getScheduleJobs(scheduleId)
      return jobs.map((job) => ({
        id: job.id,
        statusKey: job.status,
        statusLabel: t(`rightPanel.scheduler.status.${job.status}`),
        time: formatDateTime(job.finishedAt, locale),
        detail: `${t(`automation.history.trigger.${job.trigger}`)} · ${formatDuration(job.durationMs)}`,
        ...(job.error ? { error: job.error } : {}),
      }))
    },
    [locale, t],
  )

  /** История срабатываний таймера/будильника. */
  const loadTimerHistory = useCallback(
    async (timerId: string): Promise<AutomationHistoryEntry[]> => {
      const firings = await synthApi.getTimerFirings(timerId)
      return firings.map((firing) => ({
        id: firing.id,
        statusKey: firing.outcome,
        statusLabel: t(`automation.history.outcome.${firing.outcome}`),
        time: formatDateTime(firing.firedAt, locale),
        detail: formatDateTime(firing.scheduledFor, locale),
      }))
    },
    [locale, t],
  )

  // Без сессии и проекта показывать нечего.
  if (scope === 'none') {
    return (
      <PanelTab>
        <PanelSectionEmpty
          icon="calendar-schedule"
          title={t('automation.empty.noContext')}
          hint={t('automation.empty.noContextHint')}
          testId="automation-no-context"
        />
      </PanelTab>
    )
  }

  /** Действия карточки расписания. */
  const scheduleActions = (schedule: Schedule): AutomationCardAction[] => [
    {
      key: 'toggle',
      icon: schedule.enabled ? 'stop' : 'play',
      label: t(schedule.enabled ? 'automation.action.disable' : 'automation.action.enable'),
      onClick: () => void handleToggleSchedule(schedule),
      disabled: busy === schedule.id,
    },
    {
      key: 'run',
      icon: 'rocket',
      label: t('automation.action.runNow'),
      onClick: () => void handleRunSchedule(schedule),
      disabled: busy === schedule.id,
    },
    {
      key: 'edit',
      icon: 'edit-2',
      label: t('automation.action.edit'),
      onClick: () => setScheduleDialog({ open: true, schedule, draft: null }),
    },
    {
      key: 'history',
      icon: 'time',
      label: t('automation.action.history'),
      onClick: () => toggleHistory(schedule.id),
    },
    {
      key: 'delete',
      icon: 'delete-bin',
      label: t('automation.action.delete'),
      onClick: () => void handleDeleteSchedule(schedule),
      disabled: busy === schedule.id,
      destructive: true,
    },
  ]

  /** Действия карточки таймера/будильника. */
  const timerActions = (timer: Timer): AutomationCardAction[] => [
    {
      key: 'pause',
      icon: timer.status === 'paused' ? 'play' : 'pause',
      label: t(timer.status === 'paused' ? 'automation.action.resume' : 'automation.action.pause'),
      onClick: () => void handleToggleTimer(timer),
      disabled: busy === timer.id,
    },
    {
      key: 'edit',
      icon: 'edit-2',
      label: t('automation.action.edit'),
      onClick: () => setTimerDialog({ open: true, kind: timer.kind, timer }),
    },
    {
      key: 'history',
      icon: 'time',
      label: t('automation.action.history'),
      onClick: () => toggleHistory(timer.id),
    },
    {
      key: 'delete',
      icon: 'delete-bin',
      label: t('automation.action.delete'),
      onClick: () => void handleDeleteTimer(timer),
      disabled: busy === timer.id,
      destructive: true,
    },
  ]

  /** Секция «Расписания». */
  const schedulesSection = (kindFilter === 'all' || kindFilter === 'schedule') && (
    <section className="space-y-2" data-testid="automation-section-schedule">
      <PanelSectionHeader
        title={t('automation.section.schedules')}
        count={t('automation.count.schedules', { count: visibleSchedules.length })}
        testId="automation-section-schedule"
        actions={
          <Button
            variant="outline-muted"
            size="icon"
            onClick={() => setScheduleDialog({ open: true, schedule: null, draft: null })}
            title={t('automation.action.addSchedule')}
            aria-label={t('automation.action.addSchedule')}
            data-testid="automation-add-schedule"
          >
            <Icon name="add" className="size-4" />
          </Button>
        }
      />
      {visibleSchedules.length === 0 ? (
        <PanelSectionEmpty
          icon="calendar-schedule"
          title={t('automation.empty.schedules')}
          hint={t('automation.empty.schedulesHint')}
          testId="automation-empty-schedule"
        />
      ) : (
        <ul className="space-y-2 min-w-0" data-testid="automation-list-schedule">
          {visibleSchedules.map((schedule) => {
            const fields: AutomationCardField[] = [
              { label: t('automation.row.target'), value: scheduleTargetLabel(schedule) },
              {
                label: t('automation.row.trigger'),
                value: schedule.every
                  ? `${t('automation.trigger.every')} ${schedule.every}`
                  : `${t('automation.trigger.cron')} ${schedule.cron ?? ''}`,
                mono: !schedule.every,
              },
              {
                label: t('automation.row.nextRun'),
                value: formatDateTime(schedule.nextRunAt, locale),
              },
              {
                label: t('automation.row.lastRun'),
                value: formatDateTime(schedule.lastRunAt, locale),
              },
            ]
            return (
              <AutomationCard
                key={schedule.id}
                testId={`automation-item-${schedule.id}`}
                icon="calendar-schedule"
                name={schedule.name}
                statusKey={schedule.enabled ? 'active' : 'disabled'}
                statusLabel={t(
                  schedule.enabled ? 'automation.status.enabled' : 'automation.status.disabled',
                )}
                fields={fields}
                {...(schedule.prompt ? { comment: truncate(schedule.prompt) } : {})}
                {...(schedule.lastError ? { error: schedule.lastError } : {})}
                actions={scheduleActions(schedule)}
              >
                <AutomationHistory
                  testId={`automation-history-${schedule.id}`}
                  open={openHistory.includes(schedule.id)}
                  onToggle={() => toggleHistory(schedule.id)}
                  load={() => loadScheduleHistory(schedule.id)}
                />
              </AutomationCard>
            )
          })}
        </ul>
      )}
    </section>
  )

  /** Секция «Таймеры». */
  const timersSection = (kindFilter === 'all' || kindFilter === 'timer') && (
    <section className="space-y-2" data-testid="automation-section-timer">
      <PanelSectionHeader
        title={t('automation.section.timers')}
        count={t('automation.count.timers', { count: visibleTimers.length })}
        testId="automation-section-timer"
        actions={
          <Button
            variant="outline-muted"
            size="icon"
            onClick={() => setTimerDialog({ open: true, kind: 'timer', timer: null })}
            title={t('automation.action.addTimer')}
            aria-label={t('automation.action.addTimer')}
            data-testid="automation-add-timer"
          >
            <Icon name="add" className="size-4" />
          </Button>
        }
      />
      {visibleTimers.length === 0 ? (
        <PanelSectionEmpty
          icon="time"
          title={t('automation.empty.timers')}
          hint={t('automation.empty.timersHint')}
          testId="automation-empty-timer"
        />
      ) : (
        <ul className="space-y-2 min-w-0" data-testid="automation-list-timer">
          {visibleTimers.map((timer) => {
            const fields: AutomationCardField[] = [
              {
                label: t('automation.row.target'),
                value: sessionNames.get(timer.sessionId) ?? timer.sessionId,
              },
              { label: t('automation.row.trigger'), value: timerTriggerLabel(timer) },
              {
                label: t('automation.row.nextRun'),
                value: formatDateTime(timer.firesAt, locale),
              },
            ]
            const remaining = remainingLabel(timer)
            if (remaining) {
              fields.push({ label: t('automation.row.remaining'), value: remaining, mono: true })
            }
            if (timer.firedAt) {
              fields.push({
                label: t('automation.row.lastRun'),
                value: formatDateTime(timer.firedAt, locale),
              })
            }
            return (
              <AutomationCard
                key={timer.id}
                testId={`automation-item-${timer.id}`}
                icon="time"
                name={timer.name || truncate(timer.comment, 60)}
                statusKey={timer.status}
                statusLabel={t(`automation.status.${timer.status}`)}
                fields={fields}
                {...(timer.name ? { comment: truncate(timer.comment) } : {})}
                {...(timer.lastError ? { error: timer.lastError } : {})}
                actions={timerActions(timer)}
              >
                <AutomationHistory
                  testId={`automation-history-${timer.id}`}
                  open={openHistory.includes(timer.id)}
                  onToggle={() => toggleHistory(timer.id)}
                  load={() => loadTimerHistory(timer.id)}
                />
              </AutomationCard>
            )
          })}
        </ul>
      )}
    </section>
  )

  /** Секция «Будильники». */
  const alarmsSection = (kindFilter === 'all' || kindFilter === 'alarm') && (
    <section className="space-y-2" data-testid="automation-section-alarm">
      <PanelSectionHeader
        title={t('automation.section.alarms')}
        count={t('automation.count.alarms', { count: visibleAlarms.length })}
        testId="automation-section-alarm"
        actions={
          <Button
            variant="outline-muted"
            size="icon"
            onClick={() => setTimerDialog({ open: true, kind: 'alarm', timer: null })}
            title={t('automation.action.addAlarm')}
            aria-label={t('automation.action.addAlarm')}
            data-testid="automation-add-alarm"
          >
            <Icon name="add" className="size-4" />
          </Button>
        }
      />
      {visibleAlarms.length === 0 ? (
        <PanelSectionEmpty
          icon="alarm"
          title={t('automation.empty.alarms')}
          hint={t('automation.empty.alarmsHint')}
          testId="automation-empty-alarm"
        />
      ) : (
        <ul className="space-y-2 min-w-0" data-testid="automation-list-alarm">
          {visibleAlarms.map((timer) => {
            const fields: AutomationCardField[] = [
              {
                label: t('automation.row.target'),
                value: sessionNames.get(timer.sessionId) ?? timer.sessionId,
              },
              { label: t('automation.row.trigger'), value: timerTriggerLabel(timer) },
              {
                label: t('automation.row.nextRun'),
                value: formatDateTime(timer.firesAt, locale),
              },
            ]
            const remaining = remainingLabel(timer)
            if (remaining) {
              fields.push({ label: t('automation.row.remaining'), value: remaining, mono: true })
            }
            if (timer.firedAt) {
              fields.push({
                label: t('automation.row.lastRun'),
                value: formatDateTime(timer.firedAt, locale),
              })
            }
            return (
              <AutomationCard
                key={timer.id}
                testId={`automation-item-${timer.id}`}
                icon="alarm"
                name={timer.name || truncate(timer.comment, 60)}
                statusKey={timer.status}
                statusLabel={t(`automation.status.${timer.status}`)}
                fields={fields}
                {...(timer.name ? { comment: truncate(timer.comment) } : {})}
                {...(timer.lastError ? { error: timer.lastError } : {})}
                actions={timerActions(timer)}
              >
                <AutomationHistory
                  testId={`automation-history-${timer.id}`}
                  open={openHistory.includes(timer.id)}
                  onToggle={() => toggleHistory(timer.id)}
                  load={() => loadTimerHistory(timer.id)}
                />
              </AutomationCard>
            )
          })}
        </ul>
      )}
    </section>
  )

  return (
    <PanelTab>
      {/* Фильтры вида + состояния и переключатель скоупа. */}
      <div className="space-y-2" data-testid="automation-filters">
        <div
          className="flex items-start gap-2"
          role="group"
          aria-label={t('automation.filter.title')}
          data-testid="automation-kind-filter"
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {KIND_FILTERS.map((filter) => (
              <Button
                key={filter}
                variant={kindFilter === filter ? 'primary' : 'outline-muted'}
                size="sm"
                aria-pressed={kindFilter === filter}
                onClick={() => setKindFilter(filter)}
                data-testid={`automation-filter-${filter}`}
              >
                {t(`automation.filter.${filter}`)}
              </Button>
            ))}
          </div>

          {/* Тумблер есть только у сессии проекта: без сессии скоуп всегда
              проектный, а без проекта расширять выборку нечем. */}
          {sessionId && projectId && (
            <span
              className="shrink-0 ml-auto flex items-center gap-2 text-xs text-muted-foreground"
              data-testid="automation-whole-project"
            >
              {t('automation.filter.wholeProject')}
              <Toggle
                enabled={wholeProject}
                onToggle={() => setWholeProject((value) => !value)}
                ariaLabel={t('automation.filter.wholeProject')}
              />
            </span>
          )}
        </div>

        <div
          className="flex items-start gap-2"
          role="group"
          aria-label={t('automation.filter.title')}
          data-testid="automation-status-filter"
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {STATUS_FILTERS.map((filter) => (
              <Button
                key={filter}
                variant={statusFilter === filter ? 'primary' : 'outline-muted'}
                size="sm"
                aria-pressed={statusFilter === filter}
                onClick={() => setStatusFilter((current) => (current === filter ? 'all' : filter))}
                data-testid={`automation-status-${filter}`}
              >
                {t(`automation.filter.${filter}`)}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {loadError && (
        <div
          role="alert"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          data-testid="automation-error"
        >
          {t('automation.loadError', { error: loadError })}
        </div>
      )}

      {loading && schedules === null && (
        <div
          role="status"
          className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground"
          data-testid="automation-loading"
        >
          <Icon name="loader-2" className="size-3.5 animate-spin" />
          {t('common.loading')}
        </div>
      )}

      {schedulesSection}
      {timersSection}
      {alarmsSection}

      <ScheduleEditorDialog
        open={scheduleDialog.open}
        schedule={scheduleDialog.schedule}
        draft={scheduleDialog.draft}
        defaultSessionId={sessionId}
        defaultProjectId={projectId}
        onClose={() => setScheduleDialog({ open: false, schedule: null, draft: null })}
        onSaved={() => void loadSchedules()}
      />
      <TimerEditorDialog
        open={timerDialog.open}
        kind={timerDialog.kind}
        timer={timerDialog.timer}
        defaultSessionId={sessionId}
        defaultProjectId={projectId}
        onClose={() => setTimerDialog({ open: false, kind: 'timer', timer: null })}
        onSaved={(timer) => {
          upsertTimer(timer)
          void refreshTimers()
        }}
      />
    </PanelTab>
  )
}
