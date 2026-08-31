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
