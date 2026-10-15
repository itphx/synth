import { load as parseYaml, dump as dumpYaml } from 'js-yaml';
import type { SkillIssue } from '../types/skills.js';

/**
 * ADR-046 §3.1: толерантный парсер YAML-frontmatter `SKILL.md`.
 *
 * - Неизвестные ключи — не ошибка (совместимость Anthropic/opencode/Claude Code).
 * - Невалидный YAML — фиксируется issue, но не бросает исключение.
 * - Файл без frontmatter — `hasFrontmatter: false`, тело — весь документ.
 *
 * Хелпер не выполняет валидацию `name`/`description` (это делает parser ядра):
 * он лишь отделяет frontmatter от тела и нормализует YAML-объект.
 */

/** Открывающий `---` в самом начале документа (с возможным BOM/переводом строк). */
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?---[ \t]*(?:\r?\n|$)/;

export interface ParsedFrontmatter {
  /** Разобранный frontmatter (пустой объект, если его нет/невалиден). */
  data: Record<string, unknown>;
  /** Тело документа (Markdown после frontmatter). */
  body: string;
  /** Проблемы парсинга (не бросаем исключений). */
  issues: SkillIssue[];
  hasFrontmatter: boolean;
}

/**
 * Разбирает frontmatter. Возвращает issues, а не throw — вызывающая сторона
 * решает, блокирует ли проблема загрузку скилла.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { data: {}, body: raw, issues: [], hasFrontmatter: false };
  }

  const yamlBlock = match[1] ?? '';
  const body = raw.slice(match[0].length);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch (err) {
    return {
      data: {},
      body,
      hasFrontmatter: true,
      issues: [{
        code: 'invalid-frontmatter',
        message: `невалидный YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }

  if (parsed === null || parsed === undefined) {
    return { data: {}, body, hasFrontmatter: true, issues: [] };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      data: {},
      body,
      hasFrontmatter: true,
      issues: [{
        code: 'invalid-frontmatter-type',
        message: 'frontmatter должен быть YAML-объектом',
      }],
    };
  }

  return {
    data: parsed as Record<string, unknown>,
    body,
    hasFrontmatter: true,
    issues: [],
  };
}

/**
 * Сериализует frontmatter + тело обратно в `SKILL.md`. Используется записью
 * instance-скиллов через сервис (не ручной записью JSON/файлов).
 */
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = dumpYaml(data, { indent: 2, lineWidth: 120, noRefs: true, sortKeys: false }).trimEnd();
  const normalizedBody = body.replace(/^\n+/, '');
  return `---\n${yaml}\n---\n\n${normalizedBody}`;
}
