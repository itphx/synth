/**
 * Защита от Indirect Prompt Injection (IPI).
 *
 * - wrapContent: оборачивает tool-контент в маркеры [CONTENT]...[CONTENT END]
 *   с атрибутами источника и уровнем доверия.
 * - detectPromptInjection: детекция подозрительных паттернов через DictionaryStore
 *   (категория injection, языки ru/en).
 * - applyPolicy: применение политики flag / sanitize / block.
 */
import type { DictionaryRepository } from '../../storage/ports/dictionary-repository.js';
import { t as sm } from '../system-messages.js';

export type TrustLevel = 'trusted' | 'untrusted';

export type InjectionPolicy = 'flag' | 'sanitize' | 'block';

export interface InjectionDetection {
  suspicious: boolean;
  matches: string[];
}

export const CONTENT_START = '[CONTENT |';
export const CONTENT_END = '[CONTENT END]';

/** Кап значения атрибута открывающего маркера. */
export const MAX_CONTENT_ATTRIBUTE_VALUE_LENGTH = 120;

/** Кап имени атрибута открывающего маркера. */
export const MAX_CONTENT_ATTRIBUTE_KEY_LENGTH = 40;

export const WARN_PREFIX = sm('security.warn_prefix');

/**
 * Формирует строку предупреждения о подозрительном контенте.
 * Используется вызывающим (orchestrator) и ставится ПЕРЕД блоком [CONTENT].
 */
export function buildWarnLine(matches: string[]): string {
  return `${WARN_PREFIX}: ${matches.slice(0, 5).join(', ')}]`;
}

/**
 * Экранирует маркеры блока контента внутри `text`: `[CONTENT` и `[/CONTENT]`
 * (регистронезависимо) становятся `\[CONTENT` / `\[/CONTENT]`.
 *
 * Зачем: недоверенный контент может **подделать** закрывающий маркер
 * `[CONTENT END]` и выдать свой текст за инструкцию вне блока данных.
 * Экранирование — **всегда**, независимо от режима (`flag`/`sanitize`/`block`):
 * подделка маркера не блокирует контент (иначе нельзя прочитать репозиторий
 * с образцами), но помечается (`injection_marker_escaped`/`injection_suspicious`).
 *
 * Идемпотентна: уже экранированный маркер (перед `[` стоит `\`) не трогается.
 * Исходный регистр сохраняется.
 */
export function escapeContentMarkers(text: string): { content: string; escaped: boolean } {
  if (!text) return { content: text, escaped: false };
  let escaped = false;
  const content = text.replace(/(?<!\\)\[(\/?CONTENT)\b/gi, (_match, marker: string) => {
    escaped = true;
    return `\\[${marker}`;
  });
  return { content, escaped };
}

/**
 * Санитизировать **значение** атрибута открывающего маркера.
 *
 * Проблема, которую это закрывает: атрибут подставляется в тот же заголовок,
 * что несёт `SOURCE`/`trust`, — поддельный `[CONTENT END]` или `|` в значении
 * (`PATH: a]\n[CONTENT END]\n…`) закрыл бы блок досрочно и вынес бы
 * `trust: trusted` наружу конверта. Тело экранировалось и раньше, атрибуты — нет.
 *
 * Порядок:
 *
 * 1. `escapeContentMarkers` — маркер в значении становится текстом
 *    (`\[CONTENT END`), идемпотентно;
 * 2. санитайз в стиле терминального (`sanitizeTerminalAttributeValue`):
 *    `]` и `|` убираются (не закрывают маркер и не ломают разделители),
 *    `\s+` → пробел (заголовок остаётся однострочным), кап
 *    `MAX_CONTENT_ATTRIBUTE_VALUE_LENGTH`.
 *
 * Порядок «убрать символы → свернуть пробелы» — ради идемпотентности: после
 * удаления разделителя остаются два пробела, и второй проход их схлопывает.
 *
 * Идемпотентна: санитайз повторно ничего не меняет, поэтому двойной проход
 * (терминальная ветка `trust.ts` санитизирует значения сама) безопасен.
 */
export function sanitizeContentAttributeValue(value: string): string {
  if (!value) return '';
  return escapeContentMarkers(value)
    .content.replace(/[\]|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CONTENT_ATTRIBUTE_VALUE_LENGTH);
}

/**
 * Санитизировать **имя** атрибута открывающего маркера.
 *
 * Ключи статические (из кода), но защита не должна зависеть от дисциплины
 * вызывающих: `]`, `|` и пробелы убираются, длина ограничена
 * `MAX_CONTENT_ATTRIBUTE_KEY_LENGTH`. Пустое имя — атрибут не выводится.
 */
export function sanitizeContentAttributeKey(key: string): string {
  return key
    .replace(/[\]|\s]/g, '')
    .slice(0, MAX_CONTENT_ATTRIBUTE_KEY_LENGTH);
}

