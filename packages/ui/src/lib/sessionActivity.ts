// sessionActivity: подсчёт активной фоновой работы по сессиям.
//
// Источники — реестр фоновых прогонов (`stores/processesStore.ts`) и реестр
// терминалов (`stores/terminalsStore.ts`). Учитывается **только активное**:
//   - фоновые процессы  — `kind === 'process'` и `status === 'running'`;
//   - фоновые саб-агенты — `kind === 'subagent'` и `status === 'running'`
//     (сессия прогона — родитель, в чьей сессии он живёт);
//   - терминалы          — `status !== 'exited'` (живые), с привязкой к сессии.
//
// Функция чистая: ни сторов, ни API — только входные записи. Её использует
// дерево сессий (значки фоновой активности) и тесты.

import type { BackgroundRunRecord } from '@/lib/api/synthApi'
import type { TerminalDto } from '@/lib/api/terminals'

/** Счётчики активной фоновой работы одной сессии. */
export interface SessionActivityCounts {
  /** Выполняющихся фоновых процессов. */
  processes: number
  /** Выполняющихся фоновых саб-агентов. */
  subagents: number
  /** Живых терминалов, привязанных к сессии. */
  terminals: number
}

/**
 * Считает активную фоновую работу по сессиям.
 *
 * Терминальные прогоны (`completed`/`failed`/`cancelled`/`orphaned`) и
 * завершённые терминалы (`exited`) не считаются: индикатор показывает
 * только то, что идёт **сейчас**. Записи без сессии-владельца пропускаются.
 */
export function countSessionActivity(
  runs: readonly BackgroundRunRecord[],
  terminals: readonly TerminalDto[],
): Map<string, SessionActivityCounts> {
  const counts = new Map<string, SessionActivityCounts>()

  const bump = (sessionId: string, key: keyof SessionActivityCounts): void => {
    let entry = counts.get(sessionId)
    if (!entry) {
      entry = { processes: 0, subagents: 0, terminals: 0 }
      counts.set(sessionId, entry)
    }
    entry[key] += 1
  }

  for (const run of runs) {
    if (run.status !== 'running') continue
    if (!run.sessionId) continue
    if (run.kind === 'process') bump(run.sessionId, 'processes')
    else if (run.kind === 'subagent') bump(run.sessionId, 'subagents')
  }

  for (const terminal of terminals) {
    if (terminal.status === 'exited') continue
    if (!terminal.sessionId) continue
    bump(terminal.sessionId, 'terminals')
  }

  return counts
}
