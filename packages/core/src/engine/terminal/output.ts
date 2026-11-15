/**
 * Обрамление и нормализация вывода терминала для модели (PROP-132, Ф5).
 *
 * ## Зачем
 *
 * Весь вывод терминала, который возвращается модели, обязан быть:
 *
 * - **в обрамлении** — `[CONTENT]` … `[CONTENT END]`. Обрамление — константы,
 *   не i18n: это маркер протокола, а не переводимый текст (ADR-041 — про
 *   строки движка; маркер протокола переводить нельзя);
 * - **с метаданными в открывающем маркере** — `[CONTENT key=value …]`.
 *   Метаданные (id терминала, статус, диапазон последовательностей, код
 *   возврата) читаются прямо из маркера: закрывающий маркер **не меняется**
 *   (`[CONTENT END]`), поэтому разбор вывода остаётся прежним;
 * - **без хвостовых пустых строк** — «вывод в конце пуст» читается как
 *   «вывод не пришёл»;
 * - **с нормализованными переводами строк** — `\r\n` → `\n`. PTY отдаёт
 *   `\r\n` (режим терминала ONLCR), а модель не должна различать «CRLF» и
 *   «LF».
 *
 * ## Очистка вывода запуска
 *
 * Вывод команды, ушедшей в интерактивную оболочку, содержит служебный шум:
 * ANSI-последовательности, эхо введённой строки-обёртки (маркер печатается
 * `printf`-ом, но **сама строка** эхом PTY попадает в поток), строка-маркер
 * `@@srn-<nonce>:<код>@@` и её обрывки, прогресс-вывод с `\r`. Для модели это
 * мусор, поэтому `cleanRunOutput` прогоняет текст через `stripTerminalAnsi` →
 * `removeRunWrapper` → `normalizeTerminalOutput` — **тот же** вид, что у
 * инлайн-ответа `terminal_run` и у уведомления о завершении фонового запуска.
 *
 * ## Границы
 *
 * - **Нормализация — только для возвращаемого текста.** Кольцевой буфер
 *   хранит поток как есть: буфер — источник истины для UI (xterm.js сам
 *   разбирает `\r\n`), и переписывать его значило бы ломать отображение.
 * - **Одиночный `\r` не трогаем** — это «возврат каретки» прогрес-вывода
 *   (`\r` перезаписывает строку), а не перевод строки.
 * - **Эхо обёртки снимается сравнением строки, а не подстроки.** У маркера
 *   уникальный nonce, поэтому «похожие» строки (например, вывод `cat`
 *   исходника) не трогаются: удаляется строка, `trim()` которой равен
 *   команде-обёртке, — или заканчивается ею (промпт оболочки печатается в той
 *   же строке, что и эхо ввода).
 * - **Строка-маркер снимается по nonce** (`@@srn-<nonce>:<код>@@`), а не по
 *   «похожести»: удаляется и полный маркер, и обрывок без закрывающих `@@`
 *   (маркер мог разорваться выводом команды). Nonce берётся из записи запуска
 *   (`cleanRunOutput(..., nonce)`) либо выводится из команды-обёртки.
 */

/** Маркер начала обрамления вывода терминала. */
export const TERMINAL_CONTENT_OPEN = '[CONTENT]';

/**
 * Префикс открывающего маркера — основа формы с атрибутами
 * (`[CONTENT key=value …]`).
 */
const TERMINAL_CONTENT_OPEN_PREFIX = '[CONTENT';

/** Маркер конца обрамления вывода терминала. */
export const TERMINAL_CONTENT_CLOSE = '[CONTENT END]';

/**
 * Префикс маркера завершения запуска команды (PROP-132, Ф5).
 *
 * Маркер — **текстовая строка** `@@srn-<nonce>:<код>@@`, а не OSC
 * (`ESC ] 7770 ; …`): мультиплексоры и TUI (tmux, а также tmux под ssh)
 * перехватывают OSC себе и наружу его не пропускают — маркер не доходил до
 * нашего буфера, запуск висел до таймаута, а терминал оставался занятым
 * (`run_busy`). Текстовая строка проходит через любой мультиплексор.
 *
 * `printf` печатает строку отдельной строкой (`\n` до и после); самостирание
 * (`\033[2K` + `\r`) не используется — под tmux такой маркер до внешнего
 * буфера не доходит. Строку вырезают сканер (`scanRunMarkers`) и очистка
 * вывода (`removeRunWrapper`).
 */
