import { useMemo } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'

/**
 * Источник активного проекта: выделенный проект, активная сессия, терминал,
 * файловая или commit-вкладка.
 */
export type ActiveProjectSource = 'session' | 'file' | 'commit' | 'project' | null

export interface ActiveProjectInfo {
  projectId: string | null
  source: ActiveProjectSource
  sessionId: string | null
}

/**
 * Проект, к которому привязан активный контекст (вариант C левой панели):
 * выделенный проект → активная сессия/терминал → файловая/commit-вкладка.
 *
 * Выделенный проект (`useUIStore.selectedProjectId`) имеет приоритет над
 * активным центр-табом: клик по проекту в дереве переключает панели на
 * проектный контекст. Сессии у выделенного проекта нет (`sessionId: null`).
 *
 * chat → project_id сессии (fallback на `tab.data.projectId`, пока сессии не догружены),
 * terminal → projectId/sessionId вкладки (терминал привязан к сессии и проекту),
 * file-viewer/file-editor → projectId вкладки, commit-detail → projectId вкладки.
 * Нет активной вкладки/нерелевантный тип → source null.
 */
export function useActiveProject(): ActiveProjectInfo {
  const activeCenterTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const selectedProjectId = useUIStore((s) => s.selectedProjectId)
  const sessions = useSessionsStore((s) => s.sessions)
  const projects = useProjectsStore((s) => s.projects)

  return useMemo(() => {
    // Выделенный проект — приоритет над активным центр-табом.
    if (selectedProjectId) {
      const known =
        projects.some((p) => p.id === selectedProjectId) ||
        // Список проектов ещё не загружен — признак проекта берём из сессий.
        (projects.length === 0 && sessions.some((s) => s.project_id === selectedProjectId))
      if (known) {
        return { projectId: selectedProjectId, source: 'project', sessionId: null }
      }
    }

    const tab = (centerTabs ?? []).find((t) => t.id === activeCenterTabId)
    if (!tab) return { projectId: null, source: null, sessionId: null }

    if (tab.type === 'chat') {
      const sessionId = tab.data?.sessionId ?? null
      const session = sessionId ? sessions.find((s) => s.id === sessionId) : undefined
      // source 'session' — даже если project_id null (инфо-строка «нет проекта»).
      const projectId = session ? (session.project_id ?? null) : (tab.data?.projectId ?? null)
      return { projectId, source: 'session', sessionId }
    }

    // PROP-132: вкладка терминала — проект и сессия терминала лежат в данных
    // вкладки (терминал привязан к сессии и к её проекту). Без этой ветки
    // панель «Процессы» не видела терминалы при активной вкладке терминала
    // (projectId/sessionId были null).
    if (tab.type === 'terminal') {
      return {
        projectId: tab.data?.projectId ?? null,
        source: 'session',
        sessionId: tab.data?.sessionId ?? null,
      }
    }

    // Экран «Вывод процесса»: прогон живёт в сессии и её проекте — вкладка
    // несёт их id (см. `lib/processTabs.ts`). Без этой ветки панель
    // «Процессы» на экране вывода не знала бы свой скоуп.
    if (tab.type === 'process-log') {
      return {
        projectId: tab.data?.projectId ?? null,
        source: 'session',
        sessionId: tab.data?.sessionId ?? null,
      }
    }

    if (tab.type === 'file-viewer' || tab.type === 'file-editor') {
      return { projectId: tab.data?.projectId ?? null, source: 'file', sessionId: null }
    }

    if (tab.type === 'commit-detail') {
      return { projectId: tab.data?.projectId ?? null, source: 'commit', sessionId: null }
    }

    return { projectId: null, source: null, sessionId: null }
  }, [activeCenterTabId, centerTabs, sessions, selectedProjectId, projects])
}
