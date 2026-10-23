/**
 * ADR-106 Ф1: вывод цели (`Target`) из вызова инструмента.
 *
 * Цель — **типизированный ресурс**, а не текст команды и не имя тула
 * (ADR-106 §«Инварианты модели», п. 2). Здесь вызов тула превращается в
 * пару «действие × цель»:
 *
 * - `path:<относительный путь>` — файл/каталог **внутри** workspace. Путь
 *   приводится к относительному: сырых абсолютных путей в журнале решений и
 *   метриках быть не должно (инвариант 25, ADR-094).
 * - `outside:<токен>` — путь **вне** workspace (ADR-106 Ф2). Отдельный вид
 *   цели: к таким путям относятся правило `external_directory` и его
 *   fail-closed дефолт. Ссылка — неразличимый токен (хэш абсолютного пути):
 *   сырой путь в журнал не попадает, а сопоставление с шаблоном гранта идёт по
 *   `altRefs` (абсолютный путь) — ровно как для `path:`.
 * - `workspace:<путь>` — рабочая область (shell/git).
 * - `session:<id>` — сессионные тулы (план, todo, профиль, делегирование).
 * - `external:<host><path>` — внешний ресурс (веб). Query-строка и
 *   пользовательская часть URL **не попадают** в цель (там могут быть
 *   секреты).
 * - `mcp:<server>/<tool>` — инструмент внешнего MCP-сервера.
 */
import { createHash } from 'node:crypto';
import { relative } from 'node:path';

import type { AuthorityTarget } from '@itphx/synth-shared';

import { resolvePath } from '../tools/path-utils.js';
import { isInsideWorkingDir } from '../permission/evaluator.js';
import { TOOL_PATH_PARAMS } from '../permission/groups.js';
import { authorityTargetKindForTool } from './actions.js';

/** Вход вывода цели. */
export interface AuthorityTargetInput {
  toolName: string;
  params: Record<string, unknown>;
  /** Рабочий каталог (workspace проекта). */
  workingDir: string;
  /** Идентификатор сессии — цель вида `session:`. */
  sessionId: string;
  capabilities?: readonly string[];
  /** Источник тула (`builtin`/`mcp`/`plugin`). */
  toolSource?: string;
}

/** Результат вывода цели. */
export interface DerivedAuthorityTarget {
  /** `undefined` — цель не разрешилась (fail-closed → `deny('unknown')`). */
  target?: AuthorityTarget;
  /**
   * Дополнительные варианты ссылки для сопоставления с шаблоном гранта
   * (например, абсолютный путь). Используются **только** для сопоставления и
   * в журнал/метрики **не** попадают.
   */
  altRefs: string[];
}

/**
 * Вид цели файлового тула: `path` — внутри рабочего каталога, `outside` —
 * вне его (ADR-106 Ф2).
 */
export type AuthorityPathTargetKind = 'path' | 'outside';

/** Разрешённый файловый путь: вид цели + ссылка + абсолютный путь. */
export interface ResolvedAuthorityPath {
  kind: AuthorityPathTargetKind;
  /** Ссылка цели (для `outside` — неразличимый токен, без сырого пути). */
  ref: string;
  /** Абсолютный путь — только для сопоставления с шаблоном гранта. */
  absolute: string;
}

/**
 * Резолв файлового пути тула: внутри рабочего каталога → `path`, вне → `outside`.
 *
 * Единая точка для вывода цели (`deriveAuthorityTarget`) и компиляции грантов
 * (`compile.ts`): вид цели обязан совпадать в обоих местах, иначе грант
 * «действие × цель» не покроет цель (и решение станет `deny('no_grant')`).
 */
export function resolveAuthorityPathTarget(
  toolName: string,
  params: Record<string, unknown>,
  workingDir: string,
): ResolvedAuthorityPath | undefined {
  const paramNames = TOOL_PATH_PARAMS[toolName] ?? [];
  for (const name of paramNames) {
    const value = params[name];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const absolute = resolvePath(value, workingDir);
    if (!isInsideWorkingDir(absolute, workingDir)) {
      return { kind: 'outside', ref: outsideTargetRef(absolute), absolute };
    }
    const rel = relative(workingDir, absolute).split('\\').join('/');
    return { kind: 'path', ref: rel === '' ? '.' : rel, absolute };
  }
  return undefined;
}

