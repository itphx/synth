// TerminalAskDock: док «Спросить агента» над терминалом (PROP-132, Ф4б).
//
// Док поверх терминала: **общий композер сессии** (`SessionComposer`) плюс
// автоконтекст (последние N строк вывода, cwd, shell). Отправка — обычным
// сообщением в целевую сессию; вывод терминала уходит **отдельным** полем
// `context` (контракт `POST /sessions/:id/prompt`), поэтому текст вопроса
// остаётся чистым, а сервер сохраняет контекст отдельным сообщением **до**
// вопроса.
//
// Док — **часть панели терминала**, а не карточка поверх: шапки (иконка,
// заголовок, статус, крестик) и рамки нет — только строка контекста, выбор
// сессии (если терминал не привязан) и само поле ввода.
//
// Логика очереди/отправки — **общая с чатом** (`SessionComposer` +
// `useSessionComposer`, UI-1): второй копии правил очереди в доке нет.
//
// Док **не закрывается** после отправки: он показывает состояние хода через
// композер (кнопка отправки/«Стоп»), а закрывается только явно (Esc или
// повторный клик по кнопке «Спросить агента» в тулбаре терминала). Пока док
// открыт, сессия не накапливает непрочитанные — ответ агента не должен
// подсвечивать её оранжевым в дереве.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useChatStore } from '@/stores/chatStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { TERMINAL_CONTEXT_LINES } from '@/lib/terminalContext'
import type { TerminalPromptContext } from '@/lib/api/sessions'
import {
  SessionComposer,
} from '@/components/chat/SessionComposer'
import {
  useSessionComposer,
  type SessionComposerController,
  type SessionComposerSend,
} from '@/components/chat/useSessionComposer'
import type { TerminalDto } from '@/lib/api/terminals'

/** Значение селектора «новая сессия». */
const NEW_SESSION = '__new__'

/**
 * Кап контекста терминала (байт) — как в контракте `POST /prompt`
 * (`content` ≤ 32 КиБ). Лишнее отрезается с конца, `truncated` — честный флаг.
 */
const MAX_CONTEXT_BYTES = 32 * 1024

/**
 * Автодополнения композера (`@`, `$`, `#`, `/`): их Esc обрабатывает сам
 * композер — док в этом случае закрывать нельзя.
 */
const AUTOCOMPLETE_TESTIDS = [
  'mention-popup',
  'command-autocomplete',
  'skill-autocomplete',
  'snippet-autocomplete',
]

export interface TerminalAskDockProps {
  /** Терминал, из которого спрашиваем. */
  terminal: TerminalDto
  /** Строки вывода, которые уйдут в контекст (хвост буфера или выделение). */
  lines: string[]
  /** Закрыть док (без отправки). */
  onClose: () => void
}

/** Открыто ли автодополнение композера (иначе Esc закрывает док). */
function hasOpenAutocomplete(root: HTMLElement | null): boolean {
  if (!root) return false
  return AUTOCOMPLETE_TESTIDS.some((id) => root.querySelector(`[data-testid="${id}"]`) !== null)
}

/** Статус терминала → статус в контракте контекста (`closing` — уже не жив). */
function contextStatus(status: TerminalDto['status']): TerminalPromptContext['status'] {
  if (status === 'starting' || status === 'running') return status
  return 'exited'
}

