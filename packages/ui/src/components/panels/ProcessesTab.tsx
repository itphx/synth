import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { synthApi } from '@/lib/api/synthApi'
import type { BackgroundRunRecord, BlockingRun } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { moveSessionToBackground } from '@/lib/backgroundDetach'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/formatDate'
import { formatDuration } from '@/lib/formatStats'
import { openBlockingLogTab, openProcessLogTab } from '@/lib/processTabs'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/Toggle'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProcessesStore } from '@/stores/processesStore'
import { useActiveProject } from '@/hooks/useActiveProject'
import { PanelTab } from './PanelTab'
import { PanelSectionEmpty, PanelSectionHeader } from './PanelSection'
import { TerminalsSection } from './TerminalsSection'
import { BlockingRunCard } from './BlockingRunCard'

/**
 * Вкладка «Процессы» правой панели — единый реестр фоновой работы:
 * шелл-процессы (`kind: 'process'`), фоновые дочерние сессии саб-агентов
 * (`kind: 'subagent'`) и интерактивные терминалы (`TerminalsSection`).
 *
 * **Скоуп показа** — не «весь инстанс», а текущий контекст:
 * - есть сессия → по умолчанию только её записи; тумблер «Весь проект»
 *   расширяет выборку до всех сессий проекта;
 * - сессии нет (выделенный проект, файловая вкладка) → всегда проект,
 *   тумблер скрыт;
 * - нет ни проекта, ни сессии → пустое состояние «Выберите сессию или проект».
 *
 * Источник истины — серверный реестр (`GET /api/v2/processes`), live-обновление
 * — события `process.*`/`child.*` (диспетчер `stores/transportStore.ts`).
 * Периодическое перечитывание списка (5 с) — только пока вкладка активна:
 * компонент смонтирован ровно тогда, когда вкладка открыта.
 */

/** Период перечитывания списка прогонов, мс (вкладка активна). */
const LIST_REFRESH_MS = 5000
/** Тикер «время работы» — раз в секунду. */
const ELAPSED_TICK_MS = 1000

/** Фильтр вида фоновой работы. */
type KindFilter = 'all' | 'process' | 'subagent' | 'terminal'

/** Фильтры вида (для кнопок-переключателей). */
const KIND_FILTERS: KindFilter[] = ['all', 'process', 'subagent', 'terminal']

/** Скоуп показа записей реестра. */
type RunScope = 'session' | 'project' | 'none'

/** Общий стиль бейджа (как в «Памяти»). */
const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа статуса фонового прогона. */
const STATUS_CLASS: Record<string, string> = {
  running: 'bg-primary/15 text-primary',
  completed: 'bg-status-success/15 text-status-success',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
  orphaned: 'bg-status-warning/15 text-status-warning',
}

/** Иконка вида фоновой работы. */
function kindIcon(kind: BackgroundRunRecord['kind']): 'terminal-box' | 'robot-2' {
  return kind === 'subagent' ? 'robot-2' : 'terminal-box'
}

/** Человеческое имя прогона: команда, описание, заголовок или id. */
function runTitle(run: {
  id: string
  command?: string | null
  description?: string | null
  title?: string | null
}): string {
  return run.title || run.command || run.description || run.id
}

/**
 * ADR-126 §5: имя скрипта, которым запущен прогон (`metadata.script`).
 *
 * Скриптовый прогон отличается от обычной шелл-команды: у него есть
 * декларация в реестре, и его можно запустить снова одним нажатием.
 * Признак — строка в `metadata`; иначе прогон обычный.
 */
