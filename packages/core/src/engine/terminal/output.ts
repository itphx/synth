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
 * ## Кто ставит конверт
 *
 * Сам **тул** вывода не обрамляет: `terminal_read`/`terminal_snapshot`/
 * `terminal_run` возвращают модели **сырой нормализованный текст**, а атрибуты
 * (id терминала, статус, объём, код возврата) кладут в `metadata` результата —
 * общий конверт `[CONTENT | …]` ставит runtime (`applyToolContentFilter`,
 * матрица доверия `engine/security/trust.ts`, источник `terminal`,
 * `trust: untrusted`). Здесь остаётся конверт **не результатов тулов**:
 * уведомление о завершении фонового запуска (`runs.ts`) и контекст терминала
 * в промпте (`context-message.ts`) — служебные сообщения, они не проходят через
 * IPI-обёртку. Тело конверта экранируется (`escapeContentMarkers`): вывод
 * терминала не должен «закрыть» блок поддельным `[CONTENT END]`.
 *
 * ## Границы
 *
 * - **Нормализация — только для возвращаемого текста.** Кольцевой буфер
 *   хранит поток как есть: буфер — источник истины для UI (xterm.js сам
 *   разбирает `\r\n`), и переписывать его значило бы ломать отображение.
 * - **Одиночный `\r` не трогаем** — это «возврат каретки» прогрес-вывода
 *   (`\r` перезаписывает строку), а не перевод строки.
 * - **Эхо обёртки снимается по тексту команды с допуском переносов и шума.** У
 *   маркера уникальный nonce, поэтому «похожие» строки (например, вывод `cat`
 *   исходника) не трогаются: удаляется **вся** логическая строка — prompt
 *   оболочки перед командой и само эхо. PTY/оболочка переносит длинную
 *   введённую строку по ширине терминала, поэтому эхо может разорваться в любом
 *   месте (включая середину `@@srn-<nonce>`). При **узком** терминале zsh не
 *   просто переносит строку, а **перерисовывает** её: внутрь команды попадают
 *   `\r`, `ESC[K`, escape-последовательности и повтор первого символа после
 *   перерисовки (`a0 \r ESC[K 6 \r 6:%s`), а само эхо встречается дважды —
 *   эхо набранных строк и перерисовка у приглашения. Поэтому между символами
 *   команды допускается служебный шум (пробелы, `\b`, `\a`, CSI, OSC, выбор
 *   charset, keypad, save/restore), а **повтор символа** через такой шум
 *   считается тем же символом; снимаются все вхождения.
 * - **Строка-маркер снимается по nonce** (`@@srn-<nonce>:<код>@@`), а не по
 *   «похожести»: удаляется и полный маркер, и обрывок без закрывающих `@@`
 *   (маркер мог разорваться выводом команды). Nonce берётся из записи запуска
 *   (`cleanRunOutput(..., nonce)`) либо выводится из команды-обёртки.
 */
import { escapeContentMarkers } from '../security/prompt-injection.js';

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
 *
 * Экспортируется: тем же санитайзером пользуется матрица доверия
 * (`engine/security/trust.ts`), переносящая атрибуты маркера в `metadata`
 * результата тула.
 */
export function sanitizeTerminalAttributeValue(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/\]/g, '')
    .slice(0, MAX_TERMINAL_ATTRIBUTE_VALUE_LENGTH);
}

/**
 * Собрать строку атрибутов открывающего маркера: `key=value key2=value2`.
 *
 * - атрибут без значения (`undefined`) **не выводится**;
 * - значение санитизируется (см. `sanitizeTerminalAttributeValue`);
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
    const value = sanitizeTerminalAttributeValue(typeof raw === 'string' ? raw : String(raw));
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
 * Экранировать один символ для использования в регулярном выражении.
 */
function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Служебный шум в потоке терминала: пробельные символы, `\b`/`\a` и
 * escape-последовательности.
 *
 * Набор нужен шаблону эха обёртки: zsh при перерисовке перенесённой строки
 * вставляет внутрь команды `\r`, `ESC[K` и прочие последовательности, поэтому
 * «шум» стоит между любыми двумя символами эха. `\s` включает перевод строки —
 * так снимается и эхо, разорванное переносом по ширине терминала.
 */
