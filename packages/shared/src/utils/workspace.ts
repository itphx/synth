// AD-075: утилиты авто-имени каталога workspace проекта.
// Используются гибридом (publish/fork, core `remote/transfer.ts`) и core-роутом
// проектов/тулом `project_create` при создании каталога без явного пути.

/** Максимальная длина слага каталога workspace (короче лимитов ФС). */
export const MAX_WORKSPACE_SLUG_LENGTH = 64;

/**
 * Преобразовать имя проекта в безопасное имя каталога: строчная латиница/цифры,
 * разделитель — одиночный дефис; обрезка до `MAX_WORKSPACE_SLUG_LENGTH`.
 * Пустой результат (в т.ч. не-латиница) → `project`.
 */
export function slugifyWorkspaceName(name: string): string {
  const slug = (name || 'project')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  const truncated = slug.slice(0, MAX_WORKSPACE_SLUG_LENGTH).replace(/-+$/g, '');
  return truncated || 'project';
}

/**
 * Уникальное имя каталога: `base`, при коллизии — `base-2`, `base-3`, …
 * `base` предполагается уже слагифицированным (`slugifyWorkspaceName`).
 */
export function uniqueWorkspaceName(base: string, existing: readonly string[]): string {
  const root = base || 'project';
  const taken = new Set(existing);
  if (!taken.has(root)) return root;
  let n = 2;
  while (taken.has(`${root}-${n}`)) n++;
  return `${root}-${n}`;
}
