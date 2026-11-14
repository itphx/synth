/**
 * Сессия потока вывода терминала (PROP-132, Ф3б).
 *
 * Поток вывода идёт **только** по HTTP (`GET /api/v2/terminals/:id/stream`,
 * NDJSON): сервер по шине `terminal.data` не публикует (волатильный класс —
 * `docs/API_V2.md` §5.43). Сессия потока:
 *
 * 1. подключение с курсором `since` (курсор снимка вывода — чтобы не было
 *    двойного вывода: снимок уже показан, поток отдаёт только новое);
 * 2. при обрыве — **один** повтор с курсором последнего принятого кадра
 *    (`since = <последний seq>`), чтобы не потерять и не задвоить вывод;
 * 3. повтор не удался — состояние `lost` («соединение потеряно»).
 *
 * Отмена — `AbortController` (размонтирование вкладки, смена терминала).
 */

import { terminalsApi, type TerminalStreamOptions } from '@/lib/api/terminals'

/** Состояние связи с потоком вывода. */
export type TerminalConnectionState = 'live' | 'reconnecting' | 'lost'

export interface TerminalStreamSessionOptions {
  /** Терминал, чей вывод читаем. */
  terminalId: string
  /** Курсор, с которого начинаем (курсор снимка вывода). */
  since?: number
  /** Отмена сессии. */
  signal: AbortSignal
  /** Фрагмент вывода. */
  onChunk: (chunk: { seq: number; data: string }) => void
  /** Терминал завершился. */
  onExit?: (info: { exitCode?: number; signal?: string }) => void
  /** Смена состояния связи. */
  onState?: (state: TerminalConnectionState) => void
  /** Поток (подмена в тестах). */
  stream?: (id: string, options: TerminalStreamOptions) => Promise<void>
}

/** Максимум попыток подключения: первая + один повтор после обрыва. */
const MAX_ATTEMPTS = 2

export async function runTerminalStreamSession(
  options: TerminalStreamSessionOptions,
): Promise<void> {
  const stream = options.stream ?? terminalsApi.streamTerminal
  let since = options.since ?? 0
  let attempt = 0
  for (;;) {
    // «Живой» считаем поток, который прислал данные (или закрылся штатно) —
    // после реконнекта это и есть признак, что связь восстановлена.
    let alive = false
    const markAlive = () => {
      if (alive) return
      alive = true
      options.onState?.('live')
    }
    try {
      await stream(options.terminalId, {
        since,
        signal: options.signal,
        onChunk: (chunk) => {
          markAlive()
          if (chunk.seq > since) since = chunk.seq
          options.onChunk(chunk)
        },
        onExit: (info) => {
          markAlive()
          options.onExit?.(info)
        },
      })
      // Поток закрылся штатно (сервер закрыл его — терминал завершён).
      markAlive()
      return
    } catch {
      if (options.signal.aborted) return
      if (attempt + 1 >= MAX_ATTEMPTS) {
        options.onState?.('lost')
        return
      }
      attempt += 1
      options.onState?.('reconnecting')
      // Повтор — с курсора последнего принятого кадра.
    }
  }
}
