import { useMemo } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'

/** Источник активного проекта: активная сессия, файловая или commit-вкладка. */
export type ActiveProjectSource = 'session' | 'file' | 'commit' | null

export interface ActiveProjectInfo {
  projectId: string | null
  source: ActiveProjectSource
  sessionId: string | null
}

/**
 * Проект, к которому привязан активный центр-таб (вариант C левой панели):
 * chat → project_id сессии (fallback на `tab.data.projectId`, пока сессии не догружены),
 * file-viewer/file-editor → projectId вкладки, commit-detail → projectId вкладки.
 * Нет активной вкладки/нерелевантный тип → source null.
 */
export function useActiveProject(): ActiveProjectInfo {
  const activeCenterTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const sessions = useSessionsStore((s) => s.sessions)

  return useMemo(() => {
    const tab = (centerTabs ?? []).find((t) => t.id === activeCenterTabId)
    if (!tab) return { projectId: null, source: null, sessionId: null }

    if (tab.type === 'chat') {
      const sessionId = tab.data?.sessionId ?? null
      const session = sessionId ? sessions.find((s) => s.id === sessionId) : undefined
      // source 'session' — даже если project_id null (инфо-строка «нет проекта»).
      const projectId = session ? (session.project_id ?? null) : (tab.data?.projectId ?? null)
      return { projectId, source: 'session', sessionId }
    }

    if (tab.type === 'file-viewer' || tab.type === 'file-editor') {
      return { projectId: tab.data?.projectId ?? null, source: 'file', sessionId: null }
    }

    if (tab.type === 'commit-detail') {
      return { projectId: tab.data?.projectId ?? null, source: 'commit', sessionId: null }
    }

    return { projectId: null, source: null, sessionId: null }
  }, [activeCenterTabId, centerTabs, sessions])
}
