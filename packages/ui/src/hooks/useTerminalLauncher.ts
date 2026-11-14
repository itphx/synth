// useTerminalLauncher: переход «сессия ↔ терминал» (PROP-132, Ф4б).
//
// Единая точка для обоих направлений:
//   - найти **живой** привязанный терминал сессии (реестр терминалов + live-
//     события `terminal.*`), открыть его вкладку;
//   - если живого терминала нет — создать (`POST /terminals` с `project_id` и
//     `session_id`) и открыть.
//
// Источник истины — сервер: `GET /terminals?session_id=…` (первичная выборка)
// плюс события `terminal.*` (живое обновление без опроса).

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { openTerminalTab } from '@/lib/terminalTabs'
import { useTerminalsStore } from '@/stores/terminalsStore'
import type { TerminalDto } from '@/lib/api/terminals'

export interface TerminalLauncher {
  /** Живой терминал, привязанный к сессии (если есть). */
  liveTerminal: TerminalDto | undefined
  /** Открыть вкладку терминала: существующего — или вновь созданного. */
  open: () => Promise<void>
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
  const [busy, setBusy] = useState(false)

  // Первичная выборка терминалов сессии; дальше — live-события `terminal.*`.
  useEffect(() => {
    if (!sessionId) return
    void loadTerminals({ sessionId })
  }, [sessionId, loadTerminals])

  const liveTerminal = useMemo(() => {
    if (!sessionId) return undefined
    for (const id of order) {
      const terminal = terminalsById[id]
      if (!terminal) continue
      if (terminal.sessionId !== sessionId) continue
      if (terminal.status === 'exited') continue
      return terminal
    }
    return undefined
  }, [order, terminalsById, sessionId])

  const open = useCallback(async () => {
    if (liveTerminal) {
      openTerminalTab(liveTerminal)
      return
    }
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
      setBusy(false)
    }
  }, [createTerminal, liveTerminal, notify, projectId, sessionId, t])

  return { liveTerminal, open, busy }
}