const RUN_ECHO_NOISE =
  '(?:\\s|\\x08|\\x07'
  + '|\\x1b\\[[0-9;?]*[ -/]*[@-~]' // CSI (цвета, `ESC[K`, позиционирование)
  + '|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)' // OSC до BEL или ST
  + '|\\x1b[()][A-Za-z0-9]' // выбор charset: `ESC ( B`
  + '|\\x1b[=>]' // keypad: `ESC =` / `ESC >`
  + '|\\x1b[78])'; // save/restore курсора

/**
 * Тот же шум без переводов строк — для хвоста совпадения.
 *
 * Хвост ограничен **горизонтальным** шумом: иначе жадный `RUN_ECHO_NOISE*`
 * съел бы пустую строку после эха (старая семантика — только `[ \t]*\r?`).
 */
const RUN_ECHO_LINE_NOISE =
  '(?:[^\\S\\n]|\\x08|\\x07'
  + '|\\x1b\\[[0-9;?]*[ -/]*[@-~]'
  + '|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)'
  + '|\\x1b[()][A-Za-z0-9]'
  + '|\\x1b[=>]'
  + '|\\x1b[78])';

/**
 * Сколько раз символ эха может повториться через шум.
 *
 * Перерисовка перенесённой строки повторяет символ один раз (`6\r6`), реже —
 * два; предел нужен, чтобы регулярное выражение не уходило в
 * катастрофический бэктрекинг: без предела строка вывода из длинных серий
 * одного символа (`p p p …`) обрабатывается ~600 мс на 1 МиБ вместо ~70 мс
 * (замер на синтетических 1 МиБ).
 */
const MAX_RUN_ECHO_CHAR_REPEATS = 4;

/**
 * Длина фрагмента команды-обёртки для быстрой предварительной проверки.
 *
 * Перенос/перерисовка рвёт эхо в произвольном месте, поэтому проверять наличие
 * эха целиком (`text.includes`) нельзя. Но чтобы шаблон не сработал ни разу,
 * разрыв должен попасть **внутрь каждого** 8-символьного окна команды —
 * на реальной ширине терминала (перенос раз в строку) это невозможно.
 */
const RUN_ECHO_GUARD_FRAGMENT = 8;

/**
 * Есть ли в тексте хоть один целый фрагмент команды-обёртки.
 *
 * Быстрый guard перед регулярным выражением: `includes` по 1 МиБ — доли
 * миллисекунды, шаблон эха — ~7 мс на 1 МиБ обычного вывода. Ложное
 * срабатывание безвредно (шаблон просто ничего не найдёт), а пропуск возможен
 * только если перенос попал внутрь всех 8-символьных окон сразу.
 */
function hasRunWrapperEcho(text: string, wrapperCommand: string): boolean {
  if (wrapperCommand.length <= RUN_ECHO_GUARD_FRAGMENT) {
    return text.includes(wrapperCommand);
  }
  for (
    let i = 0;
    i + RUN_ECHO_GUARD_FRAGMENT <= wrapperCommand.length;
    i += RUN_ECHO_GUARD_FRAGMENT
  ) {
    if (text.includes(wrapperCommand.slice(i, i + RUN_ECHO_GUARD_FRAGMENT))) return true;
  }
  return text.includes(wrapperCommand.slice(-RUN_ECHO_GUARD_FRAGMENT));
}

/**
 * Регулярное выражение эха команды-обёртки, устойчивое к переносу и перерисовке.
 *
 * PTY/оболочка переносит длинную введённую строку по ширине терминала, а zsh на
 * узком терминале ещё и **перерисовывает** её: внутрь команды попадают `\r`,
 * `ESC[K` и прочие последовательности, а символ после перерисовки повторяется
 * (`…a0 \r ESC[K 6\r6:%s…`). Поэтому:
 *
 * - между разными символами команды допускается шум (`RUN_ECHO_NOISE*`);
 * - каждый символ может повториться через шум (`c(?:шум*c){0,4}`) — так
 *   снимается дубль, вставленный перерисовкой;
 * - совпадение начинается с начала **логической** строки (`^`/`\n`): перед
 *   командой может стоять prompt оболочки — он снимается вместе с эхом;
 * - хвост — только горизонтальный шум: «похожая» строка вывода
 *   (`<обёртка>.bak`) не трогается.
 *
 * Перенос строки после эха тоже входит в совпадение, а ведущий `\n` (если он
 * был) сохраняется группой — поэтому удаление не оставляет пустой строки.
 * `nonce` уникален: совпасть с обёрткой может только её собственное эхо, а
 * все вхождения (эхо набранных строк и перерисовка у приглашения) снимаются
 * одной заменой.
 */
