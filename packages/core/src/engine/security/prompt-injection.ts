/**
 * Защита от Indirect Prompt Injection (IPI).
 *
 * - wrapContent: оборачивает tool-контент в маркеры [CONTENT]...[CONTENT END]
 *   с атрибутами источника и уровнем доверия.
 * - detectPromptInjection: детекция подозрительных паттернов через DictionaryStore
 *   (категория injection, языки ru/en).
 * - applyPolicy: применение политики flag / sanitize / block.
 */
import type { DictionaryStore } from '../router/dictionary-store.js';
import { t as sm } from '../system-messages.js';

export type TrustLevel = 'trusted' | 'untrusted';

export type InjectionPolicy = 'flag' | 'sanitize' | 'block';

export interface InjectionDetection {
  suspicious: boolean;
  matches: string[];
}

export const CONTENT_START = '[CONTENT |';
export const CONTENT_END = '[CONTENT END]';

export const WARN_PREFIX = sm('security.warn_prefix');

/**
 * Формирует строку предупреждения о подозрительном контенте.
 * Используется вызывающим (orchestrator) и ставится ПЕРЕД блоком [CONTENT].
 */
export function buildWarnLine(matches: string[]): string {
  return `${WARN_PREFIX}: ${matches.slice(0, 5).join(', ')}]`;
}

/**
 * Оборачивает tool-контент в маркеры:
 * [CONTENT | SOURCE: {source} | {ATTR}: {val} | trust: {trust}]
 * {content}
 * [CONTENT END]
 */
export function wrapContent(
  content: string,
  source: string,
  attrs: Record<string, string>,
  trust: TrustLevel,
): string {
  const parts = [`SOURCE: ${source}`];
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null && value !== '') {
      parts.push(`${key}: ${value}`);
    }
  }
  parts.push(`trust: ${trust}`);
  return `[CONTENT | ${parts.join(' | ')}]\n${content}\n[CONTENT END]`;
}

/**
 * Детекция подозрительных паттернов по словарю `injection` на языке `lang`.
 * Матчинг по нижнему регистру и границам слов (кириллица через \p{L}).
 */
export function detectPromptInjection(
  content: string,
  dictionaryStore: DictionaryStore,
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
