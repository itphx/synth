/**
 * PROP-126 §0/§2: общий **core-парсер префиксов ввода** — `@` (упоминания),
 * `$` (скиллы), `#` (сниппеты).
 *
 * Зачем: текущий `@`-парсер агентский и уже неоднозначен — регулярка
 * `@(\w+)` (UI: `packages/ui/src/components/chat/ChatInput.tsx`) даёт тег `src`
 * для `@src/index.ts` и тег `b` для `a@b.com`. PROP-126 §0 требует **один**
 * парсер в core, чтобы UI, CLI, гибрид и шлюзы видели одинаковое поведение.
 *
 * **Это только лексер.** Он не знает про реестры агентов/пользователей/скиллов/
 * сниппетов, не делает I/O и не решает, существует ли сущность: вид упоминания
 * (`file`/`agent`) — эвристика по форме токена, окончательное разрешение
 * (`@user`, приоритет «агент → пользователь → файл → литерал», PROP-126 §2) —
 * задача позднего резолвера.
 *
 * Правила (PROP-126 §0 «Общие правила парсинга»):
 *
 * - токен распознаётся только **в начале слова** — в начале строки или после
 *   пробела/пунктуации; внутри слова токена нет (`a@b.com` — не упоминание);
 * - внутри fenced-блоков (``` … ``` или ~~~ … ~~~) и inline-кода (`…`) токены
 *   не распознаются;
 * - экранирование `\@`, `\$`, `\#` (и `\\`): токен **не создаётся**, обратный
 *   слэш **остаётся в тексте** — разбор ничего в тексте не переписывает
 *   (`ParsedInput.text` — исходная строка как есть);
 * - неизвестный/невалидный токен остаётся обычным текстом — ошибка разбора не
 *   блокирует отправку.
 *
 * Форма токенов:
 *
 * | Префикс | Тело | Нормализация `id` |
 * |---|---|---|
 * | `@` | любые непробельные символы (путь, имя агента, имя пользователя) | без завершающей пунктуации |
 * | `$` | буквы/цифры/`.`/`_`/`-` (Unicode-aware) | без завершающей пунктуации |
 * | `#` | буквы/цифры/`.`/`_`/`-` (Unicode-aware) | без завершающей пунктуации |
 *
 * У `$`/`#` имя обязано начинаться с буквы: `$5` (цена) и `#123` (номер) — не
 * токены. У `#` дополнительно: пробел после `#` (`# Заголовок`) — markdown-
 * заголовок, а не сниппет; прогон `#` (`##`, `###`) — тоже заголовок.
 *
 * Span: индексы исходного текста, 0-based, `end` — exclusive, в единицах UTF-16
 * (как индексы JS-строки). Span покрывает **исходный токен** (с префиксом и
 * завершающей пунктуацией), `label` — текст без префикса «как набрано», `id` —
 * нормализованный ключ для поиска сущности.
 */

import type {
  InputMention,
  InputToken,
  MentionKind,
  ParsedInput,
  SkillMention,
  SnippetMention,
} from '@itphx/synth-shared';

/** Префикс упоминания. */
const MENTION_PREFIX = '@';
/** Префикс вызова скилла. */
const SKILL_PREFIX = '$';
/** Префикс ссылки на сниппет. */
const SNIPPET_PREFIX = '#';

/**
 * Завершающая пунктуация, которая не входит в нормализованный `id`.
 *
 * Спека PROP-126 §0 перечисляет `.,;:!?`; дополнительно снимаются закрывающие
 * скобки и кавычки — тело `@`-токена идёт до пробела, поэтому в него попадает
 * «хвост» вроде `alice)` из `(@alice)`, и такой `id` не находил бы сущность.
 */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/u;

/** Символ «слова»: буква, цифра или подчёркивание (Unicode-aware). */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Буква (Unicode-aware) — первый символ имени скилла/сниппета. */
const LETTER = /\p{L}/u;

/** Символ тела `$`/`#`-токена: буква, цифра, точка, подчёркивание, дефис. */
const SYMBOL_BODY_CHAR = /[\p{L}\p{N}._-]/u;

/** Пробельный символ (Unicode-aware). */
const WHITESPACE = /\s/u;

/**
 * Строка с маркером fenced-блока (до трёх отступов, три и более обратных
 * кавычек или тильд — как в CommonMark).
 */
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** Разобранный токен ввода (до раскладки по спискам результата). */
interface ParsedToken {
  /** Нормализованный идентификатор (без префикса и завершающей пунктуации). */
  id: string;
  /** Текст без префикса — как его набрал пользователь. */
  label: string;
  /** Начало токена (индекс префикса). */
  start: number;
  /** Конец токена (exclusive). */
  end: number;
  /** Вид упоминания — только для `@`. */
  kind?: MentionKind;
}