export const TERMINAL_RUN_MARKER_PREFIX = '@@srn-';

/** Закрывающая часть маркера завершения запуска (`@@srn-<nonce>:<код>@@`). */
export const TERMINAL_RUN_MARKER_END = '@@';

/**
 * Nonce запуска в команде-обёртке (`printf '…@@srn-<nonce>:%s@@…' "$?"`).
 *
 * Нужен очистке вывода: строку-маркер и её обрывки снимаем **по nonce**, а не
 * по «похожим» строкам.
 */
const RUN_MARKER_NONCE_PATTERN = /@@srn-([A-Za-z0-9_-]+):/;

/**
 * Максимальная длина значения атрибута открывающего маркера.
 *
 * Значение длиннее — обрезается: маркер читает модель, а не парсер, и
 * «хвост» из сотен символов ничего не добавляет.
 */
export const MAX_TERMINAL_ATTRIBUTE_VALUE_LENGTH = 120;

/**
 * Значение атрибута открывающего маркера `[CONTENT …]`.
 *
 * `undefined` — атрибут не выводится вовсе (нет значения — нет и атрибута).
 */
export type TerminalContentAttributeValue = string | number | boolean | undefined;

/**
 * Санитизировать значение атрибута маркера.
 *
 * В значении не должно быть:
 *
 * - **переводов строк** — маркер однострочный, иначе он «разорвал» бы
 *   обрамление;
 * - **пробелов** — атрибуты разделены пробелом, пробел внутри значения сделал
 *   бы разбор неоднозначным;
 * - **`]`** — закрывающая скобка маркера: значение не должно закрывать его
 *   досрочно.
 *
 * Плюс кап длины (`MAX_TERMINAL_ATTRIBUTE_VALUE_LENGTH`).
 */
function sanitizeAttributeValue(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/\]/g, '')
    .slice(0, MAX_TERMINAL_ATTRIBUTE_VALUE_LENGTH);
}

/**
 * Собрать строку атрибутов открывающего маркера: `key=value key2=value2`.
 *
 * - атрибут без значения (`undefined`) **не выводится**;
 * - значение санитизируется (см. `sanitizeAttributeValue`);
 * - пустое значение после санитизации — атрибут не выводится;
 * - порядок атрибутов — порядок ключей объекта (детерминированный).
 *
 * Пустой результат — «без атрибутов»: маркер остаётся прежним `[CONTENT]`.
 */
export function formatTerminalContentAttributes(
  attributes?: Record<string, TerminalContentAttributeValue>,
): string {
  if (!attributes) return '';
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(attributes)) {
    if (raw === undefined) continue;
    const safeKey = key.replace(/[^A-Za-z0-9_.-]/g, '_');
    if (safeKey === '') continue;
    const value = sanitizeAttributeValue(typeof raw === 'string' ? raw : String(raw));
    if (value === '') continue;
    parts.push(`${safeKey}=${value}`);
  }
  return parts.join(' ');
}

/**
 * Нормализовать переводы строк вывода терминала (`\r\n` → `\n`).
 *
 * Только для возвращаемого текста: буфер хранит поток как есть (UI/xterm.js
 * разбирает `\r\n` сам). Одиночный `\r` не трогаем — это «возврат каретки»
 * прогрес-вывода, а не перевод строки.
 */
export function normalizeTerminalLineEndings(text: string): string {
  if (text === '') return '';
  return text.replace(/\r\n/g, '\n');
}

/**
 * Нормализовать текст вывода терминала для модели.
 *
 * - `\r\n` → `\n` (только для возвращаемого текста — буфер не трогаем);
 * - хвостовые пустые строки отбрасываются (строка из одних пробелов/табуляций
 *   тоже считается пустой).
 *
 * Хвостовой перевод строки убирается вместе с пустой строкой за ним:
 * `'a\nb\n'` → `'a\nb'` (та же трактовка, что у `tail` в `terminal_read`).
 */
