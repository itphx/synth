// TerminalAskDock: док «Спросить агента» над терминалом (PROP-132, Ф4б).
//
// Док поверх терминала: **общий композер сессии** (`SessionComposer`) плюс
// автоконтекст (последние N строк вывода, cwd, shell). Отправка — обычным
// сообщением в целевую сессию: блок `<terminal_context>` дописывается к тексту
// сообщения, ничего автоматически в LLM не попадает.
//
// Логика очереди/отправки — **общая с чатом** (`SessionComposer` +
// `useSessionComposer`, UI-1): второй копии правил очереди в доке нет.
//
// Режим «прикрепить вывод» (`mode='attach'`) — прежнее поведение: блок
// контекста уходит в черновик композера сессии, открывается чат; композер в
// доке не показывается.
//
// Док **не закрывается** после отправки: он показывает, идёт ли ход агента
// («агент работает…» → «готово»), и закрывается только явно (крестик/Esc).
// Пока док открыт, сессия не накапливает непрочитанные — ответ агента не
// должен подсвечивать её оранжевым в дереве.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { useNotification } from '@/hooks/useNotification'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useChatStore } from '@/stores/chatStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useComposerDraftsStore } from '@/stores/composerDraftsStore'
import { useUIStore } from '@/stores/useUIStore'
import { buildTerminalContextBlock, TERMINAL_CONTEXT_LINES } from '@/lib/terminalContext'
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
 * Автодополнения композера (`@`, `$`, `#`, `/`): их Esc обрабатывает сам
 * композер — док в этом случае закрывать нельзя.
 */
const AUTOCOMPLETE_TESTIDS = [
  'mention-popup',
  'command-autocomplete',
  'skill-autocomplete',
  'snippet-autocomplete',
]

export type TerminalAskDockMode = 'ask' | 'attach'

/** Состояние индикатора работы агента. */
type AskPhase = 'idle' | 'working' | 'done'

export interface TerminalAskDockProps {
  /** Терминал, из которого спрашиваем. */
  terminal: TerminalDto
  /** Строки вывода, которые уйдут в контекст (хвост буфера или выделение). */
  lines: string[]
  /** Режим: «спросить» (композер) или «прикрепить вывод» (без отправки). */
  mode: TerminalAskDockMode
  /** Закрыть док (без отправки). */
  onClose: () => void
}

/** Открыто ли автодополнение композера (иначе Esc закрывает док). */
function hasOpenAutocomplete(root: HTMLElement | null): boolean {
  if (!root) return false
  return AUTOCOMPLETE_TESTIDS.some((id) => root.querySelector(`[data-testid="${id}"]`) !== null)
}

