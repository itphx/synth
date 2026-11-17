// sessionActivity: подсчёт активной фоновой работы по сессиям.
//
// Источники — реестр фоновых прогонов (`stores/processesStore.ts`), реестр
// терминалов (`stores/terminalsStore.ts`) и реестр таймеров/будильников
// (`stores/timersStore.ts`). Учитывается **только активное**:
//   - фоновые процессы  — `kind === 'process'` и `status === 'running'`;
//   - фоновые саб-агенты — `kind === 'subagent'` и `status === 'running'`
//     (сессия прогона — родитель, в чьей сессии он живёт);
//   - терминалы          — `status !== 'exited'` (живые), с привязкой к сессии;
//   - таймеры/будильники — `status === 'active'` (ждут срабатывания), по виду
//     (`kind`): `timer` — относительный отсчёт, `alarm` — будильник.
//
// Функция чистая: ни сторов, ни API — только входные записи. Её использует
// дерево сессий (значки фоновой активности) и тесты.

import type { BackgroundRunRecord, Timer } from '@/lib/api/synthApi'
import type { TerminalDto } from '@/lib/api/terminals'

/** Счётчики активной фоновой работы одной сессии. */
export interface SessionActivityCounts {
  /** Выполняющихся фоновых процессов. */
  processes: number
  /** Выполняющихся фоновых саб-агентов. */
  subagents: number
  /** Живых терминалов, привязанных к сессии. */
  terminals: number
  /** Активных таймеров (отложенный возврат к работе). */
  timers: number
  /** Активных будильников (абсолютное время/повтор). */
  alarms: number
}

/**
 * Считает активную фоновую работу по сессиям.
 *
 * Терминальные прогоны (`completed`/`failed`/`cancelled`/`orphaned`) и
 * завершённые терминалы (`exited`) не считаются: индикатор показывает
 * только то, что идёт **сейчас**. Таймеры считаются только в статусе
 * `active`: `paused` не сработает, `fired`/`cancelled` — терминальные.
 * Записи без сессии-владельца пропускаются.
 *
 * Третий аргумент (таймеры) необязателен — вызов без него сохраняет
 * прежнее поведение (счётчики таймеров и будильников нулевые).
 */
export function countSessionActivity(
  runs: readonly BackgroundRunRecord[],
  terminals: readonly TerminalDto[],
  timers?: readonly Timer[],
): Map<string, SessionActivityCounts> {
  const counts = new Map<string, SessionActivityCounts>()

  const bump = (sessionId: string, key: keyof SessionActivityCounts): void => {
    let entry = counts.get(sessionId)
    if (!entry) {
      entry = { processes: 0, subagents: 0, terminals: 0, timers: 0, alarms: 0 }
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

  for (const timer of timers ?? []) {
    if (timer.status !== 'active') continue
    if (!timer.sessionId) continue
    bump(timer.sessionId, timer.kind === 'alarm' ? 'alarms' : 'timers')
  }

  return counts
}
