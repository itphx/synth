/**
 * Вкладка терминала (PROP-132, Ф3б).
 *
 * Эмулятор xterm.js поверх PTY, живущего на точке исполнения. Клиент держит
 * только раскладку: метаданные терминала — из стора, **вывод — отдельным
 * HTTP-потоком NDJSON** (`GET /api/v2/terminals/:id/stream`), ввод — HTTP.
 *
 * Порядок инициализации (важно для корректной картинки):
 * 1. терминал создаётся на **исходных** cols/rows сервера;
 * 2. снимок вывода `GET /terminals/:id/output?since=0` — на исходном размере,
 *    чтобы переносы строк совпали с серверными; курсор снимка (`next_seq`)
 *    уходит в поток, поэтому вывод не двоится;
 * 3. `fit()` подгоняет терминал под вьюпорт и шлёт `POST /resize`;
 * 4. поток `GET /terminals/:id/stream?since=<курсор>` — live-вывод; при обрыве
 *    сессия делает один повтор с курсора последнего кадра
 *    (`components/terminal/terminalStream.ts`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useI18n } from '@/lib/i18n'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { useTerminalsStore } from '@/stores/terminalsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useComposerDraftsStore } from '@/stores/composerDraftsStore'
import { terminalsApi, terminalApiErrorStatus } from '@/lib/api/terminals'
import { cn } from '@/lib/utils'
import { resolveTerminalTheme } from '@/lib/theme/terminal'
import { useThemeSystem } from '@/contexts/useThemeSystem'
import { preloadTerminalFont } from '@/lib/terminalFonts'
import { terminalFontStack } from '@/lib/terminalPreferences'
import { useNotification } from '@/hooks/useNotification'
import { Icon } from '@/components/icon/Icon'
import {
  buildTerminalContextBlock,
  readTerminalBufferLines,
  tailLines,
  TERMINAL_CONTEXT_LINES,
} from '@/lib/terminalContext'
import { TerminalQuickKeys } from './TerminalQuickKeys'
import { TerminalAskDock, type TerminalAskDockMode } from './TerminalAskDock'
import {
  runTerminalStreamSession,
  type TerminalConnectionState,
} from './terminalStream'

/** Дебаунс пересчёта геометрии по `ResizeObserver`, мс. */
const FIT_DEBOUNCE_MS = 150
/** Дебаунс отправки `POST /resize`, мс. */
const RESIZE_DEBOUNCE_MS = 300
/** Окно батчинга ввода, мс. */
const INPUT_BATCH_MS = 30
/** Не чаще 20 кадров ввода в секунду (50 мс между запросами). */
const INPUT_MIN_INTERVAL_MS = 50
/** Кап одного запроса ввода, байт. */
const MAX_INPUT_BYTES = 16 * 1024

export interface TerminalViewProps {
  tab: CenterTab
  /**
   * Терминала нет на сервере (`GET /terminals/:id` → 404).
   *
   * По умолчанию вкладка закрывается (терминал не переживает рестарт ядра).
   * Вкладка-сессия передаёт свой обработчик: там пропавший терминал — лишь
   * один из нескольких, вкладка остаётся.
   */
  onTerminalMissing?: (terminalId: string) => void
}

/** Статус терминала → ключ i18n. */
function statusKey(status: string): string {
  switch (status) {
    case 'starting':
      return 'terminal.status.starting'
    case 'running':
      return 'terminal.status.running'
    case 'exited':
      return 'terminal.status.exited'
    default:
      return 'terminal.status.closed'
  }
}

