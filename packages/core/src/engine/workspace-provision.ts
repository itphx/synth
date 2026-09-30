import { mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import type { WorkspaceOutsideRootPolicy } from '@itphx/synth-shared';
import { slugifyWorkspaceName, uniqueWorkspaceName } from '@itphx/synth-shared';
import type { ProjectStoreContract } from '../storage/project-store.js';

/**
 * AD-075: provisioning рабочего каталога проекта — общая логика HTTP-роутов и
 * тулов движка. Одинаковая семантика для core (standalone) и backend (managed):
 * нормализация строки, containment-проверка и создание каталога.
 */

export type WorkspaceResolveResult =
  | { ok: true; workspace: string | undefined; dir?: string }
  | { ok: false; status: 400 | 403 | 409 | 422; code: string; message: string };

/**
 * Нормализует workspace перед сохранением: относительный путь очищается от
 * ведущих './' и '/' (остаётся относительным — резолв происходит при
 * использовании), абсолютный путь остаётся как есть. '.' / '' → undefined.
 */
export function normalizeWorkspace(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withoutTrailing = trimmed.replace(/[/\\]+$/, '');
  if (!withoutTrailing) return undefined;
  if (isAbsolute(withoutTrailing)) return normalize(withoutTrailing);
  const rel = normalize(withoutTrailing).replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
  if (!rel || rel === '.' || rel === '..') return undefined;
  return rel;
}

/** true, если `abs` лежит внутри `root` (сам root не считается). */
export function isInsideRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * AD-075: нормализует и провижнит workspace локального проекта (standalone).
 * - относительный → сохраняется относительным, каталог создаётся от `workspacesRoot`;
 * - абсолютный внутри root → сохраняется относительным, каталог создаётся;
 * - абсолютный вне root → по политике: `deny` → 403,
 *   `confirm` без флага `confirmOutsideRoot` → 409;
 * - пустой → ничего не создаётся (используется default workspace).
 */
export async function resolveWorkspaceForLocalProject(
  value: string,
  confirmOutsideRoot: unknown,
  workspacesRoot: string | undefined,
  policy: WorkspaceOutsideRootPolicy,
): Promise<WorkspaceResolveResult> {
  const normalized = normalizeWorkspace(value);
  if (!normalized) return { ok: true, workspace: undefined };
  // Без настроенного root — legacy-поведение (только нормализация строки).
  if (!workspacesRoot) return { ok: true, workspace: normalized };

  let workspace: string;
  let dir: string;
  if (isAbsolute(normalized)) {
    if (isInsideRoot(workspacesRoot, normalized)) {
      workspace = relative(workspacesRoot, normalized);
      dir = normalized;
    } else {
      if (policy === 'deny') {
        return {
          ok: false,
          status: 403,
          code: 'WORKSPACE_OUTSIDE_ROOT_DENIED',
          message: 'Абсолютный workspace вне workspacesRoot запрещён политикой',
        };
      }
      if (confirmOutsideRoot !== true) {
        return {
          ok: false,
          status: 409,
          code: 'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED',
          message: 'Абсолютный workspace вне workspacesRoot требует подтверждения (confirmOutsideRoot: true)',
        };
      }
      workspace = normalized;
      dir = normalized;
    }
  } else {
    workspace = normalized;
    dir = resolve(workspacesRoot, normalized);
  }

  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      status: 422,
      code: 'WORKSPACE_CREATE_FAILED',
      message: `Не удалось создать каталог workspace: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, workspace, dir };
}

/**
 * AD-075 (managed): строгая проверка явного пути `project.workspace` — тот же
 * контракт, что у `resolveProjectWorkspace` (`server/fs-workspace.ts`).
 * - относительный внутри root → нормализуется;
 * - абсолютный внутри root → относительный;
 * - вне root / traversal → 403; корневой каталог / пустой → 400.
 */
export function validateManagedWorkspacePath(root: string, input: string): WorkspaceResolveResult {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'Путь не может быть пустым' };
  }

  if (isAbsolute(trimmed)) {
    const abs = normalize(trimmed);
    const rel = relative(root, abs);
    if (rel === '') {
      return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'Нельзя выбрать корневой каталог' };
    }
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        ok: false,
        status: 403,
        code: 'WORKSPACE_OUTSIDE_ROOT_DENIED',
        message: 'Абсолютный workspace вне workspacesRoot запрещён политикой',
      };
    }
    return { ok: true, workspace: rel };
  }

  const normalized = normalize(trimmed).replace(/^[/\\]+/, '');
  if (!normalized || normalized === '.') {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'Путь не может быть пустым' };
  }

  const fullPath = resolve(root, normalized);
  const rel = relative(root, fullPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false,
      status: 403,
      code: 'WORKSPACE_OUTSIDE_ROOT_DENIED',
      message: 'Путь выходит за пределы разрешённого корневого каталога',
    };
  }
  if (rel === '') {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'Нельзя выбрать корневой каталог' };
  }
  return { ok: true, workspace: rel };
}

export function workspaceCreateFailed(err: unknown): WorkspaceResolveResult {
  return {
    ok: false,
    status: 422,
    code: 'WORKSPACE_CREATE_FAILED',
    message: `Не удалось создать каталог workspace: ${err instanceof Error ? err.message : String(err)}`,
  };
}

/** Имена подкаталогов корня (чтобы авто-имя не «всмерилось» в чужой каталог). */
export async function collectExistingRootDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * AD-075 (managed): нормализует и провижнит workspace managed-проекта.
 * - явный путь: `validateManagedWorkspacePath` (deny вне root), затем `mkdir -p`;
 * - пустой: авто-имя (`slugifyWorkspaceName` + суффикс), каталог занимается
 *   атомарно `mkdir` без `recursive` (top-level), при `EEXIST` — следующий суффикс,
 *   поэтому два параллельных POST не получат один workspace.
 */
export async function provisionManagedWorkspace(
  store: ProjectStoreContract,
  root: string,
  name: string,
  rawWorkspace: unknown,
): Promise<WorkspaceResolveResult> {
  if (typeof rawWorkspace === 'string' && rawWorkspace.trim()) {
    const validation = validateManagedWorkspacePath(root, rawWorkspace);
    if (!validation.ok) return validation;
    try {
      await mkdir(resolve(root, validation.workspace as string), { recursive: true });
    } catch (err) {
      return workspaceCreateFailed(err);
    }
    return { ok: true, workspace: validation.workspace };
  }

  // Авто-имя: корень создаём заранее (top-level mkdir без recursive требует родителя).
  await mkdir(root, { recursive: true }).catch(() => {});
  const base = slugifyWorkspaceName(name);
  const knownWorkspaces = (await store.list())
    .map((p) => p.workspace)
    .filter((w): w is string => typeof w === 'string' && w.length > 0);
  const taken = new Set<string>([...knownWorkspaces, ...(await collectExistingRootDirs(root))]);

  for (let attempt = 0; attempt < 10_000; attempt++) {
    const candidate = uniqueWorkspaceName(base, [...taken]);
    try {
      await mkdir(resolve(root, candidate), { recursive: false });
      return { ok: true, workspace: candidate };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        // Каталог уже занят — следующий суффикс.
        taken.add(candidate);
        continue;
      }
      return workspaceCreateFailed(err);
    }
  }

  return {
    ok: false,
    status: 422,
    code: 'WORKSPACE_CREATE_FAILED',
    message: 'Не удалось подобрать свободное имя каталога workspace',
  };
}

/**
 * AD-075: provisioning workspace — managed (строгая проверка + авто-имя) либо
 * standalone (нормализация + политика confirm/deny). `undefined` — workspace не задан.
 */
export async function provisionWorkspace(
  store: ProjectStoreContract,
  name: string,
  rawWorkspace: unknown,
  confirmOutsideRoot: unknown,
  root: string | undefined,
  policy: WorkspaceOutsideRootPolicy,
  managed: boolean,
): Promise<WorkspaceResolveResult> {
  if (managed && root) {
    return provisionManagedWorkspace(store, root, name, rawWorkspace);
  }
  return resolveWorkspaceForLocalProject(
    typeof rawWorkspace === 'string' ? rawWorkspace : '',
    confirmOutsideRoot,
    root,
    policy,
  );
}
