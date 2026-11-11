// Хелперы агрегации миров (локальный core + удалённый backend).
// Идентификация сущностей: namespace `remote:<id>`; локальные id — как есть.
// Функции переписывают id и вложенные ссылки, чтобы исключить коллизии UUID между мирами.

import { RemoteError } from './types.js';
import type { Origin } from './types.js';

export const REMOTE_PREFIX = 'remote:';

/** true, если ссылка указывает на сущность удалённого backend. */
export function isRemoteRef(ref: string): boolean {
  return ref.startsWith(REMOTE_PREFIX);
}

/** Снять префикс `remote:` (для локальных — вернуть как есть). */
export function toLocalId(ref: string): string {
  return isRemoteRef(ref) ? ref.slice(REMOTE_PREFIX.length) : ref;
}

/** Добавить префикс `remote:`, если его ещё нет. */
export function toRemoteRef(id: string): string {
  return isRemoteRef(id) ? id : `${REMOTE_PREFIX}${id}`;
}

/** Добавить поле origin к DTO сущности (без мутации исходного объекта). */
export function annotateOrigin<T extends object>(item: T, origin: Origin): T & { origin: Origin } {
  return { ...(item as Record<string, unknown>), origin } as T & { origin: Origin };
}

function rewriteStringField(out: Record<string, unknown>, key: string): void {
  const value = out[key];
  if (typeof value === 'string') out[key] = toRemoteRef(value);
}

/**
 * Переписать id и вложенные ссылки удалённой сущности на `remote:<...>`:
 * id, project_id, parent_id, references[].session_id.
 */
export function rewriteRemoteItem<T extends object>(item: T): T {
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  rewriteStringField(out, 'id');
  rewriteStringField(out, 'project_id');
  rewriteStringField(out, 'parent_id');
  if (Array.isArray(out.references)) {
    out.references = out.references.map((ref) => {
      if (ref && typeof ref === 'object' && typeof (ref as Record<string, unknown>).session_id === 'string') {
        const r = { ...(ref as Record<string, unknown>) };
        rewriteStringField(r, 'session_id');
        return r;
      }
      return ref;
    });
  }
  return out as T;
}

/** Одиночная удалённая сущность: переписать ссылки + добавить origin: 'remote'. */
export function toRemote<T extends object>(item: T): T & { origin: 'remote' } {
  return annotateOrigin(rewriteRemoteItem(item), 'remote') as T & { origin: 'remote' };
}

// ───────────────────────── camelCase-DTO удалённого мира ─────────────────────
//
// `rewriteRemoteItem` переписывает только snake_case-поля (`id`/`project_id`/
// `parent_id`) — этого достаточно сессиям и проектам. DTO памяти и пайплайнов
// отдают **camelCase** (`projectId`/`pipelineId`), поэтому для них — точечные
// хелперы ниже. Глобальную семантику `toRemote` не меняем: иначе у сущностей,
// где `projectId` не ссылка (например, входные тела), появился бы префикс.

/** Переписать строковое поле объекта, если оно строка (camelCase). */
function rewriteCamelField(out: Record<string, unknown>, key: string): void {
  const value = out[key];
  if (typeof value === 'string' && value !== '') out[key] = toRemoteRef(value);
}

/**
 * Индекс памяти удалённого мира: `id` и `projectId` → `remote:`.
 *
 * Индекс живёт на сервере: по этому id уходят `PATCH`/`rebuild`/`DELETE`
 * (вызывающий снимает префикс `toLocalId`).
 */
export function toRemoteMemoryIndex<T extends object>(index: T): T {
  const out: Record<string, unknown> = { ...(index as Record<string, unknown>) };
  rewriteCamelField(out, 'id');
  rewriteCamelField(out, 'projectId');
  return out as T;
}

/**
 * Ответ `GET /sessions/:id/memory` удалённой сессии (ADR-107).
 *
 * Переписываются: `scope.projectId`, `indexes.items[].projectId` и
 * `indexes.items[].id` (по последнему UI делает мутации индекса).
 */
export function toRemoteSessionMemory<T extends object>(dto: T): T & { origin: 'remote' } {
  const out: Record<string, unknown> = { ...(dto as Record<string, unknown>) };
  const scope = out.scope;
  if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
    out.scope = toRemoteMemoryIndex(scope as Record<string, unknown>);
  }
  const indexes = out.indexes;
  if (indexes && typeof indexes === 'object' && !Array.isArray(indexes)) {
    const container = { ...(indexes as Record<string, unknown>) };
    if (Array.isArray(container.items)) {
      container.items = container.items.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? toRemoteMemoryIndex(item as Record<string, unknown>)
          : item,
      );
    }
    out.indexes = container;
  }
  return annotateOrigin(out, 'remote') as T & { origin: 'remote' };
}

/**
 * Запись пайплайна удалённого мира: `id`/`projectId` → `remote:`.
 *
 * `projectId` в `draft` (спецификация) не трогаем: это часть неизменяемого
 * снимка спецификации, а не адрес сущности для последующих вызовов.
 */
export function toRemotePipeline<T extends object>(record: T): T {
  const out: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  rewriteCamelField(out, 'id');
  rewriteCamelField(out, 'projectId');
  return out as T;
}

/** Опубликованная версия пайплайна: `pipelineId` → `remote:`. */
export function toRemotePipelineVersion<T extends object>(version: T): T {
  const out: Record<string, unknown> = { ...(version as Record<string, unknown>) };
  rewriteCamelField(out, 'pipelineId');
  return out as T;
}

