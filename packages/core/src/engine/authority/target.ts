/**
 * PROP-108 Ф1: вывод цели (`Target`) из вызова инструмента.
 *
 * Цель — **типизированный ресурс**, а не текст команды и не имя тула
 * (PROP-108 §«Инварианты модели», п. 2). Здесь вызов тула превращается в
 * пару «действие × цель»:
 *
 * - `path:<относительный путь>` — файл/каталог **внутри** workspace. Путь
 *   приводится к относительному: сырых абсолютных путей в журнале решений и
 *   метриках быть не должно (инвариант 25, ADR-094). Путь вне workspace
 *   выразить относительным нельзя → цель не разрешается (`undefined`) →
 *   решение `deny('unknown')` (fail-closed).
 * - `workspace:<путь>` — рабочая область (shell/git).
 * - `session:<id>` — сессионные тулы (план, todo, профиль, делегирование).
 * - `external:<host><path>` — внешний ресурс (веб). Query-строка и
 *   пользовательская часть URL **не попадают** в цель (там могут быть
 *   секреты).
 * - `mcp:<server>/<tool>` — инструмент внешнего MCP-сервера.
 */
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
 * Выводит цель вызова тула.
 *
 * Пустой/undefined-результат означает «цель неизвестна» — вызывающий обязан
 * трактовать это как `deny('unknown')` (PROP-108 §«Резолвинг и решение»).
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
      return { target: { kind: 'workspace', ref: '.' }, altRefs: [] };
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

/** Файловая цель: относительный путь внутри workspace. */
function derivePathTarget(input: AuthorityTargetInput): DerivedAuthorityTarget {
  const paramNames = TOOL_PATH_PARAMS[input.toolName] ?? [];
  for (const name of paramNames) {
    const value = input.params[name];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const absolute = resolvePath(value, input.workingDir);
    if (!isInsideWorkingDir(absolute, input.workingDir)) {
      // Путь вне workspace относительным не выразить — цель неизвестна.
      return { altRefs: [] };
    }
    const rel = relative(input.workingDir, absolute).split('\\').join('/');
    return {
      target: { kind: 'path', ref: rel === '' ? '.' : rel },
      // Абсолютный путь — только для сопоставления с шаблоном гранта.
      altRefs: [absolute],
    };
  }
  // Файловый тул без пути — цель не определена.
  return { altRefs: [] };
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
