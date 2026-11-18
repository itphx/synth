/**
 * Запуски команд в терминале (PROP-132, Ф5).
 *
 * ## Механика завершения
 *
 * Команда уходит в интерактивную оболочку терминала, поэтому «код возврата»
 * из неё самой не достать. После команды сервис отправляет **текстовый**
 * маркер:
 *
 * ```text
 * printf '\n@@srn-<nonce>:%s@@\n' "$?"
 * ```
 *
 * В потоке остаётся строка `@@srn-<nonce>:<код>@@` (отдельная видимая строка),
 * и по ней реестр понимает, что команда закончилась.
 *
 * - `printf` — builtin любой POSIX-оболочки, внешняя программа не нужна;
 * - `"$?"` — код возврата **предыдущей** команды: маркер отправляется
 *   **отдельной строкой** после команды, поэтому `$?` ещё не изменился;
 * - `<nonce>` — случайный идентификатор запуска: маркер чужого запуска (или
 *   чужой команды) не завершит наш.
 *
 * **Почему не OSC.** Раньше маркер был OSC-последовательностью
 * (`ESC ] 7770 ; synth-run ; … BEL`) — «невидимой». В PTY, где работает
 * мультиплексор или TUI (tmux, а также tmux под ssh), OSC перехватывает сам
 * мультиплексор и наружу (в наш буфер) **не пропускает**: код возврата не
 * приходил, запуск висел до таймаута, терминал оставался занятым
 * (`run_busy`). Текстовая строка проходит через любой мультиплексор.
 *
 * **Почему без самостирания.** Вариант с `\033[2K` до и после маркера и
 * завершающим `\r` под tmux до внешнего буфера не доходит: tmux применяет
 * erase до перерисовки и текст наружу не отдаёт. Поэтому маркер печатается
 * **видимой отдельной строкой**; из вывода для модели он вырезается по nonce
 * (`cleanRunOutput`), а в самом терминале это короткая строка — принято.
 *
 * Маркер считается маркером, только если он **начинает строку** (эхо команды
 * `printf '…@@srn-…'` начинается с `printf` — ложных срабатываний нет) и
 * заканчивается `@@`; код — целое (в т.ч. отрицательное) или пусто.
 *
 * ## Реестр запусков
 *
 * `TerminalRunRegistry` — реестр запусков **в памяти процесса** (как и
 * реестр терминалов): запуски не переживают рестарт инстанса.
 *
 * - не больше **одного активного** запуска на терминал: два одновременных
 *   запуска в одной оболочке смешали бы вывод (`terminal.tool.run_busy`);
 * - вывод запуска ограничен **1 МиБ** (хвост сохраняется, `truncated`);
 * - в реестре не больше **32** записей (старые завершённые вытесняются);
 * - закрытие терминала завершает его активный запуск статусом `exited`;
 * - **watchdog** запуска (таймаут): срок `<= 0` — таймер **не ставится**
 *   (запуск без лимита: завершает только маркер команды или закрытие
 *   терминала), срок `> 0` — по истечении запуск завершается статусом
 *   `timeout`.
 *
 * ## Таймаут: убивать команду или оставить терминал занятым
 *
 * Истечение watchdog'а само по себе **не гасит команду**: она продолжает
 * выполняться в PTY. Что происходит дальше, задаёт `killOnTimeout`:
 *
 * - `killOnTimeout: true` — перед фиксацией `timeout` реестр зовёт
 *   `onKillTimeout(terminalId)` (сервис пишет `0x03`, ETX = Ctrl+C) и
 *   завершает запуск с `stillRunning: false` — терминал **свободен**;
 * - `killOnTimeout: false` (дефолт) — статус `timeout`, `stillRunning: true`:
 *   срок ожидания истёк, а команда ещё работает, поэтому следующий запуск в
 *   этом терминале получает отказ `terminal.tool.run_busy`. Когда команда
 *   доиграет, её маркер придёт и запуск станет `done` (терминал освободится) —
 *   **повторного уведомления при этом нет**: уведомление о завершении уходит
 *   один раз (на первом переходе);
 * - закрытие терминала освобождает его в любом случае (`exited`).
 *
 * Статус `exited` (вместо прежнего `closed`) — тот же смысл, что и у
 * терминала: оболочка/PTY больше нет, команда не доиграла.
 *
 * ## Ctrl+C — пользователь прервал команду
 *
 * Ctrl+C (`0x03`, ETX) в интерактивной оболочке прерывает **текущую строку**,
 * а не только команду: строка-маркер, отправленная сервисом отдельной строкой,
 * после прерывания уже не выполняется — её `printf` в поток не придёт. Поэтому
 * сервис при виде ETX во вводе сам завершает активный запуск через
 * `interrupt()`: статус `done`, `exitCode: 130` (как у оболочки), `stillRunning:
 * false`. Без этого запуск остался бы активным навсегда (`run_busy` на любой
 * следующий запуск).
 *
 * ## Границы
 *
 * Права — на границе (инвариант 16): сервис не решает, кто может запускать
 * команды; это делает permission-слой. Здесь — только исполнение и учёт.
 */