export function TerminalAskDock({ terminal, lines, mode, onClose }: TerminalAskDockProps) {
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
  const [busy, setBusy] = useState(false)
  /** Фаза индикатора: отправлено → агент работает → готово. */
  const [phase, setPhase] = useState<AskPhase>('idle')
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
    if (mode !== 'ask') return
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
  }, [createTargetSession, mode, selectedId])

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

  // Активный ход целевой сессии — единственный источник «агент работает» (ADR-118).
  const targetTurn = useChatStore((s) => (targetId ? s.turnBySession[targetId] : undefined))
  const isStreaming = targetTurn?.status === 'streaming'

  // Ход агента завершился — индикатор переключается на «готово».
  useEffect(() => {
    if (phase !== 'working') return
    if (!targetTurn) return
    const status = targetTurn.status
    if (status && status !== 'streaming') setPhase('done')
  }, [phase, targetTurn])

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

  const contextBlock = useMemo(
    () =>
      buildTerminalContextBlock({
        terminalId: terminal.id,
        cwd: terminal.cwd,
        shell: terminal.shell,
        lines,
      }),
    [lines, terminal.cwd, terminal.id, terminal.shell],
  )

  /**
   * Отправка вопроса: к тексту добавляется блок контекста терминала.
   *
   * Роль агента, режим и вложения сохраняются — композер отвечает за них.
   */
  const handleSend = useCallback<SessionComposerSend>(
    async (text, agentRole, sendMode, attachmentIds) => {
      const body = text.trim() ? `${text}\n\n${contextBlock}` : contextBlock
      await sendMessage(body, agentRole, sendMode, attachmentIds)
      // Док остаётся открытым: показываем, идёт ли ход агента.
      setPhase('working')
    },
    [contextBlock, sendMessage],
  )

  /** Контроллер композера с контекстом терминала (очередь — общая с чатом). */
  const composerController: SessionComposerController = { ...controller, handleSend }

  /** Цель для режима «прикрепить вывод» (сессия может быть создана здесь). */
  const resolveTarget = useCallback(async (): Promise<string | null> => {
    if (targetId) return targetId
    if (selectedId && selectedId !== NEW_SESSION) return selectedId
    if (selectedId === NEW_SESSION) return createTargetSession()
    notify({
      text: t('terminal.ask.noSession'),
      type: 'error',
      category: 'error',
    })
    return null
  }, [createTargetSession, notify, selectedId, t, targetId])

  /** Вставка блока в черновик композера (без автозапуска отправки). */
  const handleAttach = useCallback(async () => {
    const target = await resolveTarget()
    if (!target) return
    setBusy(true)
    try {
      const drafts = useComposerDraftsStore.getState()
      const existing = drafts.textBySession[target] ?? ''
      drafts.setText(target, existing ? `${existing}\n${contextBlock}` : contextBlock)
      const name =
        useSessionsStore.getState().sessions.find((s) => s.id === target)?.name ?? target
      useUIStore.getState().openTab({
        id: `chat-${target}`,
        type: 'chat',
        title: name,
        data: { sessionId: target },
      })
      notify({
        text: t('terminal.attach.done'),
        type: 'success',
        category: 'message',
        sessionId: target,
      })
      onClose()
    } finally {
      setBusy(false)
    }
  }, [contextBlock, notify, onClose, resolveTarget, t])

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
      data-mode={mode}
      className="terminal-ask-dock mx-2 mt-3 mb-2 shrink-0 max-h-[60%] overflow-y-auto rounded-xl border border-border bg-surface-card p-3 shadow-lg"
    >
      <div className="flex items-center gap-2">
        <Icon name="robot-2" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {mode === 'ask' ? t('terminal.ask.title') : t('terminal.attach.title')}
        </span>
        {/* Индикатор работы агента: док не закрывается после отправки. */}
        {phase !== 'idle' && (
          <span
            data-testid="terminal-ask-status"
            data-phase={phase}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem]',
              phase === 'done'
                ? 'bg-status-success/15 text-status-success'
                : 'bg-primary/15 text-primary',
            )}
          >
            <Icon
              name={phase === 'done' ? 'check' : 'loader-2'}
              className={cn('size-3', phase !== 'done' && 'animate-spin')}
            />
            <span>
              {phase === 'done' ? t('terminal.ask.done') : t('terminal.ask.working')}
            </span>
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          title={t('terminal.ask.close')}
          aria-label={t('terminal.ask.close')}
          data-testid="terminal-ask-close"
        >
          <Icon name="close" className="size-4" />
        </Button>
      </div>

      {/* Автоконтекст: последние N строк + cwd + shell. */}
      <p className="mt-1 text-[0.6875rem] text-muted-foreground break-words" data-testid="terminal-ask-context">
        {t('terminal.ask.context', { count: lines.length, limit: TERMINAL_CONTEXT_LINES })}
        {terminal.cwd ? ` · ${t('terminal.ask.cwd')}: ${terminal.cwd}` : ''}
        {terminal.shell ? ` · ${t('terminal.ask.shell')}: ${terminal.shell}` : ''}
      </p>

      {/* Цель: привязанная сессия или выбор из сессий проекта. */}
      {!hasBinding && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
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

      {mode === 'ask' ? (
        targetId ? (
          <>
            <p className="mt-2 text-[0.625rem] text-muted-foreground">{t('terminal.ask.hint')}</p>
            <SessionComposer
              controller={composerController}
              agents={agents}
              isStreaming={isStreaming}
            />
          </>
        ) : (
          <p className="mt-2 text-[0.6875rem] text-muted-foreground" data-testid="terminal-ask-no-session">
            {t('terminal.ask.noSession')}
          </p>
        )
      ) : (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-[0.625rem] text-muted-foreground">
            {t('terminal.attach.hint')}
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleAttach()}
            disabled={busy}
            data-testid="terminal-attach-confirm"
          >
            <Icon name="clipboard" className="size-3.5" />
            {t('terminal.attach.confirm')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** Класс корня дока (якорь CSS для мобильных правил ADR-044). */
export const TERMINAL_ASK_DOCK_CLASS = cn('terminal-ask-dock')
