// TerminalSessionView: вкладка терминалов сессии (PROP-132).
//
// Одна вкладка на сессию: заголовок вкладки — заголовок сессии, внутри —
// переключатель по всем терминалам сессии (порядок — по созданию) и активный
// терминал (`TerminalView`).
//
// В переключателе есть и **завершённые** терминалы (в т.ч. восстановленные
// после рестарта ядра): у них статус «завершён», а `TerminalView` показывает
// сохранённый вывод и кнопку «Восстановить терминал».
// Активный терминал хранится в `tab.data.terminalId` — он переживает
// переключение вкладок и перезагрузку страницы (вкладки персистятся).
// Терминалы сессии — источник истины из `terminalsStore` (реестр + live-события
// `terminal.*`).

import React, { useCallback, useEffect, useMemo } from 'react'

import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon/Icon'
import { useNotification } from '@/hooks/useNotification'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { useTerminalsStore } from '@/stores/terminalsStore'
import { TerminalView } from './TerminalView'

export interface TerminalSessionViewProps {
  tab: CenterTab
}

/** Цвет точки статуса терминала. */
const STATUS_DOT_CLASS: Record<string, string> = {
  starting: 'bg-primary',
  running: 'bg-status-success',
  closing: 'bg-status-warning',
  exited: 'bg-muted-foreground/60',
}

/** Имя терминала в переключателе: заголовок → оболочка → id. */
function terminalLabel(terminal: { title?: string | null; shell?: string | null; id: string }): string {
  return terminal.title || terminal.shell || terminal.id
}

export function TerminalSessionView({ tab }: TerminalSessionViewProps) {
  const { t } = useI18n()
  const { notify } = useNotification()

  const sessionId = tab.data.sessionId
  const terminalsById = useTerminalsStore((s) => s.terminalsById)
  const order = useTerminalsStore((s) => s.order)
  const loadTerminals = useTerminalsStore((s) => s.load)
  const createTerminal = useTerminalsStore((s) => s.create)

  // Терминалы сессии — по созданию (старые сверху, как их открывали).
  const terminals = useMemo(() => {
    if (!sessionId) return []
    return order
      .map((id) => terminalsById[id])
      .filter((terminal): terminal is NonNullable<typeof terminal> => !!terminal)
      .filter((terminal) => terminal.sessionId === sessionId)
      .sort((a, b) => {
        const left = a.createdAt || 0
        const right = b.createdAt || 0
        if (left === right) return a.id < b.id ? -1 : 1
        return left - right
      })
  }, [order, sessionId, terminalsById])

  // Реестр терминалов сессии — источник истины (live-события + снимок).
  // `includeExited` — вместе с завершёнными: восстановленный после рестарта
  // ядра терминал иначе не попал бы в переключатель (сервер по умолчанию
  // отдаёт только живые).
  useEffect(() => {
    if (!sessionId) return
    void loadTerminals({ sessionId, includeExited: true })
  }, [loadTerminals, sessionId])

  const activeTerminalId = tab.data.terminalId
  const activeTerminal = useMemo(
    () =>
      terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0] ?? undefined,
    [activeTerminalId, terminals],
  )

  /** Переключение активного терминала (запоминается в данных вкладки). */
  const handleSelect = useCallback(
    (terminalId: string) => {
      useUIStore.getState().updateTabData(tab.id, { terminalId })
    },
    [tab.id],
  )

  /** Создать ещё один терминал сессии и сделать его активным. */
  const handleCreate = useCallback(async () => {
    const projectId =
      tab.data.projectId ?? activeTerminal?.projectId ?? terminals[0]?.projectId ?? ''
    if (!projectId) {
      notify({
        text: t('terminal.create.noProject'),
        type: 'error',
        category: 'error',
      })
      return
    }
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
    handleSelect(created.id)
  }, [activeTerminal?.projectId, createTerminal, handleSelect, notify, sessionId, t, tab.data.projectId, terminals])

  /**
   * Терминала больше нет на сервере: убираем его из реестра — переключатель
   * возьмёт следующий (вкладка сессии остаётся открытой).
   */
  const handleTerminalMissing = useCallback((missingId: string) => {
    useTerminalsStore.getState().applyEvent('terminal.deleted', { terminal_id: missingId })
  }, [])

  if (!activeTerminal) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background p-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Icon name="terminal-box" className="size-8 text-muted-foreground" />
          <p className="text-sm text-foreground">{t('terminal.session.empty')}</p>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            onClick={() => void handleCreate()}
            data-testid="terminal-session-create-empty"
          >
            {t('terminal.session.create')}
          </button>
        </div>
      </div>
    )
  }

  // Активному терминалу — отдельная вкладка: id вкладки-сессии остаётся
  // общим, но `terminalId` в данных указывает на выбранный терминал.
  const activeTab: CenterTab = {
    ...tab,
    data: { ...tab.data, terminalId: activeTerminal.id },
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-background">
      {/* Переключатель терминалов сессии. */}
      <div
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1"
        data-testid="terminal-session-tabs"
      >
        {terminals.map((terminal) => {
          const isActive = terminal.id === activeTerminal.id
          const finished = terminal.status === 'exited'
          return (
            <button
              key={terminal.id}
              type="button"
              onClick={() => handleSelect(terminal.id)}
              aria-current={isActive ? 'true' : undefined}
              // Завершённый терминал (в т.ч. восстановленный) помечен
              // статусом — иначе он неотличим от живого.
              title={
                finished
                  ? `${terminalLabel(terminal)} — ${t('terminal.status.exited')}`
                  : terminalLabel(terminal)
              }
              data-testid={`terminal-session-tab-${terminal.id}`}
              data-active={isActive ? 'true' : undefined}
              data-status={terminal.status}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                isActive
                  ? 'bg-interactive-selection text-interactive-selection-foreground'
                  : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
              )}
            >
              <span
                aria-hidden
                data-testid={`terminal-session-dot-${terminal.id}`}
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  STATUS_DOT_CLASS[terminal.status] ?? 'bg-muted-foreground/60',
                )}
              />
              <span className="max-w-[10rem] truncate">{terminalLabel(terminal)}</span>
              {finished && (
                <span
                  className="shrink-0 text-[0.625rem] opacity-80"
                  data-testid={`terminal-session-status-${terminal.id}`}
                >
                  {t('terminal.status.exited')}
                </span>
              )}
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => void handleCreate()}
          title={t('terminal.session.createAnother')}
          aria-label={t('terminal.session.createAnother')}
          data-testid="terminal-session-create"
          className="ml-auto shrink-0 rounded-md p-1 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        >
          <Icon name="add" className="size-3.5" />
        </button>
      </div>

      <TerminalView tab={activeTab} onTerminalMissing={handleTerminalMissing} />
    </div>
  )
}
