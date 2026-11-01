/**
 * Имя файла и расширение для скачивания блока кода markdown.
 *
 * Источник алиасов fence-языков — `lib/markdown/highlight.ts` (`LANGUAGES`/
 * `resolveHighlightLanguage`): один список языков на подсветку и скачивание,
 * второй карты алиасов не заводим. Здесь только соответствие канонического
 * имени грамматики расширению файла.
 *
 * Расширения возвращаются **без точки** (`ts`, `sh`, …) — имена файлов
 * собирает вызывающий (`codeFileName`).
 */
import { resolveHighlightLanguage } from './highlight'

/** Канонический язык shiki → расширение файла. */
const EXTENSION_BY_LANGUAGE: Record<string, string> = {
  typescript: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  jsx: 'jsx',
  json: 'json',
  bash: 'sh',
  python: 'py',
  yaml: 'yml',
  sql: 'sql',
  diff: 'diff',
  html: 'html',
  css: 'css',
  markdown: 'md',
}

/** Расширение для неизвестного языка, `text` и пустого fence. */
export const DEFAULT_CODE_EXTENSION = 'txt'

/**
 * Расширение файла по языку из fence (без точки).
 * Неизвестный/отсутствующий язык и `text` → `txt`.
 */
export function codeFileExtension(lang: string | undefined): string {
  const language = resolveHighlightLanguage(lang ?? '')
  if (!language) return DEFAULT_CODE_EXTENSION
  return EXTENSION_BY_LANGUAGE[language] ?? DEFAULT_CODE_EXTENSION
}

/**
 * Имя файла для скачивания: `code.<ext>`.
 * Нумерацию совпадающих имён (`code (1).ts`) добавляет сам браузер.
 */
export function codeFileName(lang: string | undefined): string {
  return `code.${codeFileExtension(lang)}`
}
