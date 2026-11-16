import { parseFrontmatter } from '@itphx/synth-shared';
import type { ScriptDiagnostic } from '@itphx/synth-shared';
import type { TemplateScript } from './types.js';

/**
 * ADR-126 §5: парсинг декларации скрипта (`.md` + frontmatter).
 *
 * Формат — тот же толерантный YAML-frontmatter, что у скиллов
 * (`shared/src/skills/frontmatter.ts`): неизвестные ключи discovery не ломают.
 *
 * Обязательные поля — `description` (1..1024) и `run` (1..4000). Имя скрипта —
 * `^[a-z0-9]+(-[a-z0-9]+)*$`; берётся из `name` во frontmatter, иначе — из
 * имени файла без `.md`.
 *
 * Невалидная декларация **не создаёт запись** (fail-closed): битая
 * декларация не должна запускаться. Причина — в диагностике.
 */

/** Имя скрипта: строчные латинские буквы/цифры, разделитель — дефис. */
export const SCRIPT_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Предел длины описания скрипта (символов). */
export const SCRIPT_DESCRIPTION_MAX = 1024;

/** Предел длины команды запуска (символов). */
export const SCRIPT_RUN_MAX = 4000;

/** Предел таймаута запуска (мс). */
export const SCRIPT_TIMEOUT_MAX = 600_000;

