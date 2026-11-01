/**
 * Контракт отказа «невалидные аргументы тула» (`tool.args_error`, ADR-041).
 *
 * Текст и `metadata.i18n` строятся **вместе**: `content` — полный текст для
 * модели, `metadata.i18n` — шаблон и параметры для UI. Если параметр `issues`
 * не передан, UI подставлял бы в шаблон сырое `{issues}` вместо списка ошибок
 * (ADR-041: content — полный текст, metadata — источник локализации).
 */
import type { ZodIssue } from 'zod';
import type { ToolResult } from '@itphx/synth-shared';
import { i18n as i18nMeta, t as sm } from '../system-messages.js';

/** Сколько issues одной ветви union печатать (остальное — только счётчик). */
const MAX_UNION_VARIANT_ISSUES = 3;

/** Предел текста одной ветви union: у вложенных схем issue бывает очень длинным. */
const MAX_UNION_VARIANT_CHARS = 300;

/** Путь issue для текста: `a.b.0`; пустой путь — `root`. */
function issuePath(path: readonly PropertyKey[]): string {
  return path.map((segment) => String(segment)).join('.') || 'root';
}

/**
 * `path: message; path2: message2` — единый формат `issues` для `tool.args_error`.
 *
 * Для `invalid_union` (в zod 4 issue несёт `errors: ZodIssue[][]` по вариантам)
 * голое `Invalid input` бесполезно: модель не понимает, что именно не так, и
 * повторяет тот же аргумент. Поэтому варианты печатаются по отдельности:
 * `todos: does not match any variant — variant 1: content: …; variant 2: value: …`.
 */
export function formatIssues(issues: readonly ZodIssue[]): string {
  return issues.map(formatIssue).join('; ');
}

function formatIssue(issue: ZodIssue): string {
  const variants = unionVariants(issue);
  if (variants) return formatUnionIssue(issue, variants);
  return `${issuePath(issue.path)}: ${issue.message}`;
}

/** Варианты `invalid_union`-issue (в zod 4 — `errors: ZodIssue[][]`). */
function unionVariants(issue: ZodIssue): ZodIssue[][] | null {
  if (issue.code !== 'invalid_union') return null;
  const errors = (issue as unknown as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors as ZodIssue[][];
}

function formatUnionIssue(issue: ZodIssue, variants: readonly ZodIssue[][]): string {
  const parts = variants.map(
    (branchIssues, index) => `variant ${index + 1}: ${formatUnionVariant(branchIssues)}`,
  );
  return `${issuePath(issue.path)}: does not match any variant — ${parts.join('; ')}`;
}

/**
 * Компактный текст одной ветви: путь **относительно ветви** (`value` — корень),
 * первые issues, обрезка до разумной длины.
 */
function formatUnionVariant(branchIssues: readonly ZodIssue[]): string {
  if (branchIssues.length === 0) return 'value: invalid';
  const text = branchIssues
    .slice(0, MAX_UNION_VARIANT_ISSUES)
    .map((branchIssue) => {
      const path = branchIssue.path.join('.') || 'value';
      return `${path}: ${branchIssue.message}`;
    })
    .join('; ');
  return truncate(text, MAX_UNION_VARIANT_CHARS);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Отказ «невалидные аргументы» — один контракт content+metadata (ADR-041).
 * `issues` строкой — для проверок, которые не Zod (`name: either "name" or ...`).
 */
export function argErrorResult(tool: string, issues: string | readonly ZodIssue[]): ToolResult {
  const text = typeof issues === 'string' ? issues : formatIssues(issues);
  return {
    content: sm('tool.args_error', { tool, issues: text }),
    isError: true,
    metadata: { i18n: i18nMeta('tool.args_error', { tool, issues: text }) },
  };
}