export function normalizeTerminalOutput(text: string): string {
  if (text === '') return '';
  const normalized = normalizeTerminalLineEndings(text);
  return normalized.replace(/(?:\n[ \t]*)+$/, '');
}

/** ESC — начало escape-последовательности. */
const ESC = '\u001B';

/** BEL — завершает OSC-строку. */
const BEL = '\u0007';

/** CSI в 8-битном виде. */
const CSI_8BIT = '\u009B';

/** ST в 8-битном виде — второй вариант завершения OSC. */
const ST_8BIT = '\u009C';

/**
 * Однобайтовые ESC-последовательности (ESC + одиночный финальный символ).
 *
 * TUI (`htop`, `top`, `mc`, `watch`) сыплет ими в поток: `ESC =` / `ESC >`
 * (keypad), `ESC 7` / `ESC 8` (save/restore курсора), `ESC M` / `ESC D` /
 * `ESC E` / `ESC H` (правка строк), `ESC c` (сброс), `ESC \` (ST).
 */
const ESC_SINGLE_BYTE_FINALS = new Set([
  '=', // DECKPAM — keypad в «прикладной» режим
  '>', // DECKPNM — keypad в цифровой режим
  '7', // DECSC — сохранить курсор
  '8', // DECRC — восстановить курсор
  'M', // RI — обратный перевод строки (удаление строки)
  'D', // IND — перевод строки вниз
  'E', // NEL — next line
  'H', // HTS — установка табуляции
  'c', // RIS — полный сброс терминала
  '\\', // ST — завершитель строки (вне OSC)
]);

/**
 * Вводные символы выбора набора символов (`ESC ( B`, `ESC ) 0`, `ESC * A`, …).
 *
 * За ними идёт **ещё один** байт — обозначение набора: без него одиночная
 * буква оставалась в тексте (`ESC ( B` → `B`).
 */
const ESC_CHARSET_INTRODUCERS = new Set(['(', ')', '*', '+', '-', '.', '/']);

/**
 * Single-shift (SS2/SS3): `ESC N <символ>` / `ESC O <символ>` — сдвиг на один
 * символ, за ними тоже идёт байт.
 */
const ESC_SINGLE_SHIFT = new Set(['N', 'O']);

/**
 * «Широкая» вставка пробелов (рамки powerline и т.п.).
 *
 * Подряд **больше 40** пробелов внутри строки схлопываются в один пробел:
 * такие вставки не несут смысла, а только раздувают вывод.
 */
const WIDE_SPACE_RUN_PATTERN = / {41,}/g;

/**
 * Конец OSC-строки (после `ESC ]`): BEL или ST (`ESC \`).
 *
 * Незавершённая OSC-строка съедает остаток потока — как в терминале: иначе в
 * вывод попал бы мусор служебной строки.
 */
function skipOsc(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === BEL) return i + 1;
    if (ch === ST_8BIT) return i + 1;
    if (ch === ESC && text[i + 1] === '\\') return i + 2;
  }
  return text.length;
}

/** Конец CSI-последовательности (после `ESC [`): финальный байт 0x40…0x7E. */
function skipCsi(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
  }
  return text.length;
}

/**
 * Вырезать escape-последовательности из текста.
 *
 * - **OSC** (`ESC ] …`) вырезается **целиком** — до BEL или ST: в потоке
 *   терминала это служебные строки (заголовок окна `ESC ] 3008 ; …` и прочие),
 *   которые модели видеть не нужно;
 * - **CSI** (`ESC [ …`) вырезается целиком (цвета/позиционирование);
 * - **однобайтовые ESC-последовательности** (TUI-шум `htop`/`top`/`mc`/`watch`)
 *   вырезаются целиком: `ESC =` / `ESC >` (keypad), `ESC 7` / `ESC 8`
 *   (save/restore), `ESC M` / `ESC D` / `ESC E` / `ESC H` / `ESC c`,
 *   `ESC ( B` / `ESC ) 0` и прочие выборы charset (вводный символ + **один**
 *   байт обозначения набора), `ESC N <символ>` / `ESC O <символ>` (SS2/SS3).
 *
 * Одиночный `ESC` перед **обычным** символом вырезается только сам по себе:
 * остальной текст не съедается — неизвестная последовательность не должна
 * «съесть» первую букву следующего слова.
 */