/** Безопасное имя переменной окружения (`^[A-Za-z_][A-Za-z0-9_]*$`). */
export const SCRIPT_ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ParsedScript {
  script?: TemplateScript;
  diagnostics: ScriptDiagnostic[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed.length > 0 ? [trimmed] : undefined;
  }
  if (Array.isArray(v)) {
    const out = v
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/** Значение переменной окружения: строка; число/булево — приводим к строке. */
function asEnvValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return undefined;
}

/**
 * Разобрать декларацию скрипта.
 *
 * @param raw содержимое `.md`-файла;
 * @param fileName имя файла (`<name>.md`) — источник имени при отсутствии `name`;
 * @param dir каталог-источник;
 * @param file абсолютный путь файла декларации;
 * @param origin источник скрипта;
 * @param mtimeMs время изменения файла (для ленивой инвалидации кэша).
 */
export function parseScriptFile(
  raw: string,
  fileName: string,
  dir: string,
  file: string,
  origin: TemplateScript['origin'],
  mtimeMs: number,
): ParsedScript {
  const fallbackName = fileName.replace(/\.md$/i, '');
  const fm = parseFrontmatter(raw);
  const diagnostics: ScriptDiagnostic[] = [];

  if (!fm.hasFrontmatter) {
    diagnostics.push({
      level: 'error',
      code: 'invalid-frontmatter',
      message: `скрипт "${fallbackName}": отсутствует YAML frontmatter (--- … ---)`,
      script: fallbackName,
      path: file,
    });
    return { diagnostics };
  }

  for (const issue of fm.issues) {
    diagnostics.push({
      level: 'error',
      code: 'invalid-frontmatter',
      message: `скрипт "${fallbackName}": ${issue.message}`,
      script: fallbackName,
      path: file,
    });
  }
  // Невалидный YAML — данных нет; дальше разбирать нечего.
  if (fm.issues.length > 0) return { diagnostics };

  const data = fm.data;

  // --- Имя ---------------------------------------------------------------
  const name = (asString(data.name) ?? fallbackName).trim();
  if (!name || !SCRIPT_NAME_REGEX.test(name)) {
    diagnostics.push({
      level: 'error',
      code: 'missing-name',
      message: `скрипт "${fallbackName}": недопустимое имя "${name}" (строчные латинские буквы/цифры, разделитель — дефис)`,
      script: fallbackName,
      path: file,
    });
    return { diagnostics };
  }

  // --- Описание ----------------------------------------------------------
  const description = asString(data.description) ?? '';
  if (description.length === 0) {
    diagnostics.push({
      level: 'error',
      code: 'invalid-frontmatter',
      message: `скрипт "${name}": не задано описание (description)`,
      script: name,
      path: file,
    });
    return { diagnostics };
  }
  if (description.length > SCRIPT_DESCRIPTION_MAX) {
    diagnostics.push({
      level: 'error',
      code: 'invalid-frontmatter',
      message: `скрипт "${name}": описание длиннее ${SCRIPT_DESCRIPTION_MAX} символов`,
      script: name,
      path: file,
    });
    return { diagnostics };
  }

  // --- Команда запуска ---------------------------------------------------
  const run = asString(data.run) ?? '';
  if (run.length === 0) {
    diagnostics.push({
      level: 'error',
      code: 'invalid-run',
      message: `скрипт "${name}": не задана команда запуска (run)`,
      script: name,
      path: file,
    });
    return { diagnostics };
  }
  if (run.length > SCRIPT_RUN_MAX) {
    diagnostics.push({
      level: 'error',
      code: 'invalid-run',
      message: `скрипт "${name}": команда запуска длиннее ${SCRIPT_RUN_MAX} символов`,
      script: name,
      path: file,
    });
    return { diagnostics };
  }

  // --- Рабочий каталог (относительный, без выхода вверх) -----------------
  const cwdRaw = asString(data.cwd);
  let cwd: string | undefined;
  if (cwdRaw !== undefined) {
    if (isAbsolutePath(cwdRaw) || hasParentSegment(cwdRaw)) {
      diagnostics.push({
        level: 'error',
        code: 'invalid-run',
        message: `скрипт "${name}": cwd должен быть относительным путём внутри рабочего каталога`,
        script: name,
        path: file,
      });
      return { diagnostics };
    }
    cwd = cwdRaw;
  }

  // --- Таймаут -----------------------------------------------------------
  let timeout: number | undefined;
  const timeoutRaw = data.timeout;
  if (timeoutRaw !== undefined && timeoutRaw !== null) {
    const value = typeof timeoutRaw === 'number' ? timeoutRaw : Number(timeoutRaw);
    if (!Number.isInteger(value) || value < 0 || value > SCRIPT_TIMEOUT_MAX) {
      diagnostics.push({
        level: 'error',
        code: 'invalid-run',
        message: `скрипт "${name}": timeout должен быть целым числом 0..${SCRIPT_TIMEOUT_MAX}`,
        script: name,
        path: file,
      });
      return { diagnostics };
    }
    timeout = value;
  }

  // --- Окружение ---------------------------------------------------------
  let env: Record<string, string> | undefined;
  const envRaw = data.env;
  if (envRaw !== undefined && envRaw !== null) {
    if (typeof envRaw !== 'object' || Array.isArray(envRaw)) {
      diagnostics.push({
        level: 'error',
        code: 'invalid-run',
        message: `скрипт "${name}": env должен быть объектом`,
        script: name,
        path: file,
      });
      return { diagnostics };
    }
    const collected: Record<string, string> = {};
    for (const [key, value] of Object.entries(envRaw as Record<string, unknown>)) {
      if (!SCRIPT_ENV_KEY_REGEX.test(key)) {
        diagnostics.push({
          level: 'error',
          code: 'invalid-run',
          message: `скрипт "${name}": недопустимое имя переменной окружения "${key}"`,
          script: name,
          path: file,
        });
        return { diagnostics };
      }
      const normalized = asEnvValue(value);
      if (normalized === undefined) {
        diagnostics.push({
          level: 'error',
          code: 'invalid-run',
          message: `скрипт "${name}": значение переменной окружения "${key}" — не строка`,
          script: name,
          path: file,
        });
        return { diagnostics };
      }
      collected[key] = normalized;
    }
    env = collected;
  }

  // --- Бинарные требования ------------------------------------------------
  const requires = asStringArray(data.requires);

  const script: TemplateScript = {
    name,
    description,
    ...(asString(data['argument-hint']) ? { argumentHint: asString(data['argument-hint']) } : {}),
    run,
    shell: asBoolean(data.shell) ?? false,
    args: asBoolean(data.args) ?? false,
    ...(cwd ? { cwd } : {}),
    background: asBoolean(data.background) ?? true,
    ...(timeout !== undefined ? { timeout } : {}),
    ...(requires ? { requires } : {}),
    ...(env ? { env } : {}),
    ...(asString(data.ready) ? { ready: asString(data.ready) } : {}),
    body: fm.body.trim(),
    file,
    dir,
    origin,
    // Trust проставляет discovery-слой из источника (`scanScriptSource`).
    trusted: true,
    mtimeMs,
  };
  return { script, diagnostics };
}

/** Абсолютный путь (unix- и windows-вариант). */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** Есть ли в пути сегмент выхода вверх (`..`). */
function hasParentSegment(p: string): boolean {
  return p.split(/[\\/]+/).some((segment) => segment === '..');
}