/**
 * Ссылка цели вида `outside` — неразличимый токен (sha256 от абсолютного
 * пути, первые 16 hex-символов).
 *
 * Сырой абсолютный путь в журнал решений/метрики не попадает (инвариант 25,
 * ADR-094), но остаётся доступен для сопоставления с шаблоном гранта через
 * `altRefs` — поэтому правило `external_directory: {'/tmp/*': 'allow'}` работает
 * как и раньше.
 */
export function outsideTargetRef(absolutePath: string): string {
  return createHash('sha256').update(absolutePath).digest('hex').slice(0, 16);
}

/**
 * Выводит цель вызова тула.
 *
 * Пустой/undefined-результат означает «цель неизвестна» — вызывающий обязан
 * трактовать это как `deny('unknown')` (ADR-106 §«Резолвинг и решение»).
 */
export function deriveAuthorityTarget(input: AuthorityTargetInput): DerivedAuthorityTarget {
  const kind = authorityTargetKindForTool(
    input.toolName,
    input.capabilities,
    input.toolSource,
  );
  if (kind === undefined) return { altRefs: [] };

  switch (kind) {
    case 'path':
      return derivePathTarget(input);
    case 'workspace':
      return deriveWorkspaceTarget(input);
    case 'session':
      return { target: { kind: 'session', ref: input.sessionId }, altRefs: [] };
    case 'external':
      return deriveExternalTarget(input);
    case 'mcp':
      return { target: { kind: 'mcp', ref: normalizeMcpRef(input.toolName) }, altRefs: [] };
    default:
      return { altRefs: [] };
  }
}

/**
 * Рабочая область: каталог выполнения относительно рабочего каталога.
 *
 * Ссылка — относительный путь (`'.'` — сам рабочий каталог), абсолютный путь
 * уходит в `altRefs` (только для сопоставления с шаблоном гранта — в журнал
 * решений он не попадает).
 */
function deriveWorkspaceTarget(input: AuthorityTargetInput): DerivedAuthorityTarget {
  const raw = input.params.cwd;
  const absolute =
    typeof raw === 'string' && raw.trim() !== ''
      ? resolvePath(raw, input.workingDir)
      : input.workingDir;
  const inside = isInsideWorkingDir(absolute, input.workingDir);
  const rel = inside ? relative(input.workingDir, absolute).split('\\').join('/') : '';
  return {
    target: { kind: 'workspace', ref: rel === '' ? '.' : rel },
    altRefs: [absolute],
  };
}

/** Файловая цель: относительный путь внутри workspace или `outside` — вне его. */
function derivePathTarget(input: AuthorityTargetInput): DerivedAuthorityTarget {
  const resolved = resolveAuthorityPathTarget(input.toolName, input.params, input.workingDir);
  if (!resolved) {
    // Файловый тул без пути — цель не определена.
    return { altRefs: [] };
  }
  return {
    target: { kind: resolved.kind, ref: resolved.ref },
    // Абсолютный путь — только для сопоставления с шаблоном гранта.
    altRefs: [resolved.absolute],
  };
}

/** Внешняя цель: только host+path, без query и пользовательской части. */
function deriveExternalTarget(input: AuthorityTargetInput): DerivedAuthorityTarget {
  const raw = input.params.url ?? input.params.query;
  if (typeof raw !== 'string' || raw.trim() === '') return { altRefs: [] };
  try {
    const url = new URL(raw);
    const ref = `${url.host}${url.pathname}`;
    return { target: { kind: 'external', ref: ref === '' ? url.host : ref }, altRefs: [] };
  } catch {
    return { altRefs: [] };
  }
}

/** `server_tool` → `server/tool` (имя MCP-инструмента в синте). */
function normalizeMcpRef(toolName: string): string {
  const idx = toolName.indexOf('_');
  if (idx <= 0) return toolName;
  return `${toolName.slice(0, idx)}/${toolName.slice(idx + 1)}`;
}
