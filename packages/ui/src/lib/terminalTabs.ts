// terminalTabs: открытие вкладки терминала в центральной области (PROP-132).
//
// Единая точка сборки `CenterTab` типа `terminal` — иначе разные места
// открывали бы вкладку с разными id/заголовками (а `openTab` по id переиспользует
// существующую вкладку).

import { useUIStore } from '@/stores/useUIStore'

/** Минимальный снимок терминала, нужный для открытия вкладки. */
export interface TerminalTabTarget {
  id: string
  title?: string | null
  shell?: string | null
  projectId?: string | null
}

/** Заголовок вкладки терминала: имя терминала → оболочка → id. */
export function terminalTabTitle(terminal: TerminalTabTarget): string {
  return terminal.title || terminal.shell || terminal.id
}

/** Открыть (или переключиться на) вкладку терминала. */
export function openTerminalTab(terminal: TerminalTabTarget): void {
  if (!terminal.id) return
  useUIStore.getState().openTab({
    id: `terminal-${terminal.id}`,
    type: 'terminal',
    title: terminalTabTitle(terminal),
    data: {
      terminalId: terminal.id,
      ...(terminal.projectId ? { projectId: terminal.projectId } : {}),
    },
  })
}