import { randomUUID } from 'node:crypto';
import { MessageRole, generateId as generateMessageId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';
import { t as sm } from '../system-messages.js';
import { msToTimeoutSec } from '../timeout.js';
import {
  cleanRunOutput,
  formatBackgroundContent,
  TERMINAL_RUN_MARKER_END,
  TERMINAL_RUN_MARKER_PREFIX,
} from './output.js';
import type { TerminalLogger, TerminalRecord, TerminalTimers } from './types.js';

/**
 * Префикс маркера завершения запуска (`@@srn-<nonce>:<код>@@`).
 *
 * Константа живёт в `output.ts` (там же очистка вывода) и реэкспортируется
 * здесь: для потребителей протокол маркера — часть запусков.
 */
export { TERMINAL_RUN_MARKER_END, TERMINAL_RUN_MARKER_PREFIX };

/**
 * Максимум байт хвоста, удерживаемого между чанками.
 *
 * Маркер может прийти несколькими чанками (граница в середине строки, в том
 * числе внутри CSI/escape-последовательности перед ней) — такой хвост
 * удерживается до следующего чанка. Если хвост не растёт (чужой текст с
 * префиксом маркера и без `@@`) — он сбрасывается в текст: иначе буфер
 * терминала «залипнет» на неполном маркере.
 */
const MAX_MARKER_PENDING = 512;

/** Полезная нагрузка маркера: `<nonce>:<код>` (код — целое, в т.ч. отрицательное, или пусто). */
const MARKER_PAYLOAD_PATTERN = /^([A-Za-z0-9_-]+):(-?\d*)$/;

/** Максимум объёма вывода одного запуска, байт (1 МиБ). */
export const MAX_RUN_OUTPUT_BYTES = 1024 * 1024;

/** Максимум числа записей в реестре запусков. */
export const MAX_STORED_RUNS = 32;

/** Статус запуска. */
export type TerminalRunStatus = 'running' | 'done' | 'timeout' | 'exited';

/**
 * Колбэк завершения запуска команды в терминале.
 *
 * Вызывается **один раз** на запуск (любой статус: `done`/`timeout`/`exited`)
 * и **только для фоновых** запусков (`background: true`): у режима с
 * ожиданием результат уже вернулся инлайн-ответом.
 * Точка сборки уведомления — наверху (composition root): сервис терминалов не
 * знает, как доставлять результат в сессию.
 */
export type TerminalRunFinishedHandler = (
  run: TerminalRunRecord,
  terminal: TerminalRecord | null,
) => void | Promise<void>;

/** Запись реестра запусков. */
export interface TerminalRunRecord {
  /** Идентификатор запуска (`run_<uuid>`). */
  runId: string;
  /** Терминал, в котором выполняется команда. */
  terminalId: string;
  /** Сессия, привязанная к терминалу (куда уходит уведомление о завершении). */
  sessionId?: string;
  /** Случайный nonce маркера (идентификатор запуска в потоке PTY). */
  nonce: string;
  /** Команда, отправленная в терминал. */
  command: string;
  /** Статус запуска. */
  status: TerminalRunStatus;
  /**
   * Запуск фоновый: результат доставляется **уведомлением** в сессию.
   *
   * `false`/нет — режим с ожиданием (`terminal_run` без `background`): ответ
   * уже ушёл инлайн, второе сообщение было бы дублем.
   */
  background?: boolean;
  /**
   * Занимает ли запуск терминал **прямо сейчас**.
   *
   * `true` — `running` или `timeout` без убийства команды (она продолжает
   * работать в PTY); `false` — `done`/`exited` либо `timeout` с убийством
   * (`killOnTimeout`): терминал свободен, следующий запуск пройдёт.
   */
  stillRunning?: boolean;
  /**
   * Строка-обёртка (команда маркера), отправленная после команды.
   *
   * Служебная деталь очистки: по ней из вывода уведомления снимается эхо
   * служебной строки. В текст уведомления и в метаданные не попадает.
   */
  wrapperCommand?: string;
  /** Вывод, накопленный к моменту чтения. */
  output: string;
  /** Код возврата команды (известен после завершения). */
  exitCode?: number;
  /** Момент старта, мс epoch. */
  startedAt: number;
  /** Момент завершения, мс epoch. */
  finishedAt?: number;
  /** Срок ожидания запуска, мс (`0` — watchdog не ставился). */
  timeoutMs: number;
  /** Вывод запуска обрезан по капу объёма. */
  truncated: boolean;
}

/** Часть потока вывода: обычный текст или маркер завершения запуска. */
export type TerminalRunMarkerPart =
  | { kind: 'text'; text: string }
  | { kind: 'marker'; nonce: string; code: string };

/** Результат разбора потока на текст и маркеры. */
export interface TerminalRunMarkerScan {
  /** Части потока по порядку. */
  parts: TerminalRunMarkerPart[];
  /** Хвост, удерживаемый до следующего чанка (возможное начало маркера). */
  pending: string;
}

/**
 * Длина longest суффикса текста, который является началом префикса маркера.
 *
 * Нужен, когда граница чанка попала внутрь строки-маркера: такой хвост нельзя
 * отдать в буфер (маркер должен быть вырезан целиком) — его надо удержать до
 * следующего чанка.
 */
function partialMarkerPrefixLength(text: string): number {
  const max = Math.min(text.length, TERMINAL_RUN_MARKER_PREFIX.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (text.endsWith(TERMINAL_RUN_MARKER_PREFIX.slice(0, len))) return len;
  }
  return 0;
}

/** ESC — начало escape-последовательности. */
const ESC = '\u001B';

/** Незавершённая CSI: `ESC [ <параметры>` без финального байта. */
const PARTIAL_CSI_PATTERN = new RegExp(`^${ESC}\\[[0-9;?]*$`);

/**
 * Длина незавершённой escape-последовательности в конце текста.
 *
 * Перед маркером может стоять CSI (стирание/позиционирование от оболочки или
 * мультиплексора); если граница чанка попала внутрь (`…\033[2`), хвост надо
 * удержать: иначе следующая порция начнётся с `K@@srn-…` и кандидат уже не
 * будет «началом строки».
 */
function partialEscapeSuffixLength(text: string): number {
  const esc = text.lastIndexOf(ESC);
  if (esc !== -1) {
    const tail = text.slice(esc);
    if (tail === ESC) return 1;
    if (PARTIAL_CSI_PATTERN.test(tail)) return tail.length;
  }
  if (text.endsWith('\u009B')) return 1;
  return 0;
}

/**
 * Длина ведущих escape-последовательностей и пробельных символов.
 *
 * Маркер считается маркером, только если он **начинает строку**; CSI
 * (стирание/позиционирование), пробелы и `\r` — служебное оформление той же
 * строки, а не текст, поэтому в «начало строки» они не мешают.
 */
function leadingControlLength(text: string): number {
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\u001B') {
      const next = text[i + 1];
      if (next === '[') {
        i += 2;
        while (i < text.length) {
          const code = text.charCodeAt(i);
          i += 1;
          if (code >= 0x40 && code <= 0x7e) break;
        }
        continue;
      }
      if (next === ']') {
        i += 2;
        while (i < text.length) {
          const c = text[i]!;
          if (c === '\u0007' || c === '\u009C') {
            i += 1;
            break;
          }
          if (c === '\u001B' && text[i + 1] === '\\') {
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }
      i += next === undefined ? 1 : 2;
      continue;
    }
    if (ch === '\u009B') {
      i += 1;
      while (i < text.length) {
        const code = text.charCodeAt(i);
        i += 1;
        if (code >= 0x40 && code <= 0x7e) break;
      }
      continue;
    }
    break;
  }
  return i;
}

/** Разобрать полезную нагрузку маркера (`<nonce>:<код>`). */
function parseMarkerPayload(payload: string): { kind: 'marker'; nonce: string; code: string } {
  const sep = payload.indexOf(':');
  const nonce = sep === -1 ? payload : payload.slice(0, sep);
  const code = sep === -1 ? '' : payload.slice(sep + 1);
  return { kind: 'marker', nonce, code };
}

/**
 * Разобрать поток вывода на текст и маркеры завершения запусков.
 *
 * Маркер — строка `@@srn-<nonce>:<код>@@`, которая **начинает строку** (эхо
 * команды `printf '…@@srn-…'` начинается с `printf` — не считается) и
 * заканчивается `@@`. Перед маркером могут стоять CSI/пробелы/`\r` — служебное
 * оформление той же строки, а не текст.
 *
 * `pending` — хвост предыдущего чанка (возможное начало маркера, в т.ч. внутри
 * CSI перед ним). На выходе — новый `pending` для следующего вызова:
 * удерживается незавершённый маркер (в пределах `MAX_MARKER_PENDING`) и
 * недописанная escape-последовательность; «мусор без конца» сбрасывается в
 * текст.
 */
export function scanRunMarkers(data: string, pending: string): TerminalRunMarkerScan {
  const buf = pending + data;
  const parts: TerminalRunMarkerPart[] = [];
  let text = '';
  let cursor = 0;
  let searchFrom = 0;

  const flushText = (): void => {
    if (text === '') return;
    parts.push({ kind: 'text', text });
    text = '';
  };

  while (searchFrom < buf.length) {
    const idx = buf.indexOf(TERMINAL_RUN_MARKER_PREFIX, searchFrom);
    if (idx === -1) break;
    // Маркер — только в начале строки: перед ним допустимы пробелы/`\r` и
    // escape-последовательности (стирание строки), но не текст.
    const lineStart = buf.lastIndexOf('\n', idx - 1) + 1;
    if (leadingControlLength(buf.slice(lineStart, idx)) !== idx - lineStart) {
      searchFrom = idx + TERMINAL_RUN_MARKER_PREFIX.length;
      continue;
    }
    const payloadStart = idx + TERMINAL_RUN_MARKER_PREFIX.length;
    const endIdx = buf.indexOf(TERMINAL_RUN_MARKER_END, payloadStart);
    const payload = endIdx === -1 ? buf.slice(payloadStart) : buf.slice(payloadStart, endIdx);
    // Маркер однострочный: перевод строки внутри полезной нагрузки означает,
    // что `@@` так и не пришёл — это обрывок, а не маркер.
    const complete = endIdx !== -1 && !payload.includes('\n') && MARKER_PAYLOAD_PATTERN.test(payload);
    if (complete) {
      // Текст до маркера идёт в вывод, а служебное оформление самой строки
      // маркера (CSI/пробелы перед ним) — нет: это не вывод команды.
      const keepFrom = Math.max(lineStart, cursor);
      text += buf.slice(cursor, keepFrom);
      flushText();
      parts.push(parseMarkerPayload(payload));
      cursor = endIdx + TERMINAL_RUN_MARKER_END.length;
      searchFrom = cursor;
      continue;
    }
    // Незавершённый кандидат (нет `@@`, нет перевода строки) — удерживаем:
    // маркер мог разорваться границей чанка.
    if (endIdx === -1 && !payload.includes('\n')) {
      const keepFrom = Math.max(lineStart, cursor);
      if (buf.length - keepFrom <= MAX_MARKER_PENDING) {
        text += buf.slice(cursor, keepFrom);
        flushText();
        return { parts, pending: buf.slice(keepFrom) };
      }
    }
    // «Мусор без конца» или строка, лишь похожая на маркер, — обычный текст.
    searchFrom = idx + TERMINAL_RUN_MARKER_PREFIX.length;
  }

  const rest = buf.slice(cursor);
  const keep = Math.max(partialMarkerPrefixLength(rest), partialEscapeSuffixLength(rest));
  text += rest.slice(0, rest.length - keep);
  if (text !== '') parts.push({ kind: 'text', text });

  return { parts, pending: rest.slice(rest.length - keep) };
}

/** Код возврата из маркера (нецифровое значение — код неизвестен). */
export function parseRunExitCode(code: string): number | undefined {
  // Код может быть отрицательным (`kill` возвращает `-1` через `$?`).
  if (!/^-?\d+$/.test(code)) return undefined;
  const parsed = Number(code);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Строка-маркер, которую сервис отправляет в терминал после команды.
 *
 * `printf` подставляет код возврата вместо `%s` и печатает маркер **отдельной
 * видимой строкой**: `\n` до и после. Самостирание (`\033[2K` … `\r`) под tmux
 * до внешнего буфера не доходит (tmux применяет erase до перерисовки), поэтому
 * маркер не стирается, а вырезается из вывода для модели по nonce.
 * `\n` — escape-последовательность самого `printf` (в одинарных кавычках
 * оболочка её не трогает).
 */
export function buildRunMarkerCommand(nonce: string): string {
  return `printf '\\n${TERMINAL_RUN_MARKER_PREFIX}${nonce}:%s${TERMINAL_RUN_MARKER_END}\\n' "$?"`;
}

/** Вход запуска команды. */
export interface TerminalRunStartInput {
  /** Терминал, в котором выполняется команда. */
  terminalId: string;
  /** Сессия терминала (куда уходит уведомление о завершении). */
  sessionId?: string;
  /** Команда. */
  command: string;
  /**
   * Срок ожидания, мс.
   *
   * Срок `<= 0` — **без watchdog'а**: таймер не ставится, запуск завершает
   * только маркер команды или закрытие терминала (фоновый запуск без
   * лимита).
   */
  timeoutMs: number;
  /**
   * Запуск фоновый: завершение доставляется уведомлением в сессию.
   *
   * `false`/нет — режим с ожиданием: вызывающий получает результат сам
   * (инлайн-ответ), уведомление не отправляется.
   */
  background?: boolean;
  /**
   * По истечении watchdog'а убить команду (Ctrl+C в PTY) и освободить терминал.
   *
   * `false`/нет — прежнее поведение: статус `timeout`, терминал остаётся
   * занятым до фактического завершения команды.
   */
  killOnTimeout?: boolean;
  /**
   * Точная строка-обёртка, отправленная после команды (см. `buildRunMarkerCommand`).
   *
   * Не задана — реестр выводит её из собственного nonce (обычный случай).
   */
  wrapperCommand?: string;
}

/** Внутренняя запись реестра: снимок + промис завершения. */
interface TerminalRunEntry {
  /** Снимок запуска (только чтение наружу — копия). */
  record: TerminalRunRecord;
  /** Резолвер промиса завершения. */
  resolve: () => void;
  /** Промис завершения запуска. */
  done: Promise<void>;
  /** Таймер таймаута запуска. */
  timer: { unref?: () => void } | null;
  /**
   * Уведомление о завершении уже отправлено.
   *
   * Позднее доигрывание команды (маркер после таймаута) **не** порождает
   * второго уведомления: на запуск оно одно.
   */
  notified: boolean;
}

/** Опции реестра запусков. */
export interface TerminalRunRegistryOptions {
  /** Источник времени, мс epoch. */
  now?: () => number;
  /** Генератор id (тесты подменяют). */
  generateId?: () => string;
  /** Таймеры (тесты подменяют на fake timers). */
  timers?: TerminalTimers;
  /** Максимум записей в реестре. */
  maxRuns?: number;
  /** Максимум объёма вывода одного запуска, байт. */
  maxOutputBytes?: number;
  /** Логгер. */
  logger?: TerminalLogger;
  /**
   * Колбэк завершения запуска (любой статус: `done`/`timeout`/`exited`).
   *
   * Точка сборки уведомления — наверху (composition root): сам сервис
   * терминалов не знает, как доставлять результат в сессию. Зовётся только
   * для фоновых запусков (`background: true`) — инлайн-ответ уже ушёл.
   */
  onSettled?: (run: TerminalRunRecord) => void;
  /**
   * Колбэк «watchdog истёк, команду надо убить» (`killOnTimeout: true`).
   *
   * Зовётся **до** фиксации статуса `timeout` и **один раз** на запуск.
   * Точка входа: сервис терминалов пишет `0x03` (ETX, Ctrl+C) в PTY
   * напрямую в хэндл (без повторного прохода политики ввода). Ошибка
   * колбэка не мешает завершить запуск — терминал всё равно освобождается.
   */
  onKillTimeout?: (terminalId: string) => void;
}

/**
 * Реестр запусков команд в терминалах.
 *
 * Живёт внутри `TerminalService`: запуск — это операция над терминалом, а
 * не отдельный ресурс инстанса.
 */
export class TerminalRunRegistry {
  private readonly _runs = new Map<string, TerminalRunEntry>();
  /** Активный запуск терминала: terminalId → runId. */
  private readonly _activeByTerminal = new Map<string, string>();
  private readonly _now: () => number;
  private readonly _generateId: () => string;
  private readonly _timers: TerminalTimers;
  private readonly _maxRuns: number;
  private readonly _maxOutputBytes: number;
  private readonly _logger: TerminalLogger;
  private readonly _onSettled?: (run: TerminalRunRecord) => void;
  private readonly _onKillTimeout?: (terminalId: string) => void;

  constructor(options: TerminalRunRegistryOptions = {}) {
    this._now = options.now ?? (() => Date.now());
    this._generateId = options.generateId ?? (() => randomUUID());
    this._timers = options.timers ?? {
      setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as never),
      setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
      clearInterval: (handle) => globalThis.clearInterval(handle as never),
    };
    this._maxRuns = Math.max(1, options.maxRuns ?? MAX_STORED_RUNS);
    this._maxOutputBytes = Math.max(1, options.maxOutputBytes ?? MAX_RUN_OUTPUT_BYTES);
    this._logger = options.logger ?? {
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
    };
    if (options.onSettled) this._onSettled = options.onSettled;
    if (options.onKillTimeout) this._onKillTimeout = options.onKillTimeout;
  }

  /**
   * Зарегистрировать запуск.
   *
   * Активный запуск на терминале уже есть → `TerminalRunBusyError`: две
   * команды в одной оболочке смешали бы вывод. Занятым терминал считается,
   * пока `stillRunning` записи `true`: это `running` и `timeout` **без**
   * убийства команды (она ещё выполняется); `timeout` с убийством терминал
   * освобождает.
   */
  start(input: TerminalRunStartInput): TerminalRunRecord {
    const activeId = this._activeByTerminal.get(input.terminalId);
    if (activeId !== undefined) {
      const active = this._runs.get(activeId);
      if (active && active.record.stillRunning === true) {
        throw new TerminalRunBusyError(input.terminalId, activeId);
      }
    }

    const runId = `run_${this._generateId()}`;
    const nonce = randomUUID().replace(/-/g, '').slice(0, 16);
    const record: TerminalRunRecord = {
      runId,
      terminalId: input.terminalId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      nonce,
      command: input.command,
      status: 'running',
      background: input.background === true,
      stillRunning: true,
      wrapperCommand: input.wrapperCommand ?? buildRunMarkerCommand(nonce),
      output: '',
      startedAt: this._now(),
      timeoutMs: input.timeoutMs,
      truncated: false,
    };

    let resolve!: () => void;
    const done = new Promise<void>((res) => {
      resolve = res;
    });
    const entry: TerminalRunEntry = { record, resolve, done, timer: null, notified: false };
    this._runs.set(runId, entry);
    this._activeByTerminal.set(input.terminalId, runId);

    // Watchdog запуска: срок `<= 0` — **таймер не ставится** (запуск без
    // лимита: завершает только маркер команды или закрытие терминала).
    const timer =
      input.timeoutMs > 0
        ? this._timers.setTimeout(() => {
            if (input.killOnTimeout === true) {
              // Команду убиваем (Ctrl+C в PTY) — терминал свободен сразу.
              this._killOnTimeout(input.terminalId);
              this.settle(runId, 'timeout', { stillRunning: false });
              return;
            }
            this.settle(runId, 'timeout');
          }, input.timeoutMs)
        : null;
    timer?.unref?.();
    entry.timer = timer;

    this._prune();
    return { ...record };
  }

  /** Запись запуска (копия) или `null`. */
  get(runId: string): TerminalRunRecord | null {
    const entry = this._runs.get(runId);
    return entry ? { ...entry.record } : null;
  }

  /**
   * Дождаться завершения запуска (или истечения срока ожидания).
   *
   * Возвращает актуальный снимок: если срок ожидания истёк, а запуск ещё
   * идёт — снимок со статусом `running`.
   *
   * Срок ожидания `<= 0` — **без своего таймера**: ждём завершения запуска
   * (маркер команды или закрытие терминала). Так же трактуется watchdog
   * запуска: у запуска без срока (`timeoutMs <= 0`) таймер не ставится вовсе.
   */
  async wait(runId: string, timeoutMs: number): Promise<TerminalRunRecord | null> {
    const entry = this._runs.get(runId);
    if (!entry) return null;
    if (entry.record.status !== 'running') return { ...entry.record };

    let timer: { unref?: () => void } | null = null;
    const waits: Promise<void>[] = [entry.done];
    if (timeoutMs > 0) {
      waits.push(
        new Promise<void>((res) => {
          timer = this._timers.setTimeout(res, timeoutMs);
          timer.unref?.();
        }),
      );
    }
    await Promise.race(waits);
    if (timer) this._timers.clearTimeout(timer as never);
    return { ...entry.record };
  }

  /**
   * Обработать порцию вывода терминала.
   *
   * Текст до маркера — в вывод запуска; маркер с совпавшим nonce завершает
   * запуск (код возврата — из маркера). Маркер, пришедший **после** таймаута,
   * тоже завершает запуск (команда доиграла) — терминал освобождается, но
   * второго уведомления не будет.
   */
  handleData(terminalId: string, parts: TerminalRunMarkerPart[]): void {
    const runId = this._activeByTerminal.get(terminalId);
    if (runId === undefined) return;
    const entry = this._runs.get(runId);
    if (!entry) return;
    if (entry.record.stillRunning !== true) return;

    for (const part of parts) {
      if (part.kind === 'text') {
        this._appendOutput(entry, part.text);
        continue;
      }
      if (part.nonce === entry.record.nonce) {
        const exitCode = parseRunExitCode(part.code);
        if (exitCode !== undefined) entry.record.exitCode = exitCode;
        this.settle(runId, 'done');
        return;
      }
    }
  }

  /**
   * Завершить активный запуск терминала (терминал закрылся/умер).
   *
   * Статус `exited` — команда не завершилась, потому что терминала больше
   * нет; вывод, накопленный к этому моменту, остаётся в записи.
   */
  closeTerminal(terminalId: string): void {
    const runId = this._activeByTerminal.get(terminalId);
    if (runId === undefined) return;
    this.settle(runId, 'exited');
  }

  /**
   * Отменить запуск (статус `exited` — запуск больше не отслеживается).
   *
   * @returns `true`, если запуск был активен.
   */
  cancel(runId: string): boolean {
    const entry = this._runs.get(runId);
    if (!entry || entry.record.stillRunning !== true) return false;
    this.settle(runId, 'exited');
    return true;
  }

  /**
   * Прервать активный запуск терминала — «пользователь нажал Ctrl+C».
   *
   * В интерактивной оболочке Ctrl+C прерывает **строку**, поэтому строка-маркер
   * после прерывания не выполняется: маркер никогда не придёт, и запуск без
   * этого метода остался бы активным навсегда (`run_busy` на следующий запуск).
   *
   * Запуск завершается статусом `done` с кодом `exitCode` (по умолчанию `130` —
   * код прерывания оболочки) и `stillRunning: false`: терминал свободен.
   *
   * @returns `true`, если активный запуск был и завершён.
   */
  interrupt(terminalId: string, exitCode = 130): boolean {
    const runId = this._activeByTerminal.get(terminalId);
    if (runId === undefined) return false;
    const entry = this._runs.get(runId);
    if (!entry || entry.record.stillRunning !== true) return false;
    entry.record.exitCode = exitCode;
    this.settle(runId, 'done', { stillRunning: false });
    return true;
  }

  /** Остановить реестр (запуски завершаются статусом `exited`). */
  dispose(): void {
    for (const runId of [...this._runs.keys()]) {
      this.settle(runId, 'exited');
    }
    this._runs.clear();
    this._activeByTerminal.clear();
  }

  /**
   * Завершить запуск статусом (идемпотентно).
   *
   * Переходы: `running` → любой финальный; `timeout` → `done`/`exited`
   * (команда доиграла после истечения срока ожидания — терминал освобождается).
   * Финальные статусы (`done`/`exited`) не меняются.
   *
   * `stillRunning` записи вычисляется из статуса (`timeout` — команда ещё
   * работает), но вызывающий может переопределить его: `timeout` после
   * убийства команды (`killOnTimeout`) и `interrupt()` терминал освобождают.
   */
  private settle(
    runId: string,
    status: TerminalRunStatus,
    options: { stillRunning?: boolean } = {},
  ): void {
    const entry = this._runs.get(runId);
    if (!entry) return;
    const current = entry.record.status;
    if (current === 'done' || current === 'exited') return;
    if (current === 'timeout' && status === 'timeout') return;
    const firstSettle = current === 'running';
    entry.record.status = status;
    entry.record.stillRunning = options.stillRunning ?? status === 'timeout';
    entry.record.finishedAt = this._now();
    if (entry.timer) {
      this._timers.clearTimeout(entry.timer as never);
      entry.timer = null;
    }
    // Терминал остаётся занятым, пока команда реально выполняется: `timeout`
    // без убийства — это «срок ожидания истёк, команда продолжает работать».
    if (entry.record.stillRunning !== true) {
      if (this._activeByTerminal.get(entry.record.terminalId) === runId) {
        this._activeByTerminal.delete(entry.record.terminalId);
      }
    }
    try {
      entry.resolve();
    } catch (err) {
      this._logger.warn(
        `[TerminalRunRegistry] резолвер запуска ${runId} бросил: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // Уведомление о завершении — **после** фиксации состояния (уведомление
    // видит уже финальный статус и код возврата) и **один раз** на запуск:
    // позднее доигрывание команды второго уведомления не порождает.
    // Только фоновые запуски: у режима с ожиданием результат уже ушёл
    // инлайн-ответом, сообщение в сессию было бы дублем.
    if (this._onSettled && firstSettle && !entry.notified && entry.record.background === true) {
      entry.notified = true;
      try {
        this._onSettled({ ...entry.record });
      } catch (err) {
        this._logger.warn(
          `[TerminalRunRegistry] колбэк завершения запуска ${runId} бросил: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Позвать «убить команду по таймауту» (best-effort).
   *
   * Ошибка колбэка не мешает завершить запуск: терминал всё равно должен
   * освободиться, иначе следующий запуск получил бы вечный `run_busy`.
   */
  private _killOnTimeout(terminalId: string): void {
    if (!this._onKillTimeout) return;
    try {
      this._onKillTimeout(terminalId);
    } catch (err) {
      this._logger.warn(
        `[TerminalRunRegistry] не удалось прервать команду в терминале ${terminalId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Дописать вывод запуска (с капом объёма — сохраняется хвост). */
  private _appendOutput(entry: TerminalRunEntry, text: string): void {
    if (text === '') return;
    let output = entry.record.output + text;
    const bytes = Buffer.byteLength(output, 'utf8');
    if (bytes > this._maxOutputBytes) {
      output = tailByBytes(output, this._maxOutputBytes);
      entry.record.truncated = true;
    }
    entry.record.output = output;
  }

  /** Вытеснить старые завершённые записи (лимит реестра). */
  private _prune(): void {
    while (this._runs.size > this._maxRuns) {
      // Порядок вставки `Map` = порядок создания запусков: первый завершённый
      // запуск — самый старый.
      let removed = false;
      for (const [runId, entry] of this._runs) {
        // Занятые терминалом запуски вытеснять нельзя: команда ещё выполняется
        // (в т.ч. после таймаута без убийства) — терминал должен остаться занятым.
        if (entry.record.stillRunning === true) continue;
        this._runs.delete(runId);
        if (this._activeByTerminal.get(entry.record.terminalId) === runId) {
          this._activeByTerminal.delete(entry.record.terminalId);
        }
        removed = true;
        break;
      }
      // Активные запуски вытеснять нельзя — лимит ждёт их завершения.
      if (!removed) return;
    }
  }
}

/** Хвост текста, помещающийся в `maxBytes` байт UTF-8 (по границе символа). */
function tailByBytes(text: string, maxBytes: number): string {
  const points = Array.from(text);
  let bytes = 0;
  let start = points.length;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const size = Buffer.byteLength(points[i]!, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    start = i;
  }
  return points.slice(start).join('');
}

/** Кап вывода запуска в уведомлении, байт (32 КиБ — как у `terminal_read`). */
export const MAX_RUN_NOTIFICATION_BYTES = 32 * 1024;

/**
 * Сообщение-уведомление сессии о завершении запуска команды в терминале.
 *
 * Формат — **без XML-конверта** (у фоновых процессов конверт `<process …>`,
 * здесь вывод терминала идёт в обрамлении `[CONTENT …]` … `[CONTENT END]`):
 *
 * ```text
 * Terminal <id>: the command finished (exit 0)
 * [CONTENT terminal=term_1 run=run_1 status=done exit=0]
 * …вывод команды…
 * [CONTENT END]
 * ```
 *
 * Метаданные запуска — в **открывающем** маркере (`[CONTENT key=value …]`,
 * закрывающий маркер не меняется). Тело экранируется
 * (`escapeContentMarkers`): `[CONTENT END]` из вывода команды конверт не
 * закрывает.
 *
 * Сообщение — **роль USER** (его видит модель), автор `Process` (как у
 * фоновых шелл-процессов): результат фоновой работы должен попасть в
 * контекст сессии. Метаданные — те же метки, что у фонового процесса
 * (`type: 'background_run_result'`, `state`, `command`, `exit_code`,
 * `started_at`/`finished_at`/длительность), плюс `terminal_id`/`run_id`.
 */
export function buildTerminalRunNotification(run: TerminalRunRecord): Message {
  const terminalId = run.terminalId;
  const exitCode = run.exitCode !== undefined ? String(run.exitCode) : '-';
  // Терминал занят только пока команда реально выполняется: `timeout` после
  // убийства (`killOnTimeout`) и `interrupt()` — уже свободен.
  const stillRunning = run.stillRunning === true;
  const header =
    run.status === 'timeout'
      ? sm('terminal.tool.run_timeout', {
          terminal_id: terminalId,
          timeout: String(msToTimeoutSec(run.timeoutMs)),
        })
      : run.status === 'exited'
        ? sm('terminal.tool.run_exited', { terminal_id: terminalId })
        : sm('terminal.tool.run_finished', { terminal_id: terminalId, exit_code: exitCode });
  // Таймаут **без** убийства команды: она продолжает выполняться в PTY, а
  // терминал остаётся занятым — об этом сказано прямо (иначе модель решит,
  // что команда снята, и запустит вторую в занятый терминал).
  const stillRunningNote = stillRunning
    ? sm('terminal.tool.run_still_running', {
        run_id: run.runId,
        terminal_id: terminalId,
      })
    : '';
  // Тот же вид вывода, что у инлайн-ответа: без ANSI и без эха обёртки.
  const cleaned = cleanRunOutput(run.output, run.wrapperCommand, run.nonce);
  const body = formatBackgroundContent(tailByBytes(cleaned, MAX_RUN_NOTIFICATION_BYTES), {
    terminal: terminalId,
    run: run.runId,
    status: run.status,
    ...(run.exitCode !== undefined ? { exit: run.exitCode } : {}),
    ...(run.status === 'timeout' ? { timeout: msToTimeoutSec(run.timeoutMs) } : {}),
    ...(stillRunning ? { still_running: true } : {}),
  });
  const content = [header, stillRunningNote, body].filter((part) => part !== '').join('\n');
  const durationMs =
    run.finishedAt !== undefined ? Math.max(0, run.finishedAt - run.startedAt) : undefined;
  return {
    id: generateMessageId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ephemeral: false,
    author: 'Process',
    metadata: {
      type: 'background_run_result',
      kind: 'terminal',
      terminal_id: terminalId,
      run_id: run.runId,
      state: run.status,
      ...(stillRunning ? { still_running: true } : {}),
      ...(run.command ? { command: run.command } : {}),
      ...(run.exitCode !== undefined ? { exit_code: run.exitCode } : {}),
      started_at: run.startedAt,
      ...(run.finishedAt !== undefined ? { finished_at: run.finishedAt } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    },
  };
}

/**
 * В терминале уже идёт другой запуск.
 *
 * Отдельный тип (не `TerminalLimitError`): ограничение не числовое, а
 * состояние терминала — «дождись текущего запуска».
 */
export class TerminalRunBusyError extends Error {
  /** Терминал, в котором уже идёт запуск. */
  readonly terminalId: string;
  /** Идентификатор активного запуска. */
  readonly activeRunId: string;

  constructor(terminalId: string, activeRunId: string) {
    super(`Терминал ${terminalId}: уже идёт запуск ${activeRunId}`);
    this.name = 'TerminalRunBusyError';
    this.terminalId = terminalId;
    this.activeRunId = activeRunId;
  }
}

/** Структурная проверка ошибки занятости (устойчива к копиям класса). */
export function isTerminalRunBusyError(value: unknown): value is TerminalRunBusyError {
  if (value instanceof TerminalRunBusyError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const e = value as { name?: unknown; terminalId?: unknown; activeRunId?: unknown };
  return (
    e.name === 'TerminalRunBusyError' &&
    typeof e.terminalId === 'string' &&
    typeof e.activeRunId === 'string'
  );
}