/**
 * Страница пайплайнов проекта (`GET /projects/:id/pipelines`).
 *
 * `{pipelines: [...], total, offset, limit, next_offset}` — переписываются
 * только записи; пагинация — числа.
 */
export function toRemotePipelinePage<T extends object>(page: T): T {
  const out: Record<string, unknown> = { ...(page as Record<string, unknown>) };
  if (Array.isArray(out.pipelines)) {
    out.pipelines = out.pipelines.map((item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? toRemotePipeline(item as Record<string, unknown>)
        : item,
    );
  }
  return out as T;
}

/**
 * Деталь пайплайна (`GET /projects/:id/pipelines/:pid`):
 * `{pipeline, published, versions}`.
 */
export function toRemotePipelineDetail<T extends object>(dto: T): T {
  const out: Record<string, unknown> = { ...(dto as Record<string, unknown>) };
  if (out.pipeline && typeof out.pipeline === 'object' && !Array.isArray(out.pipeline)) {
    out.pipeline = toRemotePipeline(out.pipeline as Record<string, unknown>);
  }
  if (out.published && typeof out.published === 'object' && !Array.isArray(out.published)) {
    out.published = toRemotePipelineVersion(out.published as Record<string, unknown>);
  }
  if (Array.isArray(out.versions)) {
    out.versions = out.versions.map((item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? toRemotePipelineVersion(item as Record<string, unknown>)
        : item,
    );
  }
  return out as T;
}

/** Прогон пайплайна удалённого мира: `id`/`projectId`/`pipelineId` → `remote:`. */
export function toRemotePipelineRun<T extends object>(run: T): T {
  const out: Record<string, unknown> = { ...(run as Record<string, unknown>) };
  rewriteCamelField(out, 'id');
  rewriteCamelField(out, 'projectId');
  rewriteCamelField(out, 'pipelineId');
  return out as T;
}

/** Страница прогонов (`GET /projects/:id/pipelines/:pid/runs`). */
export function toRemotePipelineRunPage<T extends object>(page: T): T {
  const out: Record<string, unknown> = { ...(page as Record<string, unknown>) };
  if (Array.isArray(out.runs)) {
    out.runs = out.runs.map((item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? toRemotePipelineRun(item as Record<string, unknown>)
        : item,
    );
  }
  return out as T;
}

/** Деталь прогона (`GET /pipeline-runs/:runId`): `{run, events, …}`. */
export function toRemotePipelineRunDetail<T extends object>(dto: T): T {
  const out: Record<string, unknown> = { ...(dto as Record<string, unknown>) };
  if (out.run && typeof out.run === 'object' && !Array.isArray(out.run)) {
    out.run = toRemotePipelineRun(out.run as Record<string, unknown>);
  }
  return out as T;
}

/**
 * Запись worktree удалённого проекта (ADR-114).
 *
 * **id worktree НЕ префиксуется**: он адресуется только внутри проекта
 * (`/projects/remote:<pid>/worktrees/<wid>`), а сервер ждёт исходный id —
 * поэтому префикс сделал бы `DELETE` невыполнимым. Ссылки на сущности мира
 * (`projectId`, `attachedSessionId`) — префиксуются: по ним UI сопоставляет
 * сессии из общего списка гибрида.
 */
export function toRemoteWorktree<T extends object>(worktree: T): T {
  const out: Record<string, unknown> = { ...(worktree as Record<string, unknown>) };
  rewriteCamelField(out, 'projectId');
  rewriteCamelField(out, 'attachedSessionId');
  return out as T;
}

/** Список worktree удалённого проекта (`{worktrees: [...]}`). */
export function toRemoteWorktreeList<T extends object>(payload: T): T {
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  if (Array.isArray(out.worktrees)) {
    out.worktrees = out.worktrees.map((item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? toRemoteWorktree(item as Record<string, unknown>)
        : item,
    );
  }
  return out as T;
}

export interface MergeItemsOptions {
  /** Для сессий, отфильтрованных по project_id: фильтровать удалённые по project_id (remote-ref). */
  remoteProjectId?: string;
}

/**
 * Объединить локальные и удалённые DTO в один список с полем origin.
 * Локальные — annotate origin:'local' (id как есть); удалённые — origin:'remote' +
 * переписанные remote-ссылки. Если передан remoteProjectId — удалённые фильтруются
 * по project_id (после переписывания ссылки, т.е. в форме `remote:<...>`).
 */
export function mergeItems<T extends object>(
  localItems: T[],
  remoteItems: T[],
  opts?: MergeItemsOptions,
): Array<T & { origin: Origin }> {
  const local = localItems.map((item) => annotateOrigin(item, 'local'));
  let remote = remoteItems.map((item) => toRemote(item));
  if (opts?.remoteProjectId !== undefined) {
    remote = remote.filter((item) => (item as Record<string, unknown>).project_id === opts.remoteProjectId);
  }
  return [...local, ...remote];
}

/**
 * Сопоставить RemoteError с HTTP-ответом API v2.
 * OFFLINE → 502, UNAUTHORIZED → 401, HTTP_<status> → <status>; не-RemoteError → null.
 */
export function remoteErrorToHttp(err: unknown): { status: number; code: string } | null {
  if (!(err instanceof RemoteError)) return null;
  if (err.code === 'OFFLINE') return { status: 502, code: 'OFFLINE' };
  if (err.code === 'UNAUTHORIZED') return { status: 401, code: 'UNAUTHORIZED' };
  if (err.code.startsWith('HTTP_')) {
    const status = Number(err.code.slice('HTTP_'.length));
    if (Number.isInteger(status)) return { status, code: err.code };
  }
  return { status: 500, code: err.code };
}
