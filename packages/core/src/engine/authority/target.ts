/**
 * ADR-106 Ф1: вывод цели (`Target`) из вызова инструмента.
 *
 * Цель — **типизированный ресурс**, а не текст команды и не имя тула
 * (ADR-106 §«Инварианты модели», п. 2). Здесь вызов тула превращается в
 * пару «действие × цель»:
 *
 * - `path:<относительный путь>` — файл/каталог **внутри периметра сессии**
 *   (рабочий каталог или `allowedRoots`, ADR-114). Путь приводится к
 *   относительному от того корня, в котором лежит: сырых абсолютных путей в
 *   журнале решений и метриках быть не должно (инвариант 25, ADR-094).
 * - `outside:<токен>` — путь **вне периметра** (ADR-106 Ф2). Отдельный вид
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

import { resolvePath, isInsideAnyRoot } from '../tools/path-utils.js';
import { extractPathParams } from '../permission/groups.js';
import { authorityTargetKindForTool } from './actions.js';

/** Вход вывода цели. */
export interface AuthorityTargetInput {
  toolName: string;
  params: Record<string, unknown>;
  /** Рабочий каталог (workspace проекта). */
  workingDir: string;
  /**
   * Дополнительные абсолютные корни периметра (ADR-114: `project.workspace` у
   * сессии в git-worktree). Путь внутри любого из них — `path`, а не `outside`.
   */
  allowedRoots?: readonly string[];
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
 * Периметр цели: рабочий каталог + дополнительные корни (`allowedRoots`).
 * Порядок важен: `ref` считается от **первого** корня, в котором лежит путь.
 */
function perimeterRoots(workingDir: string, allowedRoots?: readonly string[]): string[] {
  const roots: string[] = [];
  for (const root of [workingDir, ...(allowedRoots ?? [])]) {
    if (typeof root === 'string' && root.trim() !== '' && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

/** Относительная ссылка пути от корня (`'.'` — сам корень). */
function relativeRef(root: string, absolute: string): string {
  const rel = relative(root, absolute).split('\\').join('/');
  return rel === '' ? '.' : rel;
}

/**
 * Резолв файлового пути тула: внутри **любого** корня периметра (`workingDir`
 * или `allowedRoots`) → `path`, вне всех → `outside`.
 *
 * `ref` — относительный путь от первого корня, в котором лежит путь (`'.'` для
 * самого корня); сырой абсолютный путь остаётся только в `absolute` (для
 * сопоставления с шаблоном гранта, в журнал не попадает).
 *
 * Единая точка для вывода цели (`deriveAuthorityTarget`) и компиляции грантов
 * (`compile.ts`): вид цели обязан совпадать в обоих местах, иначе грант
 * «действие × цель» не покроет цель (и решение станет `deny('no_grant')`).
 */
export function resolveAuthorityPathTarget(
  toolName: string,
  params: Record<string, unknown>,
  workingDir: string,
  allowedRoots?: readonly string[],
): ResolvedAuthorityPath | undefined {
  const roots = perimeterRoots(workingDir, allowedRoots);
  // `patch` несёт пути в `edits[].file_path` — общий сборщик их понимает.
  const raw = extractPathParams(toolName, params)[0];
  if (raw === undefined) return undefined;
  const absolute = resolvePath(raw, workingDir);
  for (const root of roots) {
    if (isInsideAnyRoot(absolute, [root])) {
      return { kind: 'path', ref: relativeRef(root, absolute), absolute };
    }
  }
  return { kind: 'outside', ref: outsideTargetRef(absolute), absolute };
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
  const roots = perimeterRoots(input.workingDir, input.allowedRoots);
  for (const root of roots) {
    if (isInsideAnyRoot(absolute, [root])) {
      return {
        target: { kind: 'workspace', ref: relativeRef(root, absolute) },
        altRefs: [absolute],
      };
    }
  }
  // Вне периметра — прежнее поведение: рабочая область без относительного
  // пути (`workspace:.`); сам факт выхода гейтит permission-слой.
  return {
    target: { kind: 'workspace', ref: '.' },
    altRefs: [absolute],
  };
}

/** Файловая цель: относительный путь внутри workspace или `outside` — вне его. */
function derivePathTarget(input: AuthorityTargetInput): DerivedAuthorityTarget {
  const resolved = resolveAuthorityPathTarget(
    input.toolName,
    input.params,
    input.workingDir,
    input.allowedRoots,
  );
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