function scriptName(run: BackgroundRunRecord): string | null {
  const value = run.metadata?.script
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Время работы прогона: выполняется — от старта до «сейчас», иначе — по финишу. */
function runUptimeMs(run: BackgroundRunRecord, now: number): number | undefined {
  const started = Date.parse(run.startedAt ?? '')
  if (run.status === 'running') {
    return Math.max(0, now - (Number.isFinite(started) ? started : now))
  }
  const finished = Date.parse(run.finishedAt ?? '')
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return undefined
  return Math.max(0, finished - started)
}

export const ProcessesTab: React.FC = () => {
  const { t } = useI18n()
  const { notify } = useNotification()

  // Фильтр вида фоновой работы и переключатель скоупа («Весь проект»).
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [wholeProject, setWholeProject] = useState(false)

  // Скоуп: сессия активного контекста и её проект.
  const { projectId, sessionId } = useActiveProject()

  const sessions = useSessionsStore((s) => s.sessions)
  const sessionNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const session of sessions) map.set(session.id, session.name || session.id)
    return map
  }, [sessions])

  /** Проект каждой сессии — по нему прогон попадает в скоуп проекта. */
  const sessionProjects = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const session of sessions) map.set(session.id, session.project_id ?? null)
    return map
  }, [sessions])

  const byId = useProcessesStore((s) => s.byId)
  const order = useProcessesStore((s) => s.order)
  const blocking = useProcessesStore((s) => s.blocking)
  const loadError = useProcessesStore((s) => s.error)
  const load = useProcessesStore((s) => s.load)
  const removeRun = useProcessesStore((s) => s.remove)

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  /**
   * Скоуп показа: сессия (по умолчанию) или весь её проект.
   *
   * Тумблер «Весь проект» есть только у сессии; без сессии (выделенный
   * проект, файловая вкладка) скоуп всегда проектный, а переключатель скрыт.
   */
  const scope: RunScope = useMemo(() => {
    if (!sessionId && !projectId) return 'none'
    if (sessionId && !wholeProject) return 'session'
    return projectId ? 'project' : 'session'
  }, [projectId, sessionId, wholeProject])

  /**
   * Загрузка списка **в текущем скоупе** — фильтр задаётся серверу.
   *
   * Раньше список грузился без фильтров (50 свежих по всему инстансу), а
   * скоуп фильтровался на клиенте: при большом числе прогонов записи нужного
   * скоупа в выборку просто не попадали. Теперь сервер отдаёт ровно скоуп.
   */
  const loadScope = useCallback(() => {
    if (scope === 'session' && sessionId) return load({ sessionId })
    if (scope === 'project' && projectId) return load({ projectId })
    return load()
  }, [load, projectId, scope, sessionId])

  // Список: первичная загрузка + перечитывание раз в 5 с, пока вкладка активна.
  useEffect(() => {
    let disposed = false
    const refresh = async () => {
      await loadScope()
      if (!disposed) setLoading(false)
    }
    void refresh()
    const timer = setInterval(() => {
      void loadScope()
    }, LIST_REFRESH_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [loadScope])

  // Тикер «время работы» для выполняющихся прогонов.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  /** Записи реестра в текущем скоупе. */
  const runs = useMemo(() => {
    const all = order
      .map((id) => byId[id])
      .filter((run): run is BackgroundRunRecord => !!run)
    if (scope === 'none') return []
    if (scope === 'session') return all.filter((run) => run.sessionId === sessionId)
    // Проектный скоуп: у прогона либо свой `projectId`, либо он принадлежит
    // сессии проекта (в live-событиях проекта нет — берём из списка сессий).
    return all.filter((run) => {
      if (run.projectId && run.projectId === projectId) return true
      const owner = run.sessionId
      return !!owner && sessionProjects.get(owner) === projectId
    })
  }, [byId, order, projectId, scope, sessionId, sessionProjects])

  const processRuns = useMemo(() => runs.filter((run) => run.kind === 'process'), [runs])
  const subagentRuns = useMemo(() => runs.filter((run) => run.kind === 'subagent'), [runs])

  /**
   * Блокирующие прогоны в текущем скоупе (ADR-111 §detach).
   *
   * У DTO нет `projectId`, поэтому проект берётся у сессии-владельца (как у
   * live-событий фонового реестра).
   */
  const blockingRuns = useMemo(() => {
    if (scope === 'none') return []
    if (scope === 'session') {
      return blocking.filter((run) => run.sessionId === sessionId)
    }
    return blocking.filter((run) => sessionProjects.get(run.sessionId) === projectId)
  }, [blocking, projectId, scope, sessionId, sessionProjects])

  const blockingSubagentRuns = useMemo(
    () => blockingRuns.filter((run) => run.kind === 'subagent'),
    [blockingRuns],
  )
  const blockingProcessRuns = useMemo(
    () => blockingRuns.filter((run) => run.kind === 'process'),
    [blockingRuns],
  )

  /** Открытие дочерней сессии саб-агента в центральной вкладке. */
  const handleOpenSession = useCallback((run: BackgroundRunRecord) => {
    const childId = run.childSessionId
    if (!childId) return
    useUIStore.getState().openTab({
      id: `chat-${childId}`,
      type: 'chat',
      title: sessionNames.get(childId) ?? run.description ?? childId,
      data: { sessionId: childId },
    })
  }, [sessionNames])

  /**
   * «Открыть» у блокирующего прогона: саб-агент — его дочерняя сессия,
   * процесс — вкладка live-лога.
   */
  const handleOpenBlocking = useCallback((run: BlockingRun) => {
    if (run.kind === 'subagent') {
      const childId = run.childSessionId
      if (!childId) return
      useUIStore.getState().openTab({
        id: `chat-${childId}`,
        type: 'chat',
        title: sessionNames.get(childId) ?? run.title ?? childId,
        data: { sessionId: childId },
      })
      return
    }
    openBlockingLogTab(run)
  }, [sessionNames])

  /** Остановка блокирующего прогона (правила доступа решает сервер). */
  const handleStopBlocking = useCallback(
    async (run: BlockingRun) => {
      const ok = await confirm({
        title: t('processes.confirm.stopTitle'),
        message: t('processes.confirm.stopMessage', { name: runTitle(run) }),
        confirmLabel: t('processes.action.stop'),
        variant: 'danger',
        icon: 'stop',
      })
      if (!ok) return
      setBusy(run.id)
      try {
        await synthApi.stopBlockingRun(run.id)
        notify({ text: t('processes.stopped'), type: 'success', category: 'system' })
        await loadScope()
      } catch (err) {
        notify({
          text: t('processes.failed', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setBusy(null)
      }
    },
    [loadScope, notify, t],
  )

  /** Перевод блокирующего прогона в фон (тост с количеством даёт общий шов). */
  const handleDetachBlocking = useCallback(
    async (run: BlockingRun) => {
      setBusy(run.id)
      try {
        await moveSessionToBackground(run.sessionId, { type: run.kind })
        await loadScope()
      } finally {
        setBusy(null)
      }
    },
    [loadScope],
  )

  /** Остановка фонового прогона (сервер останавливает асинхронно). */
  const handleStop = useCallback(
    async (run: BackgroundRunRecord) => {
      const ok = await confirm({
        title: t('processes.confirm.stopTitle'),
        message: t('processes.confirm.stopMessage', { name: runTitle(run) }),
        confirmLabel: t('processes.action.stop'),
        variant: 'danger',
        icon: 'stop',
      })
      if (!ok) return
      setBusy(run.id)
      try {
        await synthApi.stopProcess(run.id)
        notify({ text: t('processes.stopped'), type: 'success', category: 'system' })
        await loadScope()
      } catch (err) {
        notify({
          text: t('processes.failed', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setBusy(null)
      }
    },
    [loadScope, notify, t],
  )

  /**
   * ADR-126 §5: повторный запуск скриптового прогона.
   *
   * Аргументы не переиспользуются (в реестре их может не быть вовсе) —
   * повтор идёт без аргументов. Ошибка — тост, реестр не трогаем.
   */
  const handleRerunScript = useCallback(
    async (run: BackgroundRunRecord, name: string) => {
      setBusy(run.id)
      try {
        await synthApi.runSessionScript(run.sessionId, name)
        notify({ text: t('scripts.rerun.started'), type: 'success', category: 'system' })
        await loadScope()
      } catch (err) {
        notify({
          text: t('processes.failed', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setBusy(null)
      }
    },
    [loadScope, notify, t],
  )

  /**
   * PROP-142 §2: продолжить потерянный прогон саб-агента (`status='orphaned'`).
   *
   * Адресуется **дочерняя сессия** (`child_session_id`): сервер возобновляет
   * её (`POST /sessions/:id/resume-subagent`). У обычного шелл-процесса
   * дочерней сессии нет — действие только у прогонов-саб-агентов.
   */
  const handleResumeLost = useCallback(
    async (run: BackgroundRunRecord) => {
      const childId = run.childSessionId
      if (!childId) return
      setBusy(run.id)
      try {
        await synthApi.resumeSubagent(childId)
        notify({ text: t('processes.resumeLostDone'), type: 'success', category: 'system' })
        await loadScope()
      } catch (err) {
        notify({
          text: t('processes.resumeLostFailed', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setBusy(null)
      }
    },
    [loadScope, notify, t],
  )

  /** Удаление терминальной записи реестра. */
  const handleRemove = useCallback(
    async (run: BackgroundRunRecord) => {
      const ok = await confirm({
        title: t('processes.confirm.removeTitle'),
        message: t('processes.confirm.removeMessage', { name: runTitle(run) }),
        confirmLabel: t('processes.action.remove'),
        variant: 'danger',
        icon: 'delete-bin',
      })
      if (!ok) return
      setBusy(run.id)
      try {
        await synthApi.removeProcess(run.id)
        removeRun(run.id)
        notify({ text: t('processes.removed'), type: 'success', category: 'system' })
      } catch (err) {
        notify({
          text: t('processes.failed', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setBusy(null)
      }
    },
    [notify, removeRun, t],
  )

  // Без сессии и проекта показывать нечего.
  if (scope === 'none') {
    return (
      <PanelTab>
        <PanelSectionEmpty
          icon="terminal-box"
          title={t('processes.empty.noContext')}
          hint={t('processes.emptyHint.process')}
          testId="processes-no-context"
        />
      </PanelTab>
    )
  }

  const sessionOnly = scope === 'session'

  return (
    <PanelTab>
      {/* Фильтры вида + переключатель скоупа. Чипы переносятся внутри своей
          области, тумблер всегда прижат к правому краю строки фильтров. */}
      <div
        className="flex items-start gap-2"
        role="group"
        aria-label={t('processes.filter.title')}
        data-testid="processes-kind-filter"
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {KIND_FILTERS.map((filter) => (
            <Button
              key={filter}
              variant={kindFilter === filter ? 'primary' : 'outline-muted'}
              size="sm"
              aria-pressed={kindFilter === filter}
              onClick={() => setKindFilter(filter)}
              data-testid={`processes-filter-${filter}`}
            >
              {t(`processes.filter.${filter}`)}
            </Button>
          ))}
        </div>

        {/* Тумблер есть только у сессии проекта: без сессии скоуп всегда
            проектный, а без проекта расширять выборку нечем. */}
        {sessionId && projectId && (
          <span
            className="shrink-0 ml-auto flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="processes-whole-project"
          >
            {t('processes.filter.wholeProject')}
            <Toggle
              enabled={wholeProject}
              onToggle={() => setWholeProject((value) => !value)}
              ariaLabel={t('processes.filter.wholeProject')}
            />
          </span>
        )}
      </div>

      {loadError && (
        <div
          role="alert"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          data-testid="processes-error"
        >
          {t('processes.loadError', { error: loadError })}
        </div>
      )}

      {loading && runs.length === 0 && (
        <div
          role="status"
          className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground"
          data-testid="processes-loading"
        >
          <Icon name="loader-2" className="size-3.5 animate-spin" />
          {t('common.loading')}
        </div>
      )}

      {/* Блокирующие саб-агенты (ADR-111 §detach) — идут внутри хода. */}
      {(kindFilter === 'subagent' || kindFilter === 'all') && (
        <section className="space-y-2" data-testid="processes-section-blocking-subagent">
          <PanelSectionHeader
            title={t('processes.section.blockingSubagent')}
            count={t('processes.count.blockingSubagent', { count: blockingSubagentRuns.length })}
            testId="processes-section-blocking-subagent"
          />
          {blockingSubagentRuns.length === 0 ? (
            <PanelSectionEmpty
              icon="robot-2"
              title={t('processes.empty.blockingSubagent')}
              hint={t('processes.emptyHint.blockingSubagent')}
              testId="processes-empty-blocking-subagent"
            />
          ) : (
            <ul className="space-y-2 min-w-0" data-testid="processes-list-blocking-subagent">
              {blockingSubagentRuns.map((run) => (
                <BlockingRunCard
                  key={run.id}
                  run={run}
                  now={now}
                  busy={busy === run.id}
                  sessionName={sessionNames.get(run.sessionId) ?? run.sessionId}
                  onOpen={() => handleOpenBlocking(run)}
                  onStop={() => void handleStopBlocking(run)}
                  onDetach={() => void handleDetachBlocking(run)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Блокирующие процессы (ADR-111 §detach) — foreground `execute_shell`. */}
      {(kindFilter === 'process' || kindFilter === 'all') && (
        <section className="space-y-2" data-testid="processes-section-blocking-process">
          <PanelSectionHeader
            title={t('processes.section.blockingProcess')}
            count={t('processes.count.blockingProcess', { count: blockingProcessRuns.length })}
            testId="processes-section-blocking-process"
          />
          {blockingProcessRuns.length === 0 ? (
            <PanelSectionEmpty
              icon="terminal-box"
              title={t('processes.empty.blockingProcess')}
              hint={t('processes.emptyHint.blockingProcess')}
              testId="processes-empty-blocking-process"
            />
          ) : (
            <ul className="space-y-2 min-w-0" data-testid="processes-list-blocking-process">
              {blockingProcessRuns.map((run) => (
                <BlockingRunCard
                  key={run.id}
                  run={run}
                  now={now}
                  busy={busy === run.id}
                  sessionName={sessionNames.get(run.sessionId) ?? run.sessionId}
                  onOpen={() => handleOpenBlocking(run)}
                  onStop={() => void handleStopBlocking(run)}
                  onDetach={() => void handleDetachBlocking(run)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Секция терминалов — свой срез (серверный список проекта). */}
      {(kindFilter === 'terminal' || kindFilter === 'all') && (
        <TerminalsSection
          projectId={projectId}
          sessionId={sessionId}
          sessionOnly={sessionOnly}
        />
      )}

      {/* Фоновые процессы. */}
      {(kindFilter === 'process' || kindFilter === 'all') && (
        <section className="space-y-2" data-testid="processes-section-process">
          <PanelSectionHeader
            title={t('processes.title')}
            count={t('processes.count.process', { count: processRuns.length })}
            testId="processes-section-process"
          />
          {processRuns.length === 0 ? (
            <PanelSectionEmpty
              icon="terminal-box"
              title={t('processes.empty.process')}
              hint={t('processes.emptyHint.process')}
              testId="processes-empty-process"
            />
          ) : (
            <ul className="space-y-2 min-w-0" data-testid="processes-list-process">
              {processRuns.map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  now={now}
                  busy={busy === run.id}
                  sessionName={sessionNames.get(run.sessionId) ?? run.sessionId}
                  onOutput={() => openProcessLogTab(run)}
                  onStop={() => void handleStop(run)}
                  onRerun={(script) => void handleRerunScript(run, script)}
                  onRemove={() => void handleRemove(run)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Фоновые саб-агенты. */}
      {(kindFilter === 'subagent' || kindFilter === 'all') && (
        <section className="space-y-2" data-testid="processes-section-subagent">
          <PanelSectionHeader
            title={t('processes.section.subagent')}
            count={t('processes.count.subagent', { count: subagentRuns.length })}
            testId="processes-section-subagent"
          />
          {subagentRuns.length === 0 ? (
            <PanelSectionEmpty
              icon="robot-2"
              title={t('processes.empty.subagent')}
              hint={t('processes.emptyHint.subagent')}
              testId="processes-empty-subagent"
            />
          ) : (
            <ul className="space-y-2 min-w-0" data-testid="processes-list-subagent">
              {subagentRuns.map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  now={now}
                  busy={busy === run.id}
                  sessionName={sessionNames.get(run.sessionId) ?? run.sessionId}
                  onOpenSession={() => handleOpenSession(run)}
                  onResume={run.status === 'orphaned' && run.childSessionId ? () => void handleResumeLost(run) : undefined}
                  onStop={() => void handleStop(run)}
                  onRerun={(script) => void handleRerunScript(run, script)}
                  onRemove={() => void handleRemove(run)}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </PanelTab>
  )
}

interface RunCardProps {
  /** Запись реестра фоновой работы. */
  run: BackgroundRunRecord
  /** Текущее время (тикер раз в секунду). */
  now: number
  /** Идёт ли операция над записью (кнопки заблокированы). */
  busy: boolean
  /** Имя сессии-владельца (для строки «Сессия»). */
  sessionName: string
  /** Открыть экран вывода (только для процесса). */
  onOutput?: () => void
  /** Открыть дочернюю сессию (только для саб-агента). */
  onOpenSession?: () => void
  /** Продолжить потерянный прогон саб-агента (`status='orphaned'`). */
  onResume?: () => void
  /** Остановить прогон. */
  onStop: () => void
  /** Запустить скрипт снова. */
  onRerun: (script: string) => void
  /** Удалить запись реестра. */
  onRemove: () => void
}

/**
 * Карточка фонового прогона — та же форма, что у терминала: шапка (вид,
 * имя, статус, скрипт), строки-подробности и действия внизу справа.
 */
function RunCard({
  run,
  now,
  busy,
  sessionName,
  onOutput,
  onOpenSession,
  onResume,
  onStop,
  onRerun,
  onRemove,
}: RunCardProps) {
  const { t, locale } = useI18n()
  const isRunning = run.status === 'running'
  const script = scriptName(run)
  const uptimeMs = runUptimeMs(run, now)

  return (
    <li
      data-testid={`processes-item-${run.id}`}
      data-kind={run.kind}
      data-status={run.status}
      className="min-w-0 space-y-2 rounded-lg border border-border bg-surface-inset p-3"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon name={kindIcon(run.kind)} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={runTitle(run)}>
          {runTitle(run)}
        </span>
        {script && (
          <span
            className={cn(BADGE, 'bg-status-caution/15 text-status-caution')}
            data-testid={`processes-script-${run.id}`}
          >
            {t('scripts.process.badge', { name: script })}
          </span>
        )}
        <span
          className={cn(BADGE, STATUS_CLASS[run.status] ?? 'bg-muted text-muted-foreground')}
          data-testid={`processes-status-${run.id}`}
        >
          {isRunning && <Icon name="loader-2" className="mr-1 inline size-3 animate-spin" />}
          {t(`processes.status.${run.status}`)}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-muted-foreground min-w-0">
        {run.kind === 'process' && run.cwd && (
          <Row label={t('processes.row.cwd')} value={run.cwd} mono />
        )}
        {run.kind === 'subagent' && run.agentRole && (
          <Row label={t('processes.row.agent')} value={run.agentRole} />
        )}
        <Row label={t('processes.row.session')} value={sessionName} mono />
        {uptimeMs !== undefined && (
          <Row label={t('processes.row.uptime')} value={formatDuration(uptimeMs)} />
        )}
        {!isRunning && run.finishedAt && (
          <Row label={t('processes.row.finished')} value={formatDateTime(run.finishedAt, locale)} />
        )}
        {!isRunning && run.exitCode !== undefined && (
          <Row label={t('processes.row.exitCode')} value={String(run.exitCode)} mono />
        )}
        {!isRunning && run.signal && (
          <Row label={t('processes.row.signal')} value={run.signal} mono />
        )}
      </dl>

      {run.summary && (
        <p
          className="break-words text-xs text-muted-foreground"
          data-testid={`processes-summary-${run.id}`}
        >
          {run.summary}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-1">
        {isRunning && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onStop}
            disabled={busy}
            title={t('processes.action.stop')}
            aria-label={t('processes.action.stop')}
            data-testid={`processes-stop-${run.id}`}
          >
            <Icon name="stop" className="size-4" />
          </Button>
        )}
        {run.kind === 'subagent' && run.childSessionId && onOpenSession && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenSession}
            title={t('processes.action.openSession')}
            aria-label={t('processes.action.openSession')}
            data-testid={`processes-open-${run.id}`}
          >
            <Icon name="arrow-right-s" className="size-4" />
          </Button>
        )}
        {onResume && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onResume}
            disabled={busy}
            title={t('processes.resumeLost')}
            aria-label={t('processes.resumeLost')}
            data-testid={`processes-resume-${run.id}`}
          >
            <Icon name="refresh" className="size-4" />
          </Button>
        )}
        {run.kind === 'process' && onOutput && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOutput}
            title={t('processes.action.output')}
            aria-label={t('processes.action.output')}
            data-testid={`processes-output-${run.id}`}
          >
            <Icon name="eye" className="size-4" />
          </Button>
        )}
        {script && run.sessionId && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onRerun(script)}
            disabled={busy}
            title={t('scripts.process.rerun')}
            aria-label={t('scripts.process.rerun')}
            data-testid={`processes-rerun-${run.id}`}
          >
            <Icon name="refresh" className="size-4" />
          </Button>
        )}
        {!isRunning && (
          <Button
            variant="ghost"
            size="icon"
            className="hover:text-destructive"
            onClick={onRemove}
            disabled={busy}
            title={t('processes.action.remove')}
            aria-label={t('processes.action.remove')}
            data-testid={`processes-remove-${run.id}`}
          >
            <Icon name="delete-bin" className="size-4" />
          </Button>
        )}
      </div>
    </li>
  )
}

/** Строка «лейбл — значение» в карточке прогона. */
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
