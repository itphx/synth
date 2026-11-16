// terminalTabs: открытие вкладки терминала в центральной области (PROP-132).
//
// Единая точка сборки `CenterTab` типа `terminal` — иначе разные места
// открывали бы вкладку с разными id/заголовками (а `openTab` по id переиспользует
// существующую вкладку).
//
// Два вида вкладок терминала:
// - `openTerminalTab` — одиночная вкладка терминала (карточки панели
//   «Процессы»); если терминал привязан к сессии, вкладка несёт её id —
//   тогда внутри показывается переключатель терминалов сессии;
// - `openSessionTerminalTab` — вкладка **сессии**: заголовок вкладки = заголовок
//   сессии, внутри — переключатель по всем терминалам сессии.
//
// Заголовок вкладки терминала — **всегда имя сессии** (и ручной терминал, и
// вкладка-сессия), в том числе после переименования сессии: заголовок
// синхронизируется из списка сессий (`syncTerminalTabTitle`).

import { terminalsApi, terminalApiErrorStatus } from '@/lib/api/terminals'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'

/** Минимальный снимок терминала, нужный для открытия вкладки. */
export interface TerminalTabTarget {
  id: string
  title?: string | null
  shell?: string | null
  projectId?: string | null
  /**
   * Сессия, к которой терминал привязан (необязательно).
   *
   * Кладётся в данные вкладки: по нему панель «Процессы» понимает, чей это
   * терминал (фильтр «только текущая сессия»), а вкладка показывает
   * переключатель терминалов сессии.
   */
  sessionId?: string | null
}

/** Заголовок вкладки терминала: имя терминала → оболочка → id. */
export function terminalTabTitle(terminal: TerminalTabTarget): string {
  return terminal.title || terminal.shell || terminal.id
}

/**
 * Заголовок вкладки терминала, привязанного к сессии: **имя сессии**.
 *
 * Источник истины — список сессий в сторе (`name || id`): заголовок вкладки
 * терминала всегда называет сессию, а не оболочку. Сессии нет в списке
 * (список не загружен) — откат на заголовок самого терминала.
 */
export function terminalTabTitleForSession(terminal: TerminalTabTarget): string {
  if (!terminal.sessionId) return terminalTabTitle(terminal)
  const session = useSessionsStore
    .getState()
    .sessions.find((sess) => sess.id === terminal.sessionId)
  if (!session) return terminalTabTitle(terminal)
  return session.name || session.id
}

/**
 * Синхронизировать заголовок вкладки терминала с именем сессии.
 *
 * Заголовок вкладки терминала = имя сессии **всегда**, в том числе после
 * переименования сессии (событие `session.updated` обновляет список сессий
 * в сторе). Терминал без сессии заголовок не трогает; совпадающее имя —
 * тоже (иначе вкладка «моргала» бы при каждом обновлении списка).
 */
export function syncTerminalTabTitle(tabId: string, sessionId?: string | null): void {
  if (!sessionId) return
  const session = useSessionsStore
    .getState()
    .sessions.find((sess) => sess.id === sessionId)
  if (!session) return
  const title = session.name || session.id
  const tab = useUIStore.getState().centerTabs.find((t) => t.id === tabId)
  if (!tab || tab.title === title) return
  useUIStore.getState().updateTabTitle(tabId, title)
}

/** Открыть (или переключиться на) вкладку терминала. */
export function openTerminalTab(terminal: TerminalTabTarget): void {
  if (!terminal.id) return
  useUIStore.getState().openTab({
    id: `terminal-${terminal.id}`,
    type: 'terminal',
    title: terminalTabTitleForSession(terminal),
    data: {
      terminalId: terminal.id,
      ...(terminal.projectId ? { projectId: terminal.projectId } : {}),
      ...(terminal.sessionId ? { sessionId: terminal.sessionId } : {}),
    },
  })
}

/** Цель вкладки-сессии: несколько терминалов в одной вкладке. */
export interface SessionTerminalTabTarget {
  /** Сессия-владелец вкладки. */
  sessionId: string
  /** Заголовок сессии — он же заголовок вкладки. */
  sessionTitle: string
  /** Проект сессии (нужен, чтобы создать ещё один терминал). */
  projectId?: string | null
  /** Активный терминал вкладки (необязательно). */
  terminalId?: string
}

/** id вкладки-сессии: одна вкладка на сессию. */
export function sessionTerminalTabId(sessionId: string): string {
  return `terminal-session-${sessionId}`
}

/**
 * Открыть (или переключиться на) вкладку терминалов сессии.
 *
 * Заголовок вкладки — заголовок сессии; активный терминал хранится в
 * `tab.data.terminalId` (вкладка одна на сессию, терминалы переключаются
 * внутри неё).
 */
export function openSessionTerminalTab(target: SessionTerminalTabTarget): void {
  if (!target.sessionId) return
  const tabId = sessionTerminalTabId(target.sessionId)
  useUIStore.getState().openTab({
    id: tabId,
    type: 'terminal',
    title: target.sessionTitle,
    data: {
      sessionId: target.sessionId,
      ...(target.projectId ? { projectId: target.projectId } : {}),
      ...(target.terminalId ? { terminalId: target.terminalId } : {}),
    },
  })
  // `openTab` у уже открытой вкладки обновляет только заголовок — активный
  // терминал переключаем явно.
  if (target.terminalId) {
    useUIStore.getState().updateTabData(tabId, { terminalId: target.terminalId })
  }
}

/**
 * Проверка сохранённых вкладок терминала после перезагрузки страницы.
 *
 * Терминал живёт в памяти процесса: после рестарта ядра сервер его не знает
 * (`GET /terminals/:id` → 404) — такую вкладку закрываем, чтобы она не
 * «висела» с пустым экраном. Вкладка-сессия проверяется по активному
 * терминалу (`tab.data.terminalId`): нет активного — проверять нечего
 * (переключатель сам возьмёт первый терминал сессии).
 */
export async function verifyTerminalTabs(): Promise<void> {
  const tabs = useUIStore
    .getState()
    .centerTabs.filter((tab) => tab.type === 'terminal')
  for (const tab of tabs) {
    const terminalId = tab.data.terminalId
    if (!terminalId) continue
    try {
      await terminalsApi.get(terminalId)
    } catch (err) {
      // Только 404 — терминала больше нет. Сетевая ошибка не должна закрывать
      // вкладку (иначе рестарт инстанса съел бы открытые терминалы).
      if (terminalApiErrorStatus(err) !== 404) continue
      useUIStore.getState().closeTab(tab.id)
    }
  }
}
