// useTerminalLauncher: переход «сессия ↔ терминал» (PROP-132, Ф4б).
//
// Единая точка для обоих направлений:
//   - открыть **вкладку сессии** с переключателем терминалов (существующих —
//     в т.ч. завершённых/восстановленных, — или вновь созданного);
//   - создать ещё один терминал сессии.
//
// Новый терминал создаётся **только если терминалов нет вовсе**: завершённый
// (восстановленный после рестарта ядра) — это терминал, его открывают и
// восстанавливают, а не заменяют новым.
//
// Источник истины — сервер: `GET /terminals?session_id=…&include_exited=true`
// (первичная выборка) плюс события `terminal.*` (живое обновление без опроса).

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { openSessionTerminalTab } from '@/lib/terminalTabs'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useTerminalsStore } from '@/stores/terminalsStore'
import type { TerminalDto } from '@/lib/api/terminals'

export interface TerminalLauncher {
  /** Живой терминал, привязанный к сессии (если есть). */
  liveTerminal: TerminalDto | undefined
  /** Все терминалы сессии (включая завершённые) — по созданию. */
  sessionTerminals: TerminalDto[]
  /** Есть ли у сессии хоть один терминал (любой статус). */
  hasTerminal: boolean
  /** Открыть вкладку терминалов сессии: существующего — или вновь созданного. */
  open: () => Promise<void>
  /** Создать ещё один терминал сессии и открыть его. */
  createAnother: () => Promise<void>
  /** Идёт создание терминала. */
  busy: boolean
}

export function useTerminalLauncher(
  sessionId: string | undefined,
  projectId: string | undefined,
): TerminalLauncher {
  const { t } = useI18n()
  const { notify } = useNotification()

  const terminalsById = useTerminalsStore((s) => s.terminalsById)
  const order = useTerminalsStore((s) => s.order)
  const loadTerminals = useTerminalsStore((s) => s.load)
  const createTerminal = useTerminalsStore((s) => s.create)
  const sessions = useSessionsStore((s) => s.sessions)
  const [busy, setBusy] = useState(false)

  // Первичная выборка терминалов сессии; дальше — live-события `terminal.*`.
  // `includeExited` — вместе с завершёнными: терминал, восстановленный после
  // рестарта ядра, иначе не виден (сервер по умолчанию отдаёт живые).
  useEffect(() => {
    if (!sessionId) return
    void loadTerminals({ sessionId, includeExited: true })
  }, [sessionId, loadTerminals])

  // Терминалы сессии — по созданию (порядок в переключателе вкладки).
  const sessionTerminals = useMemo(() => {
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

  const liveTerminal = useMemo(
    () => sessionTerminals.find((terminal) => terminal.status !== 'exited'),
    [sessionTerminals],
  )

  // Заголовок сессии — он же заголовок вкладки терминалов.
  const sessionTitle = useMemo(() => {
    if (!sessionId) return ''
    const session = sessions.find((item) => item.id === sessionId)
    return session?.name || sessionId
  }, [sessionId, sessions])

  const open = useCallback(async () => {
    if (!sessionId) return
    // Терминалов нет **вовсе** — сначала создаём один, потом открываем вкладку.
    // Завершённые (в т.ч. восстановленные после рестарта ядра) — это терминалы:
    // открываем вкладку-сессию (там кнопка «Восстановить»), новый не создаём.
    if (!sessionTerminals.length) {
      if (!projectId) {
        notify({
          text: t('terminal.create.noProject'),
          type: 'error',
          category: 'error',
        })
        return
      }
      setBusy(true)
      try {
        const created = await createTerminal({ projectId, sessionId })
        if (!created) {
          notify({
            text: t('terminal.create.failed'),
            type: 'error',
            category: 'error',
          })
          return
        }
        openSessionTerminalTab({
          sessionId,
          sessionTitle,
          projectId,
          terminalId: created.id,
        })
      } finally {
        setBusy(false)
      }
      return
    }
    openSessionTerminalTab({
      sessionId,
      sessionTitle,
      projectId,
      // Активный терминал вкладки: живой — если есть, иначе первый
      // завершённый (восстановленный) — его и нужно показать.
      terminalId: (liveTerminal ?? sessionTerminals[0])?.id,
    })
  }, [
    createTerminal,
    liveTerminal,
    notify,
    projectId,
    sessionId,
    sessionTerminals,
    sessionTitle,
    t,
  ])

  /** Ещё один терминал сессии (вкладка открывается на нём). */
  const createAnother = useCallback(async () => {
    if (!sessionId) return
    if (!projectId) {
      notify({
        text: t('terminal.create.noProject'),
        type: 'error',
        category: 'error',
      })
      return
    }
    setBusy(true)
    try {
      const created = await createTerminal({ projectId, sessionId })
      if (!created) {
        notify({
          text: t('terminal.create.failed'),
          type: 'error',
          category: 'error',
        })
        return
      }
      openSessionTerminalTab({
        sessionId,
        sessionTitle,
        projectId,
        terminalId: created.id,
      })
    } finally {
      setBusy(false)
    }
  }, [createTerminal, notify, projectId, sessionId, sessionTitle, t])

  return {
    liveTerminal,
    sessionTerminals,
    hasTerminal: sessionTerminals.length > 0,
    open,
    createAnother,
    busy,
  }
}