function stripEscapeSequences(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ESC) {
      const next = text[i + 1];
      if (next === ']') {
        i = skipOsc(text, i + 2);
        continue;
      }
      if (next === '[') {
        i = skipCsi(text, i + 2);
        continue;
      }
      // Выбор charset и SS2/SS3: ESC + вводный символ + байт обозначения.
      if (next !== undefined && (ESC_CHARSET_INTRODUCERS.has(next) || ESC_SINGLE_SHIFT.has(next))) {
        i += text[i + 2] === undefined ? 2 : 3;
        continue;
      }
      if (next !== undefined && ESC_SINGLE_BYTE_FINALS.has(next)) {
        i += 2;
        continue;
      }
      // Неизвестная последовательность: убираем только сам ESC, следующий
      // символ — обычный текст.
      i += 1;
      continue;
    }
    if (ch === CSI_8BIT) {
      i = skipCsi(text, i + 1);
      continue;
    }
    if (ch === ST_8BIT) {
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Нормализовать управляющие символы: backspace и «возврат каретки».
 *
 * - `X\b` — backspace удаляет предыдущий символ; `\b` в начале — ничего
 *   (удалять нечего);
 * - одиночный `\r` (не часть `\r\n`) вырезается: в плоском тексте «возврат
 *   каретки» ничего не значит, а в потоке терминала он приходит от
 *   прогресс-вывода и портит читаемость.
 */
function normalizeControlChars(text: string): string {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch === '\b') {
      if (out.length > 0) out.pop();
      continue;
    }
    if (ch === '\r') {
      // `\r\n` — обычный перевод строки (сохраняем), одиночный `\r` — нет.
      if (chars[i + 1] === '\n') out.push('\r');
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

/**
 * Убрать из вывода терминала управляющие последовательности и привести его к
 * читаемому виду.
 *
 * Вырезаются: escape-последовательности (CSI/OSC и однобайтовые ESC-шум
 * TUI — **целиком**, OSC до BEL/ST), действие backspace (`X\b` → удалить
 * символ), одиночный `\r`; «широкие» вставки пробелов (подряд больше 40)
 * схлопываются в один пробел.
 */
export function stripTerminalAnsi(text: string): string {
  if (text === '') return '';
  const withoutSequences = stripEscapeSequences(text);
  const normalized = normalizeControlChars(withoutSequences);
  return normalized.replace(WIDE_SPACE_RUN_PATTERN, ' ');
}

/**
 * Nonce запуска из команды-обёртки (`null` — маркера в ней нет).
 *
 * Формат обёртки — `printf '\n@@srn-<nonce>:%s@@\n' "$?"`.
 */
function runMarkerNonceOf(wrapperCommand: string): string | null {
  const match = RUN_MARKER_NONCE_PATTERN.exec(wrapperCommand);
  return match ? (match[1] ?? null) : null;
}

/**
 * Строка — маркер запуска или его обрывок (сравнение **по nonce**).
 *
 * Учитываются три вида:
 *
 * - полный маркер `@@srn-<nonce>:<код>@@`;
 * - обрывок без закрывающих `@@` (`@@srn-<nonce>:<код>`);
 * - обрывок, оборванный внутри `<nonce>:` (`@@srn-<nonce>`).
 *
 * Escape-последовательности и `\r` перед маркером (CSI от оболочки/мультиплексора)
 * не мешают: они срезаются до сравнения. Чужой nonce — не наш маркер: строка
 * остаётся (поэтому «похожие» строки вывода не трогаются).
 */
function isRunMarkerLine(line: string, nonce: string): boolean {
  const core = stripEscapeSequences(line).replace(/\r/g, '').trim();
  if (!core.startsWith(TERMINAL_RUN_MARKER_PREFIX)) return false;
  const rest = core.slice(TERMINAL_RUN_MARKER_PREFIX.length);
  const head = `${nonce}:`;
  // Полный маркер/обрывок после nonce либо обрывок внутри `<nonce>:`.
  return rest.startsWith(head) || head.startsWith(rest);
}

/**
 * Убрать из вывода эхо служебной строки-обёртки запуска и строку-маркер.
 *
 * `wrapperCommand` — строка, которую сервис отправил после команды. PTY
 * эхом возвращает её в поток, и без очистки она видна модели. `nonce` —
 * nonce запуска: по нему снимается строка-маркер `@@srn-<nonce>:<код>@@` и её
 * обрывки; не задан — выводится из команды-обёртки.
 *
 * Сравнение эха — построчно, по `trim()` строки: удаляется строка, которая либо
 * **целиком** равна команде-обёртке, либо **заканчивается** ею (оболочка
 * печатает промпт в той же строке, что и эхо ввода: `user@host:~$ printf '…'`).
 * У маркера уникальный nonce, поэтому «похожие» строки (вывод `cat`, примеры
 * в тексте) не трогаются: совпасть с обёрткой может только её собственное эхо.
 * Пустая команда-обёртка без маркера — очистка не выполняется.
 */
export function removeRunWrapper(
  text: string,
  wrapperCommand: string,
  nonce?: string,
): string {
  if (text === '') return text;
  const needle = wrapperCommand.trim();
  const markerNonce = nonce ?? (needle === '' ? null : runMarkerNonceOf(needle));
  if (needle === '' && markerNonce === null) return text;
  const hasWrapperEcho = needle !== '' && text.includes(needle);
  if (!hasWrapperEcho && markerNonce === null) return text;
  return text
    .split('\n')
    .filter((line) => {
      if (markerNonce !== null && isRunMarkerLine(line, markerNonce)) return false;
      if (!hasWrapperEcho) return true;
      const trimmed = line.trim();
      if (trimmed === needle) return false;
      return !trimmed.endsWith(needle);
    })
    .join('\n');
}

/**
 * Полная очистка вывода запуска для модели.
 *
 * Порядок: `stripTerminalAnsi` (ANSI/OSC/backspace/`\r`/широкие пробелы) →
 * `removeRunWrapper` (эхо обёртки и строка-маркер по nonce) →
 * `normalizeTerminalOutput` (`\r\n` → `\n`, хвостовые пустые строки). Тот же
 * вид, что у инлайн-ответа и уведомления о завершении фонового запуска.
 */
export function cleanRunOutput(text: string, wrapperCommand?: string, nonce?: string): string {
  const stripped = stripTerminalAnsi(text);
  const withoutWrapper =
    (wrapperCommand !== undefined && wrapperCommand !== '') || nonce !== undefined
      ? removeRunWrapper(stripped, wrapperCommand ?? '', nonce)
      : stripped;
  return normalizeTerminalOutput(withoutWrapper);
}

/**
 * Обрамить вывод терминала для модели.
 *
 * Пустой вывод → `[CONTENT]\n[CONTENT END]` (без пустой строки между
 * маркерами): иначе модель читает «пустую строку вывода» как результат.
 *
 * С атрибутами — открывающий маркер становится `[CONTENT key=value …]`
 * (метаданные — в маркере, закрывающий маркер не меняется). Без атрибутов
 * (или с пустым набором) — прежний вид `[CONTENT]`.
 */
export function frameTerminalOutput(
  text: string,
  attributes?: Record<string, TerminalContentAttributeValue>,
): string {
  const body = normalizeTerminalOutput(text);
  const attrs = formatTerminalContentAttributes(attributes);
  const open =
    attrs === '' ? TERMINAL_CONTENT_OPEN : `${TERMINAL_CONTENT_OPEN_PREFIX} ${attrs}]`;
  if (body === '') return `${open}\n${TERMINAL_CONTENT_CLOSE}`;
  return `${open}\n${body}\n${TERMINAL_CONTENT_CLOSE}`;
}