function runWrapperEchoPattern(wrapperCommand: string): RegExp {
  const token = (ch: string): string => {
    const escaped = escapeRegExpChar(ch);
    return `${escaped}(?:${RUN_ECHO_NOISE}*${escaped}){0,${MAX_RUN_ECHO_CHAR_REPEATS}}`;
  };
  const body = Array.from(wrapperCommand).map(token).join(`${RUN_ECHO_NOISE}*`);
  return new RegExp(
    `(^|\\n)[^\\n]*?${body}${RUN_ECHO_LINE_NOISE}*(?=\\n|$)\\n?`,
    'gm',
  );
}

/**
 * Убрать из вывода эхо служебной строки-обёртки запуска и строку-маркер.
 *
 * `wrapperCommand` — строка, которую сервис отправил после команды. PTY
 * эхом возвращает её в поток, и без очистки она видна модели. `nonce` —
 * nonce запуска: по нему снимается строка-маркер `@@srn-<nonce>:<код>@@` и её
 * обрывки; не задан — выводится из команды-обёртки.
 *
 * Удаляется **вся** строка с эхом: prompt оболочки перед командой (`user@host:~$`)
 * и сама команда, даже если PTY разорвал её переносом по ширине терминала или
 * zsh перерисовал её, вставив внутрь `\r`/`ESC[K` и дубль символа (шум между
 * символами и повтор символа — часть шаблона; снимаются все вхождения).
 * У маркера уникальный nonce, поэтому «похожие» строки (вывод `cat`, примеры
 * в тексте, `<обёртка>.bak`) не трогаются: совпасть с обёрткой может только её
 * собственное эхо. Пустая команда-обёртка без маркера — очистка не выполняется.
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
  // Эхо могло перенестись — `text.includes(needle)` тут не индикатор: шаблон
  // допускает шум (в т.ч. `\r`/`ESC[K` и дубли символов) между символами
  // команды. Быстрый guard по целым фрагментам отсекает текст, где эха нет
  // вовсе: шаблон по 1 МиБ стоит ~7 мс, `includes` — доли миллисекунды.
  const withoutEcho =
    needle === '' || !hasRunWrapperEcho(text, needle)
      ? text
      : text.replace(runWrapperEchoPattern(needle), '$1');
  if (markerNonce === null) return withoutEcho;
  return withoutEcho
    .split('\n')
    .filter((line) => !isRunMarkerLine(line, markerNonce))
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
 * Обрамить вывод терминала для служебных сообщений (не результатов тулов).
 *
 * Используется уведомлением о завершении фонового запуска (`runs.ts`) и
 * контекстом терминала в промпте (`context-message.ts`): это не результаты
 * тулов, общий конверт IPI (`[CONTENT | …]`) к ним не применяется — здесь свой
 * маркер `[CONTENT key=value …]`.
 *
 * Тело **экранируется** (`escapeContentMarkers`): вывод терминала может
 * содержать строку `[CONTENT END]` (эхо файла/команды) — без экранирования она
 * закрыла бы конверт раньше времени, и остаток вывода модель прочитала бы как
 * инструкцию вне блока данных.
 *
 * Пустой вывод → `[CONTENT]\n[CONTENT END]` (без пустой строки между
 * маркерами): иначе модель читает «пустую строку вывода» как результат.
 *
 * С атрибутами — открывающий маркер становится `[CONTENT key=value …]`
 * (метаданные — в маркере, закрывающий маркер не меняется). Без атрибутов
 * (или с пустым набором) — прежний вид `[CONTENT]`.
 */
export function formatBackgroundContent(
  text: string,
  attributes?: Record<string, TerminalContentAttributeValue>,
): string {
  const body = escapeContentMarkers(normalizeTerminalOutput(text)).content;
  const attrs = formatTerminalContentAttributes(attributes);
  const open =
    attrs === '' ? TERMINAL_CONTENT_OPEN : `${TERMINAL_CONTENT_OPEN_PREFIX} ${attrs}]`;
  if (body === '') return `${open}\n${TERMINAL_CONTENT_CLOSE}`;
  return `${open}\n${body}\n${TERMINAL_CONTENT_CLOSE}`;
}

/**
 * Прежнее имя `formatBackgroundContent`.
 *
 * @deprecated Конверт ставят только служебные сообщения (фон/контекст);
 *   результаты терминальных тулов обрамляет runtime (`applyToolContentFilter`).
 */
export const frameTerminalOutput = formatBackgroundContent;