export function TerminalAskDock({ terminal, lines, onClose }: TerminalAskDockProps) {
  const { t } = useI18n()
  const { notify } = useNotification()

  const sessions = useSessionsStore((s) => s.sessions)
  const projectSessions = useMemo(
    () =>
      sessions.filter((session) =>
        terminal.projectId ? session.project_id === terminal.projectId : true,
      ),
    [sessions, terminal.projectId],
  )

  /** Выбор цели: id сессии либо «новая сессия». */
  const [selectedId, setSelectedId] = useState<string>(terminal.sessionId ?? '')
  /**
   * Разрешённая цель — id сессии, в которую уходит вопрос.
   *
   * Композеру нужен **готовый** адресат, поэтому «новая сессия» создаётся
   * заранее (до показа композера), а не в момент отправки.
   */
  const [targetId, setTargetId] = useState<string | null>(terminal.sessionId ?? null)
  /** Корень дока — нужен, чтобы отличить Esc композера от Esc дока. */
  const dockRef = useRef<HTMLDivElement>(null)

  // Значение по умолчанию: привязанная сессия, иначе первая сессия проекта
  // (или «новая сессия», если сессий в проекте нет).
  useEffect(() => {
    if (terminal.sessionId) {
      setSelectedId(terminal.sessionId)
      setTargetId(terminal.sessionId)
      return
    }
    setSelectedId((current) => current || projectSessions[0]?.id || NEW_SESSION)
  }, [projectSessions, terminal.sessionId])

  /** Создание сессии («новая сессия»): при ошибке — тост, цели нет. */
  const createTargetSession = useCallback(async (): Promise<string | null> => {
    const created = await useSessionsStore.getState().createSession({
      project_id: terminal.projectId,
    })
    if (!created) {
      notify({
        text: t('terminal.ask.sessionCreateFailed'),
        type: 'error',
        category: 'error',
      })
      return null
    }
    return created.id
  }, [notify, t, terminal.projectId])

  /**
   * Разрешение цели для композера.
   *
   * Выбранная сессия — цель сразу; «новая сессия» — создаётся (и только после
   * этого композер получает адресата).
   */
  useEffect(() => {
    if (!selectedId) {
      setTargetId(null)
      return
    }
    if (selectedId !== NEW_SESSION) {
      setTargetId(selectedId)
      return
    }
    let cancelled = false
    void (async () => {
      const id = await createTargetSession()
      if (cancelled) return
      setTargetId(id)
    })()
    return () => {
      cancelled = true
    }
  }, [createTargetSession, selectedId])

  // Общий контроллер композера (UI-1): отправка, «Стоп», очередь.
  const controller = useSessionComposer(targetId ?? '')
  const sendMessage = controller.handleSend

  // Агенты целевой сессии — для упоминаний `@` и выбора агента.
  const agents = useAgentsStore((s) => s.agents)
  const loadAgents = useAgentsStore((s) => s.loadAgents)
  useEffect(() => {
    if (!targetId) return
    void loadAgents(targetId)
  }, [loadAgents, targetId])

  // Ход целевой сессии — композер переключает кнопку отправки на «в очередь»
  // и показывает «Стоп» (ADR-118).
  const isStreaming = useChatStore((s) =>
    targetId ? s.turnBySession[targetId]?.status === 'streaming' : false,
  )

  /**
   * Подавление непрочитанного счётчика сессии.
   *
   * Пока док открыт, сессия не подсвечивается: человек видит ответ в доке.
   * Набор подавленных — в `notificationStore` (runtime), снимается при закрытии.
   */
  const suppressedRef = useRef<Set<string>>(new Set())
  const suppressSession = useCallback((target: string | null | undefined) => {
    if (!target) return
    const store = useNotificationStore.getState()
    store.suppressUnread(target, true)
    store.clearSessionUnread(target)
    suppressedRef.current.add(target)
  }, [])
  const releaseSessions = useCallback(() => {
    const store = useNotificationStore.getState()
    for (const id of suppressedRef.current) store.suppressUnread(id, false)
    suppressedRef.current.clear()
  }, [])

  // Пока док открыт — подавляем непрочитанные у целевой сессии.
  useEffect(() => {
    if (!targetId) return
    suppressSession(targetId)
    return () => releaseSessions()
  }, [releaseSessions, suppressSession, targetId])

  /**
   * Контекст терминала для отправки (контракт `POST /sessions/:id/prompt`).
   *
   * Контекст уходит **всегда** — даже пустым: так агент видит, что вывод
   * терминала приложен (пустой — тоже факт). Содержимое режется по капу
   * 32 КиБ; `truncated` отмечает и обрезку по капу строк, и по капу байт.
   */
  const terminalContext = useMemo<TerminalPromptContext>(() => {
    const kept: string[] = []
    let bytes = 0
    for (const line of lines) {
      const size = line.length + 1 // + перевод строки
      if (bytes + size > MAX_CONTEXT_BYTES) break
      kept.push(line)
      bytes += size
    }
    return {
      terminal_id: terminal.id,
      content: kept.join('\n'),
      ...(terminal.cwd ? { cwd: terminal.cwd } : {}),
      ...(terminal.shell ? { shell: terminal.shell } : {}),
      status: contextStatus(terminal.status),
      lines: kept.length,
      truncated: kept.length < lines.length || lines.length >= TERMINAL_CONTEXT_LINES,
    }
  }, [lines, terminal.cwd, terminal.id, terminal.shell, terminal.status])

  /**
   * Отправка вопроса: текст уходит **чистым**, вывод терминала — отдельным
   * полем `context`.
   *
   * Роль агента, режим и вложения сохраняются — композер отвечает за них.
   */
  const handleSend = useCallback<SessionComposerSend>(
    async (text, agentRole, sendMode, attachmentIds) => {
      await sendMessage(text, agentRole, sendMode, attachmentIds, terminalContext)
    },
    [sendMessage, terminalContext],
  )

  /** Контроллер композера с контекстом терминала (очередь — общая с чатом). */
  const composerController: SessionComposerController = { ...controller, handleSend }

  /**
   * Esc — закрыть док.
   *
   * Перехват на `window` (capture) — иначе Esc в композере сработал бы как
   * «Стоп» хода. Открытое автодополнение (`@`/`$`/`#`/`/`) обрабатывает Esc
   * само: в этом случае док не закрываем.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (event.isComposing) return
      if (hasOpenAutocomplete(dockRef.current)) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const hasBinding = !!terminal.sessionId

  return (
    <div
      ref={dockRef}
      data-testid="terminal-ask-dock"
      className="terminal-ask-dock mx-2 mt-3 mb-2 shrink-0 max-h-[60%] overflow-y-auto"
    >
      {/* Автоконтекст: одна строка — сколько строк, каталог, оболочка. */}
      <p
        className="mb-1 text-[0.6875rem] text-muted-foreground break-words"
        data-testid="terminal-ask-context"
      >
        {t('terminal.ask.context', { count: lines.length })}
        {terminal.cwd ? ` · ${t('terminal.ask.cwd')}: ${terminal.cwd}` : ''}
        {terminal.shell ? ` · ${t('terminal.ask.shell')}: ${terminal.shell}` : ''}
      </p>

      {/* Цель: привязанная сессия или выбор из сессий проекта. */}
      {!hasBinding && (
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <label className="text-[0.6875rem] text-muted-foreground" htmlFor="terminal-ask-session">
            {t('terminal.ask.session')}
          </label>
          <select
            id="terminal-ask-session"
            data-testid="terminal-ask-session"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            <option value={NEW_SESSION}>{t('terminal.ask.newSession')}</option>
            {projectSessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.name || session.id}
              </option>
            ))}
          </select>
        </div>
      )}

      {targetId ? (
        <SessionComposer
          controller={composerController}
          agents={agents}
          isStreaming={isStreaming}
        />
      ) : (
        <p className="text-[0.6875rem] text-muted-foreground" data-testid="terminal-ask-no-session">
          {t('terminal.ask.noSession')}
        </p>
      )}
    </div>
  )
}
