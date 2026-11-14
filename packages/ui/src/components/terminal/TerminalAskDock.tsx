// TerminalAskDock: док «Спросить агента» над терминалом (PROP-132, Ф4б).
//
// Док поверх терминала: поле вопроса + автоконтекст (последние N строк вывода,
// cwd, shell). Отправка — **обычным сообщением** в привязанную сессию: блок
// `<terminal_context>` уходит в текст сообщения, ничего автоматически в LLM
// не попадает.
//
// Привязки к сессии нет — показывается селектор сессии проекта (или «новая
// сессия»). Esc закрывает док без отправки.

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { useNotification } from '@/hooks/useNotification'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useTransportStore } from '@/stores/transportStore'
import { useComposerDraftsStore } from '@/stores/composerDraftsStore'
import { useUIStore } from '@/stores/useUIStore'
import { buildTerminalContextBlock, TERMINAL_CONTEXT_LINES } from '@/lib/terminalContext'
import type { TerminalDto } from '@/lib/api/terminals'

/** Значение селектора «новая сессия». */
const NEW_SESSION = '__new__'

export type TerminalAskDockMode = 'ask' | 'attach'

export interface TerminalAskDockProps {
  /** Терминал, из которого спрашиваем. */
  terminal: TerminalDto
  /** Строки вывода, которые уйдут в контекст (хвост буфера или выделение). */
  lines: string[]
  /** Режим: «спросить» (поле ввода) или «прикрепить вывод» (без отправки). */
  mode: TerminalAskDockMode
  /** Закрыть док (без отправки). */
  onClose: () => void
}

export const TerminalAskDock: React.FC<TerminalAskDockProps> = ({
  terminal,
  lines,
  mode,
  onClose,
}) => {
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

  const [question, setQuestion] = useState('')
  const [sessionId, setSessionId] = useState<string>(terminal.sessionId ?? '')
  const [busy, setBusy] = useState(false)

  // Значение по умолчанию: привязанная сессия, иначе первая сессия проекта.
  useEffect(() => {
    if (terminal.sessionId) {
      setSessionId(terminal.sessionId)
      return
    }
    setSessionId((current) => current || projectSessions[0]?.id || '')
  }, [projectSessions, terminal.sessionId])

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

  /** Разрешить целевую сессию (при необходимости — создать новую). */
  const resolveTarget = useCallback(async (): Promise<string | null> => {
    if (sessionId && sessionId !== NEW_SESSION) return sessionId
    if (sessionId === NEW_SESSION) {
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
    }
    notify({
      text: t('terminal.ask.noSession'),
      type: 'error',
      category: 'error',
    })
    return null
  }, [notify, sessionId, t, terminal.projectId])

  /** Отправка вопроса с контекстом в сессию. */
  const handleSend = useCallback(async () => {
    const text = question.trim()
    if (!text && lines.length === 0) return
    const target = await resolveTarget()
    if (!target) return
    setBusy(true)
    try {
      const message = text ? `${text}\n\n${contextBlock}` : contextBlock
      await useTransportStore.getState().sendMessage(target, message)
      notify({
        text: t('terminal.ask.sent'),
        type: 'success',
        category: 'message',
        sessionId: target,
      })
      setQuestion('')
      onClose()
    } catch (err) {
      notify({
        text: t('terminal.ask.failed', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
        sessionId: target,
      })
    } finally {
      setBusy(false)
    }
  }, [contextBlock, lines.length, notify, onClose, question, resolveTarget, t])

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

  // Esc — закрыть без отправки; Ctrl/Cmd+Enter — отправить.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (mode === 'ask' && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        event.stopPropagation()
        void handleSend()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [handleSend, mode, onClose])

  const hasBinding = !!terminal.sessionId

  return (
    <div
      data-testid="terminal-ask-dock"
      data-mode={mode}
      className="terminal-ask-dock absolute inset-x-2 bottom-2 z-10 max-h-[70%] overflow-y-auto rounded-xl border border-border bg-surface-elevated p-3 shadow-lg"
    >
      <div className="flex items-center gap-2">
        <Icon name="robot-2" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {mode === 'ask' ? t('terminal.ask.title') : t('terminal.attach.title')}
        </span>
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
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
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

      {mode === 'ask' && (
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={t('terminal.ask.placeholder')}
          data-testid="terminal-ask-input"
          rows={3}
          className="mt-2 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}

      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[0.625rem] text-muted-foreground">
          {mode === 'ask' ? t('terminal.ask.hint') : t('terminal.attach.hint')}
        </span>
        {mode === 'ask' ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSend()}
            disabled={busy}
            data-testid="terminal-ask-send"
          >
            <Icon name="send-plane" className="size-3.5" />
            {t('terminal.ask.send')}
          </Button>
        ) : (
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
        )}
      </div>
    </div>
  )
}

/** Класс корня дока (якорь CSS для мобильных правил ADR-044). */
export const TERMINAL_ASK_DOCK_CLASS = cn('terminal-ask-dock')