/**
 * Разбирает пользовательский текст на токены ввода.
 *
 * Чистая функция: без I/O, без реестров, без мутаций. Текст не изменяется —
 * в результате возвращается исходная строка и списки найденных токенов.
 *
 * @param text исходный текст сообщения
 * @returns текст без изменений + упоминания/скиллы/сниппеты в порядке появления
 */
export function parseInput(text: string): ParsedInput {
  const mentions: InputMention[] = [];
  const skills: SkillMention[] = [];
  const snippets: SnippetMention[] = [];
  if (!text) return { text, mentions, skills, snippets };

  const masked = buildCodeMask(text);
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    // Код (fenced/inline) — токены внутри не распознаются.
    if (masked[index]) {
      index++;
      continue;
    }
    if (char === '\\') {
      // Экранирование: `\@`, `\$`, `\#`, `\!` (и `\\`) — токен не создаётся,
      // обратный слэш остаётся в тексте.
      const next = text.charAt(index + 1);
      if (
        next === MENTION_PREFIX ||
        next === SKILL_PREFIX ||
        next === SNIPPET_PREFIX ||
        next === '!' ||
        next === '\\'
      ) {
        index += 2;
        continue;
      }
      index++;
      continue;
    }
    if (char !== MENTION_PREFIX && char !== SKILL_PREFIX && char !== SNIPPET_PREFIX) {
      index++;
      continue;
    }
    if (!isTokenStart(text, index)) {
      index++;
      continue;
    }
    const token = readToken(text, index, char, masked);
    if (!token) {
      index++;
      continue;
    }
    const span = { start: token.start, end: token.end };
    if (char === MENTION_PREFIX) {
      mentions.push({
        kind: token.kind ?? 'agent',
        id: token.id,
        label: token.label,
        span,
      });
    } else if (char === SKILL_PREFIX) {
      skills.push({ id: token.id, label: token.label, span });
    } else {
      snippets.push({ id: token.id, label: token.label, span });
    }
    index = token.end;
  }

  return { text, mentions, skills, snippets };
}

/**
 * Плоский список токенов ввода (упоминания + скиллы + сниппеты) в порядке
 * появления — удобно для подсветки и чипов в композере UI.
 */
export function collectInputTokens(parsed: ParsedInput): InputToken[] {
  const tokens: InputToken[] = [];
  for (const mention of parsed.mentions) {
    tokens.push({
      kind: 'mention',
      id: mention.id,
      label: mention.label,
      span: mention.span,
    });
  }
  for (const skill of parsed.skills) {
    tokens.push({ kind: 'skill', id: skill.id, label: skill.label, span: skill.span });
  }
  for (const snippet of parsed.snippets) {
    tokens.push({ kind: 'snippet', id: snippet.id, label: snippet.label, span: snippet.span });
  }
  return tokens.sort((a, b) => a.span.start - b.span.start);
}

/**
 * Начало слова: начало строки либо предыдущий символ — пробел/пунктуация.
 * Внутри слова (`a@b.com`) токен не начинается.
 */
function isTokenStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text.charAt(index - 1);
  // Два префикса подряд (`@@alice`) — токеном не считаем.
  if (previous === MENTION_PREFIX || previous === SKILL_PREFIX || previous === SNIPPET_PREFIX) {
    return false;
  }
  return !WORD_CHAR.test(previous);
}

/** Читает токен по префиксу; `null` — токена нет (остаётся текстом). */
function readToken(
  text: string,
  start: number,
  prefix: string,
  masked: boolean[],
): ParsedToken | null {
  if (prefix === SNIPPET_PREFIX) {
    // Прогон `#` (`##`, `###`) — markdown-заголовок, а не сниппет.
    let run = 0;
    while (text.charAt(start + run) === SNIPPET_PREFIX) run++;
    if (run > 1) return null;
    // `# Заголовок` — пробел после `#` → markdown-заголовок.
    if (isWhitespaceChar(text.charAt(start + 1))) return null;
    return readSymbolToken(text, start);
  }
  if (prefix === SKILL_PREFIX) {
    if (isWhitespaceChar(text.charAt(start + 1))) return null;
    return readSymbolToken(text, start);
  }
  return readMentionToken(text, start, masked);
}

/** Тело `$`/`#`-токена: буквы/цифры/`.`/`_`/`-`; имя начинается с буквы. */
function readSymbolToken(text: string, start: number): ParsedToken | null {
  let end = start + 1;
  while (end < text.length && SYMBOL_BODY_CHAR.test(text.charAt(end))) end++;
  const label = text.slice(start + 1, end);
  if (!label) return null;
  // Имя с цифры — не имя: `$5` (цена), `#123` (номер).
  if (!LETTER.test(label.charAt(0))) return null;
  const id = label.replace(TRAILING_PUNCTUATION, '');
  if (!id) return null;
  return { id, label, start, end };
}