export function TerminalView({ tab, onTerminalMissing }: TerminalViewProps) {
  const { t } = useI18n()
  const { notify } = useNotification()
  const terminalId = tab.data.terminalId ?? ''
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [missing, setMissing] = useState(false)
  const [connection, setConnection] = useState<TerminalConnectionState>('live')
  const [truncated, setTruncated] = useState(false)
  const [streamExit, setStreamExit] = useState<{ exitCode?: number; signal?: string } | null>(
    null,
  )
  /** Док «Спросить агента» / «Прикрепить вывод» (null — док закрыт). */
  const [dock, setDock] = useState<{ mode: TerminalAskDockMode; lines: string[] } | null>(null)
  // Положение скролла — для затенения сверху/снизу как в чате: верх гаснет,
  // когда прокручено вниз, низ — когда не в конце вывода.
  const [scrollPos, setScrollPos] = useState<'top' | 'middle' | 'bottom'>('bottom')
  /** Перезапуск терминала: новое подключение к потоку вывода. */
  const [restartNonce, setRestartNonce] = useState(0)
  const [restarting, setRestarting] = useState(false)

  const terminal = useTerminalsStore((s) => (terminalId ? s.terminalsById[terminalId] : undefined))
  const loadTerminals = useTerminalsStore((s) => s.load)
  const closeTerminal = useTerminalsStore((s) => s.close)
  const preferences = useUIStore((s) => s.terminalPreferences)
  const { currentTheme } = useThemeSystem()

  // Имена сессий — для переходов «терминал → сессия» и подписи привязки.
  const sessions = useSessionsStore((s) => s.sessions)
  const sessionNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const session of sessions) map.set(session.id, session.name || session.id)
    return map
  }, [sessions])

  const palette = useMemo(
    () => resolveTerminalTheme(preferences.theme, currentTheme),
    [preferences.theme, currentTheme],
  )

  // Актуальные значения настроек/палитры — через ref: эффект создания
  // терминала не должен пересоздавать xterm при смене оформления (палитра
  // применяется отдельно, через `term.options.theme`).
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences
  const paletteRef = useRef(palette)
  paletteRef.current = palette

  // Право ввода меняется редко — держим его в ref, чтобы ввод не зависел от
  // пересоздания xterm.
  const canWriteRef = useRef(terminal?.can_write === true)
  canWriteRef.current = terminal?.can_write === true

  // Открытие несуществующего терминала: пробуем перечитать его с сервера,
  // иначе — «завершён» (терминал мог пережить перезапуск ядра).
  useEffect(() => {
    if (!terminalId || terminal) return
    let cancelled = false
    void (async () => {
      try {
        const fresh = await terminalsApi.get(terminalId)
        if (cancelled) return
        if (!fresh?.id) {
          setMissing(true)
          return
        }
        useTerminalsStore.setState((state) => ({
          terminalsById: { ...state.terminalsById, [fresh.id]: fresh },
          order: state.order.includes(fresh.id) ? state.order : [fresh.id, ...state.order],
        }))
      } catch (err) {
        if (cancelled) return
        // 404 — терминала на сервере нет (не пережил рестарт ядра, либо
        // авто-восстановление выключено): вкладку закрываем.
        if (terminalApiErrorStatus(err) === 404) {
          notify({
            text: t('terminal.missing.closed'),
            type: 'warning',
            category: 'system',
          })
          if (onTerminalMissing) {
            onTerminalMissing(terminalId)
          } else {
            useUIStore.getState().closeTab(tab.id)
          }
          return
        }
        setMissing(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [terminalId, terminal, notify, onTerminalMissing, t, tab.id])

  // Создание xterm, снимок вывода, HTTP-поток вывода.
  useEffect(() => {
    if (!terminalId || !containerRef.current) return
    if (!terminal) return

    let disposed = false
    // Поток живёт, пока открыта вкладка: смена терминала/размонтирование
    // гасят его через abort.
    const controller = new AbortController()
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let inputTimer: ReturnType<typeof setTimeout> | undefined
    let inputBuffer = ''
    let lastInputAt = 0
    let lastResize: { cols: number; rows: number } | null = null
    let observer: ResizeObserver | null = null
    let fitTimer: ReturnType<typeof setTimeout> | undefined
    // Курсор последнего принятого кадра — с него продолжаем после обрыва.
    let lastSeq = 0

    const prefs = preferencesRef.current
    const palette = paletteRef.current

    const term = new Terminal({
      cols: terminal.cols || 80,
      rows: terminal.rows || 24,
      fontFamily: terminalFontStack(prefs.fontFamily),
      fontSize: prefs.fontSize,
      lineHeight: prefs.lineHeight,
      letterSpacing: prefs.letterSpacing,
      scrollback: prefs.scrollback,
      cursorStyle: prefs.cursorStyle,
      cursorBlink: prefs.cursorBlink,
      // xterm 6: опция инвертирована — `false` = bracketed paste включён.
      ignoreBracketedPasteMode: false,
      convertEol: false,
      allowProposedApi: false,
      theme: {
        background: palette.background,
        foreground: palette.foreground,
        cursor: palette.cursor,
        cursorAccent: palette.cursorAccent,
        selectionBackground: palette.selectionBackground,
        black: palette.black,
        red: palette.red,
        green: palette.green,
        yellow: palette.yellow,
        blue: palette.blue,
        magenta: palette.magenta,
        cyan: palette.cyan,
        white: palette.white,
        brightBlack: palette.brightBlack,
        brightRed: palette.brightRed,
        brightGreen: palette.brightGreen,
        brightYellow: palette.brightYellow,
        brightBlue: palette.brightBlue,
        brightMagenta: palette.brightMagenta,
        brightCyan: palette.brightCyan,
        brightWhite: palette.brightWhite,
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())

    // Только просмотр: ввод запрещён на клиенте (право — на сервере).
    if (!canWriteRef.current) {
      term.options.disableStdin = true
    }

    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fitAddon

    // `Ctrl/Cmd+Shift+Enter` — док «Спросить агента» (Ф4б).
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (event.key !== 'Enter') return true
      if (!event.shiftKey) return true
      if (!(event.ctrlKey || event.metaKey)) return true
      setDock({ mode: 'ask', lines: collectContextLinesRef.current() })
      return false
    })

    // Копирование по выделению (как в терминалах редакторов).
    term.onSelectionChange(() => {
      const selection = term.getSelection()
      if (!selection) return
      try {
        void navigator.clipboard?.writeText(selection)
      } catch {
        // Буфер обмена недоступен — копирование не критично.
      }
    })

    // Звонок терминала: настройка «звонок» включает звук (иначе — тишина).
    term.onBell(() => {
      if (!preferencesRef.current.bell) return
      try {
        void navigator.vibrate?.(50)
      } catch {
        // Вибрация недоступна — не критично.
      }
    })

    // Ввод: батчинг 30 мс, не чаще 20 кадров/с, кап 16 КиБ на запрос.
    const flushInput = () => {
      inputTimer = undefined
      if (!inputBuffer) return
      const wait = Math.max(0, INPUT_MIN_INTERVAL_MS - (Date.now() - lastInputAt))
      if (wait > 0) {
        inputTimer = setTimeout(flushInput, wait)
        return
      }
      const chunk = inputBuffer.slice(0, MAX_INPUT_BYTES)
      inputBuffer = inputBuffer.slice(MAX_INPUT_BYTES)
      lastInputAt = Date.now()
      if (inputBuffer) {
        inputTimer = setTimeout(flushInput, INPUT_BATCH_MS)
      }
      void useTerminalsStore.getState().sendInput(terminalId, chunk)
    }

    term.onData((data) => {
      if (!canWriteRef.current) return
      inputBuffer += data
      if (inputTimer === undefined) {
        inputTimer = setTimeout(flushInput, INPUT_BATCH_MS)
      }
    })

    // Геометрия: `POST /resize` с дебаунсом 300 мс.
    term.onResize(({ cols, rows }) => {
      if (lastResize && lastResize.cols === cols && lastResize.rows === rows) return
      lastResize = { cols, rows }
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        void useTerminalsStore.getState().resize(terminalId, cols, rows)
      }, RESIZE_DEBOUNCE_MS)
    })

    // Подгонка под вьюпорт: `ResizeObserver` + дебаунс 150 мс.
    const container = containerRef.current
    if (container && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (fitTimer) clearTimeout(fitTimer)
        fitTimer = setTimeout(() => {
          try {
            fitAddon.fit()
          } catch {
            // Контейнер мог схлопнуться — следующая подгонка пройдёт.
          }
        }, FIT_DEBOUNCE_MS)
      })
      observer.observe(container)
    }

    // Предзагрузка символьного шрифта — до первой отрисовки глифов.
    void preloadTerminalFont()

    // Снимок вывода → поток вывода (replay уже показан, поток даёт live).
    void (async () => {
      let cursor = 0
      try {
        const snapshot = await terminalsApi.outputSince(terminalId, 0)
        if (disposed) return
        // Сервер сообщает, что часть вывода вытеснена из кольцевого буфера.
        if (snapshot.truncated) setTruncated(true)
        term.write(snapshot.data)
        cursor = snapshot.nextSeq
        lastSeq = snapshot.nextSeq
      } catch {
        // Снимок недоступен — поток отдаст вывод сам.
      }
      if (disposed) return

      // Теперь подгоняем под вьюпорт (реплей уже был на исходном размере).
      try {
        fitAddon.fit()
      } catch {
        // Контейнер ещё не имеет размеров — подгонка повторится по ResizeObserver.
      }

      // Завершённый терминал: потока вывода нет (сервер его не отдаёт) —
      // показываем сохранённый вывод и ждём «Восстановить терминал».
      if (terminal.status === 'exited') return

      await runTerminalStreamSession({
        terminalId,
        since: cursor,
        signal: controller.signal,
        onChunk: ({ seq, data }) => {
          if (disposed || !data) return
          if (seq > lastSeq) lastSeq = seq
          term.write(data)
        },
        onExit: (info) => {
          if (disposed) return
          setStreamExit(info)
        },
        onState: (state) => {
          if (disposed) return
          setConnection(state)
        },
      })
    })()

    // Затенение краёв: зависит от положения скролла (как data-scroll-shadow в чате).
    const updateScrollPos = () => {
      const buffer = term.buffer.active
      const atBottom = buffer.viewportY >= buffer.baseY
      const atTop = buffer.viewportY <= 0
      setScrollPos(atBottom ? 'bottom' : atTop ? 'top' : 'middle')
    }
    const scrollSub = term.onScroll(updateScrollPos)
    updateScrollPos()

    return () => {
      disposed = true
      scrollSub.dispose()
      controller.abort()
      observer?.disconnect()
      if (fitTimer) clearTimeout(fitTimer)
      if (resizeTimer) clearTimeout(resizeTimer)
      if (inputTimer) clearTimeout(inputTimer)
      try {
        term.dispose()
      } catch {
        // Уже уничтожен.
      }
      termRef.current = null
      fitRef.current = null
    }
    // Пересоздание — только при смене терминала (или после перезапуска):
    // смена геометрии/статуса приходит событием и не должна перезапускать
    // поток (иначе вывод переигрывался бы с начала). Настройки внешнего вида
    // применяются отдельно (палитра — мгновенно, шрифт — при следующем
    // открытии: xterm не умеет менять шрифт на лету).
  }, [terminalId, terminal?.id, restartNonce])

  // Право ввода — обновляем на живой xterm (пересоздания не требует).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.disableStdin = terminal ? !terminal.can_write : false
  }, [terminal?.can_write])

  // Смена палитры — перекраска без пересоздания.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = {
      background: palette.background,
      foreground: palette.foreground,
      cursor: palette.cursor,
      cursorAccent: palette.cursorAccent,
      selectionBackground: palette.selectionBackground,
      black: palette.black,
      red: palette.red,
      green: palette.green,
      yellow: palette.yellow,
      blue: palette.blue,
      magenta: palette.magenta,
      cyan: palette.cyan,
      white: palette.white,
      brightBlack: palette.brightBlack,
      brightRed: palette.brightRed,
      brightGreen: palette.brightGreen,
      brightYellow: palette.brightYellow,
      brightBlue: palette.brightBlue,
      brightMagenta: palette.brightMagenta,
      brightCyan: palette.brightCyan,
      brightWhite: palette.brightWhite,
    }
  }, [palette])

  const handleClose = useCallback(() => {
    if (!terminalId) return
    void closeTerminal(terminalId)
  }, [closeTerminal, terminalId])

  const handleReload = useCallback(() => {
    void loadTerminals(terminal?.projectId ? { projectId: terminal.projectId } : undefined)
  }, [loadTerminals, terminal?.projectId])

  /**
   * Восстановление терминала: сервер поднимает новую PTY (id терминала тот
   * же), клиент переподключает поток вывода.
   */
  const handleRestart = useCallback(async () => {
    if (!terminalId || restarting) return
    setRestarting(true)
    try {
      const fresh = await terminalsApi.restart(terminalId)
      if (fresh?.id) {
        useTerminalsStore.setState((state) => ({
          terminalsById: {
            ...state.terminalsById,
            [fresh.id]: { ...state.terminalsById[fresh.id], ...fresh },
          },
          order: state.order.includes(fresh.id) ? state.order : [fresh.id, ...state.order],
        }))
      }
      setStreamExit(null)
      // Новый поток вывода: пересоздаём xterm-сессию.
      setRestartNonce((nonce) => nonce + 1)
      notify({
        text: t('terminal.restart.done'),
        type: 'success',
        category: 'system',
      })
    } catch (err) {
      notify({
        text: t('terminal.restart.failed', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setRestarting(false)
    }
  }, [notify, restarting, t, terminalId])

  /**
   * Строки контекста: выделение (если есть) — иначе хвост буфера.
   *
   * Буфер читается из живого xterm, поэтому контекст всегда соответствует
   * тому, что человек видит на экране.
   */
  const collectContextLines = useCallback((): string[] => {
    const term = termRef.current
    if (!term) return []
    const selection = term.getSelection()
    if (selection && selection.trim() !== '') {
      return tailLines(selection, TERMINAL_CONTEXT_LINES)
    }
    return readTerminalBufferLines(term, TERMINAL_CONTEXT_LINES)
  }, [])

  // Ref на сборщик строк: хоткей xterm живёт в эффекте создания терминала,
  // а колбэк меняется при каждом рендере.
  const collectContextLinesRef = useRef(collectContextLines)
  collectContextLinesRef.current = collectContextLines

  /** Открыть чат привязанной сессии (переход «терминал → сессия»). */
  const handleOpenSession = useCallback(() => {
    const sessionId = terminal?.sessionId
    if (!sessionId) return
    const name = sessionNames.get(sessionId) ?? sessionId
    useUIStore.getState().openTab({
      id: `chat-${sessionId}`,
      type: 'chat',
      title: name,
      data: { sessionId },
    })
  }, [sessionNames, terminal?.sessionId])

  /** Вставка блока контекста в черновик композера сессии. */
  const insertContextIntoDraft = useCallback(
    (sessionId: string, lines: string[]) => {
      const block = buildTerminalContextBlock({
        terminalId,
        cwd: terminal?.cwd,
        shell: terminal?.shell,
        lines,
      })
      const drafts = useComposerDraftsStore.getState()
      const existing = drafts.textBySession[sessionId] ?? ''
      drafts.setText(sessionId, existing ? `${existing}\n${block}` : block)
      const name = sessionNames.get(sessionId) ?? sessionId
      useUIStore.getState().openTab({
        id: `chat-${sessionId}`,
        type: 'chat',
        title: name,
        data: { sessionId },
      })
      notify({
        text: t('terminal.attach.done'),
        type: 'success',
        category: 'message',
        sessionId,
      })
    },
    [notify, sessionNames, t, terminal?.cwd, terminal?.shell, terminalId],
  )

  /** «Прикрепить вывод»: выделение или последние N строк — в черновик композера. */
  const handleAttach = useCallback(() => {
    const lines = collectContextLines()
    const sessionId = terminal?.sessionId
    if (!sessionId) {
      // Привязки нет — выбор цели в доке.
      setDock({ mode: 'attach', lines })
      return
    }
    insertContextIntoDraft(sessionId, lines)
  }, [collectContextLines, insertContextIntoDraft, terminal?.sessionId])

  /** «Спросить агента»: док с полем вопроса и автоконтекстом. */
  const handleAskAgent = useCallback(() => {
    setDock({ mode: 'ask', lines: collectContextLines() })
  }, [collectContextLines])

  if (missing) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background p-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Icon name="terminal-box" className="size-8 text-muted-foreground" />
          <p className="text-sm text-foreground">{t('terminal.notFound')}</p>
          <p className="text-xs text-muted-foreground">{t('terminal.finishedHint')}</p>
        </div>
      </div>
    )
  }

  const readOnly = terminal ? !terminal.can_write : false
  const finished = terminal ? terminal.status === 'exited' : false
  const exitCode = terminal?.exitCode ?? streamExit?.exitCode ?? null

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Icon name="terminal-box" className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium text-foreground">
          {terminal?.title || terminal?.shell || t('terminal.title')}
        </span>
        <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          {t(statusKey(terminal?.status ?? 'running'))}
        </span>
        {readOnly && (
          <span
            data-testid="terminal-readonly-badge"
            className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            {t('terminal.readOnly')}
          </span>
        )}
        {connection !== 'live' && (
          <span
            data-testid="terminal-connection"
            className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            {connection === 'reconnecting'
              ? t('terminal.reconnecting')
              : t('terminal.connectionLost')}
          </span>
        )}
        {truncated && (
          <span
            data-testid="terminal-output-truncated"
            className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            {t('terminal.outputTruncated')}
          </span>
        )}
        {exitCode !== null && exitCode !== undefined && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {t('terminal.exitCode', { code: exitCode })}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {finished && (
            <button
              type="button"
              className="rounded-sm border border-border px-2 py-0.5 text-[0.625rem] font-medium text-foreground hover:bg-interactive-hover"
              onClick={() => void handleRestart()}
              disabled={restarting}
              title={t('terminal.restart.action')}
              aria-label={t('terminal.restart.action')}
              data-testid="terminal-restore"
            >
              <Icon
                name={restarting ? 'loader-2' : 'refresh'}
                className={cn('size-3', restarting && 'animate-spin')}
              />
              <span className="ml-1">{t('terminal.restart.action')}</span>
            </button>
          )}
          {terminal?.sessionId && (
            <button
              type="button"
              className="rounded-sm p-1 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
              onClick={handleOpenSession}
              title={t('terminal.openSession')}
              aria-label={t('terminal.openSession')}
              data-testid="terminal-open-session"
            >
              <Icon name="chat-new" className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            className="rounded-sm p-1 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
            onClick={handleAskAgent}
            title={t('terminal.ask.action')}
            aria-label={t('terminal.ask.action')}
            data-testid="terminal-ask-agent"
          >
            <Icon name="robot-2" className="size-3.5" />
          </button>
          <button
            type="button"
            className="rounded-sm p-1 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
            onClick={handleAttach}
            title={t('terminal.attach.action')}
            aria-label={t('terminal.attach.action')}
            data-testid="terminal-attach-output"
          >
            <Icon name="clipboard" className="size-3.5" />
          </button>
          <button
            type="button"
            className="rounded-sm p-1 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
            onClick={handleReload}
            title={t('terminal.refresh')}
            aria-label={t('terminal.refresh')}
            data-testid="terminal-refresh"
          >
            <Icon name="refresh" className="size-3.5" />
          </button>
          <button
            type="button"
            className="rounded-sm p-1 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
            onClick={handleClose}
            title={t('terminal.close')}
            aria-label={t('terminal.close')}
            data-testid="terminal-close"
          >
            <Icon name="close" className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          data-testid="terminal-container"
          className="h-full w-full min-w-0 overflow-hidden p-2"
        />
        {/* Затенение как в чате: край гаснет только когда за ним есть контент. */}
        {scrollPos !== 'top' && (
          <div
            aria-hidden
            data-testid="terminal-fade-top"
            className="pointer-events-none absolute inset-x-0 top-0 h-6"
            style={{ background: `linear-gradient(to bottom, ${palette.background}, transparent)` }}
          />
        )}
        {scrollPos !== 'bottom' && (
          <div
            aria-hidden
            data-testid="terminal-fade-bottom"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6"
            style={{ background: `linear-gradient(to top, ${palette.background}, transparent)` }}
          />
        )}
        {finished && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2">
            <span className="rounded-full bg-surface-card px-3 py-1 text-xs text-foreground">
              {t('terminal.finished')}
            </span>
          </div>
        )}
      </div>

      {/* Док «Спросить агента» занимает место в колонке, а не перекрывает
          нижние строки терминала: контейнер уменьшается и xterm делает fit. */}
      {dock && terminal && (
        <TerminalAskDock
          terminal={terminal}
          lines={dock.lines}
          mode={dock.mode}
          onClose={() => setDock(null)}
        />
      )}

      <TerminalQuickKeys
        onKey={(sequence) => {
          void useTerminalsStore.getState().sendInput(terminalId, sequence)
        }}
      />
    </div>
  )
}
