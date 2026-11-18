// processTabs: открытие вкладки «Вывод процесса» в центральной области.
//
// Единая точка сборки `CenterTab` типа `process-log` — иначе разные места
// открывали бы вкладку с разными id/заголовками (а `openTab` по id переиспользует
// существующую вкладку).
//
// Вкладка **per-run**: один прогон — одна вкладка (`process-<runId>`), внутри
// переключаются потоки вывода (`combined`/`stdout`/`stderr`).

import { useUIStore } from '@/stores/useUIStore'
import type { BlockingRun } from '@/lib/api/synthApi'

/** Минимальный снимок фонового прогона, нужный для открытия вкладки. */
export interface ProcessLogTabTarget {
  /** id прогона (`bgr_<uuid>`). */
  id: string
  /** Команда прогона (`kind: 'process'`) — заголовок вкладки. */
  command?: string | null
  /** Описание прогона (`kind: 'subagent'`) — запасной заголовок. */
  description?: string | null
  /** Сессия-владелец прогона. */
  sessionId?: string | null
  /** Проект сессии-владельца. */
  projectId?: string | null
}

/** Заголовок вкладки вывода: команда → описание → id. */
export function processLogTabTitle(run: ProcessLogTabTarget): string {
  return run.command || run.description || run.id
}

/** Открыть (или переключиться на) вкладку вывода фонового прогона. */
export function openProcessLogTab(run: ProcessLogTabTarget): void {
  if (!run.id) return
  useUIStore.getState().openTab({
    id: `process-${run.id}`,
    type: 'process-log',
    title: processLogTabTitle(run),
    data: {
      processRunId: run.id,
      ...(run.projectId ? { projectId: run.projectId } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    },
  })
}

/** Заголовок вкладки live-лога блокирующего прогона: имя → id. */
export function blockingLogTabTitle(run: Pick<BlockingRun, 'id' | 'title'>): string {
  return run.title || run.id
}

/**
 * Открыть (или переключиться на) вкладку **live-лога** блокирующего прогона
 * (ADR-111 §detach).
 *
 * Вкладка отличается от `process-log` источником: у блокирующего прогона нет
 * записи реестра, лог читается `GET /processes/blocking/:id/logs` и
 * догружается по смещению, пока прогон идёт. id вкладки — свой префикс
 * (`blocking-`), чтобы не столкнуться с вкладкой фонового прогона.
 */
export function openBlockingLogTab(run: BlockingRun): void {
  if (!run.id) return
  useUIStore.getState().openTab({
    id: `blocking-${run.id}`,
    type: 'process-log',
    title: blockingLogTabTitle(run),
    data: {
      blockingRunId: run.id,
      ...(run.title ? { blockingRunTitle: run.title } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    },
  })
}