/**
 * Тело `@`-токена: любые непробельные символы (путь, имя агента, имя
 * пользователя). Соседний префикс или маркер кода — конец тела.
 */
function readMentionToken(text: string, start: number, masked: boolean[]): ParsedToken | null {
  let end = start + 1;
  while (end < text.length) {
    const char = text.charAt(end);
    if (WHITESPACE.test(char)) break;
    if (
      char === MENTION_PREFIX ||
      char === SKILL_PREFIX ||
      char === SNIPPET_PREFIX ||
      char === '`'
    ) {
      break;
    }
    if (masked[end]) break;
    end++;
  }
  const label = text.slice(start + 1, end);
  if (!label) return null;
  const id = label.replace(TRAILING_PUNCTUATION, '');
  if (!id) return null;
  // Вид по форме: путь (`/` или `.`) — файл, иначе агент. Окончательное
  // разрешение (в т.ч. `@user`) — задача позднего резолвера (PROP-126 §2).
  const kind: MentionKind = id.includes('/') || id.includes('.') ? 'file' : 'agent';
  return { id, label, kind, start, end };
}

/** Пробельный символ (пустая строка — не пробел). */
function isWhitespaceChar(char: string): boolean {
  return char !== '' && WHITESPACE.test(char);
}

/**
 * Маска «кодовых» участков текста: fenced-блоки и inline-код. Внутри них
 * токены ввода не распознаются (PROP-126 §0).
 */
function buildCodeMask(text: string): boolean[] {
  const masked = new Array<boolean>(text.length).fill(false);
  maskFencedCode(text, masked);
  maskInlineCode(text, masked);
  return masked;
}

/**
 * Fenced-блок: строка с маркером (``` или ~~~, или длиннее) открывает блок,
 * закрывает — строка с тем же маркером и не меньшим числом символов. Внутри
 * блока строки помечены как код.
 */
function maskFencedCode(text: string, masked: boolean[]): void {
  let fenceMarker = '';
  let fenceLength = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newlineAt = text.indexOf('\n', lineStart);
    const lineEnd = newlineAt === -1 ? text.length : newlineAt;
    const match = FENCE_LINE.exec(text.slice(lineStart, lineEnd));
    if (match) {
      const marker = match[1] ?? '';
      const length = marker.length;
      if (fenceMarker === '') {
        fenceMarker = marker.charAt(0);
        fenceLength = length;
        markRange(masked, lineStart, lineEnd);
      } else {
        markRange(masked, lineStart, lineEnd);
        if (marker.charAt(0) === fenceMarker && length >= fenceLength) {
          fenceMarker = '';
          fenceLength = 0;
        }
      }
    } else if (fenceMarker !== '') {
      markRange(masked, lineStart, lineEnd);
    }
    if (newlineAt === -1) break;
    lineStart = newlineAt + 1;
  }
}

/**
 * Inline-код: открывающий прогон backtick'ов закрывается прогоном той же
 * длины. Незакрытый прогон — обычный текст (как в CommonMark).
 */
function maskInlineCode(text: string, masked: boolean[]): void {
  let index = 0;
  while (index < text.length) {
    if (masked[index]) {
      index++;
      continue;
    }
    if (text.charAt(index) !== '`') {
      index++;
      continue;
    }
    let runLength = 0;
    while (text.charAt(index + runLength) === '`') runLength++;
    const closeAt = findClosingBackticks(text, index + runLength, runLength, masked);
    if (closeAt === -1) {
      index += runLength;
      continue;
    }
    markRange(masked, index, closeAt + runLength);
    index = closeAt + runLength;
  }
}

/** Ищет закрывающий прогон backtick'ов той же длины; `-1` — не найден. */
function findClosingBackticks(
  text: string,
  from: number,
  runLength: number,
  masked: boolean[],
): number {
  let index = from;
  while (index < text.length) {
    // Внутри fenced-блока ищем закрытие inline-кода не продолжаем.
    if (masked[index]) return -1;
    if (text.charAt(index) === '`') {
      let length = 0;
      while (text.charAt(index + length) === '`') length++;
      if (length === runLength) return index;
      index += length;
      continue;
    }
    index++;
  }
  return -1;
}

/** Помечает отрезок текста как код. */
function markRange(masked: boolean[], start: number, end: number): void {
  const limit = Math.min(end, masked.length);
  for (let index = start; index < limit; index++) {
    masked[index] = true;
  }
}