/**
 * Оборачивает tool-контент в маркеры:
 * [CONTENT | SOURCE: {source} | {ATTR}: {val} | trust: {trust}]
 * {content}
 * [CONTENT END]
 *
 * Тело маркеров экранируется (`escapeContentMarkers`) — вызывающий не может
 * «забыть» это сделать: подделанный `[CONTENT END]` в контенте не закроет блок.
 * Значения и имена атрибутов тоже санитизируются
 * (`sanitizeContentAttributeValue`/`sanitizeContentAttributeKey`): подделка
 * маркера/разделителя в атрибуте не закроет конверт и не вынесет `trust` наружу.
 */
export function wrapContentDetailed(
  content: string,
  source: string,
  attrs: Record<string, string>,
  trust: TrustLevel,
): { content: string; escaped: boolean } {
  const parts = [`SOURCE: ${source}`];
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null && value !== '') {
      const safeKey = sanitizeContentAttributeKey(key);
      const safeValue = sanitizeContentAttributeValue(
        typeof value === 'string' ? value : String(value),
      );
      if (safeKey !== '' && safeValue !== '') {
        parts.push(`${safeKey}: ${safeValue}`);
      }
    }
  }
  parts.push(`trust: ${trust}`);
  const body = escapeContentMarkers(content);
  return {
    content: `[CONTENT | ${parts.join(' | ')}]\n${body.content}\n[CONTENT END]`,
    escaped: body.escaped,
  };
}

/** Обёртка контента в маркеры (совместимая сигнатура: только строка). */
export function wrapContent(
  content: string,
  source: string,
  attrs: Record<string, string>,
  trust: TrustLevel,
): string {
  return wrapContentDetailed(content, source, attrs, trust).content;
}

/**
 * Детекция подозрительных паттернов по словарю `injection` на языке `lang`.
 * Матчинг по нижнему регистру и границам слов (кириллица через \p{L}).
 */
export function detectPromptInjection(
  content: string,
  dictionaryStore: DictionaryRepository,
  lang: string,
): InjectionDetection {
  const lower = content.toLowerCase();
  const categorized = dictionaryStore.getCategorizedKeywords('injection', lang);
  const matches: string[] = [];

  for (const keywords of Object.values(categorized)) {
    if (!Array.isArray(keywords)) continue;
    for (const keyword of keywords) {
      if (keyword && containsWord(lower, keyword)) {
        matches.push(keyword);
      }
    }
  }

  return { suspicious: matches.length > 0, matches };
}

/**
 * Применение политики к подозрительному контенту.
 * - flag: контент не изменяется, возвращается detail (совпадения) — WARN-строку
 *   формирует вызывающий и ставит её ПЕРЕД блоком [CONTENT].
 * - sanitize: заменить совпавшие фрагменты на [redacted].
 * - block: вернуть blocked=true (контент не отдаётся модели).
 */
export function applyPolicy(
  content: string,
  policy: InjectionPolicy,
  detection: InjectionDetection,
): { content: string; suspicious: boolean; blocked: boolean; detail: string[] } {
  if (!detection.suspicious) {
    return { content, suspicious: false, blocked: false, detail: [] };
  }

  const detail = detection.matches.slice(0, 5);

  if (policy === 'block') {
    return { content, suspicious: true, blocked: true, detail };
  }

  if (policy === 'sanitize') {
    let sanitized = content;
    for (const match of detection.matches) {
      // Ищем в нижнем регистре и заменяем в оригинале (по регистронезависимому regex)
      const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sanitized = sanitized.replace(
        new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, 'giu'),
        '[redacted]',
      );
    }
    return { content: sanitized, suspicious: true, blocked: false, detail };
  }

  // flag — по умолчанию: контент не изменяется
  return { content, suspicious: true, blocked: false, detail };
}

/** Матчинг по границам слов: «игнорируй» не срабатывает внутри «проигнорируй». */
export function containsWord(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, 'u').test(text);
}
