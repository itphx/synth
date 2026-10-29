/**
 * ADR-076: реестр git-репозиториев проекта — поиск и upsert записи.
 *
 * Один и тот же реестр (`project.repos`) правят два контура: тулы
 * (`engine/tools/project-repos.ts`) и HTTP-роуты (`server/routes/git.ts`).
 * Пока сравнение пути и upsert жили в каждом контуре отдельно, они разошлись:
 * тул нашёл запись по `./app`, а роут — нет, и `project_repo_add app` +
 * `project_repo_add ./app` создавали две записи. Поэтому сравнение и
 * канонизация пути — здесь, в одной точке.
 *
 * Здесь **только** сравнение/канонизация косметики пути. Containment
 * (абсолютный путь, `..`, симлинки наружу workspace) — отдельно, в
 * `GitService.resolveRepoPath`; смешивать нельзя, иначе «похожесть» пути
 * начнёт подменять проверку прав.
 */

import { randomUUID } from 'node:crypto';
import type { GitRepoConfig } from '@itphx/synth-shared';

/** Вход upsert записи реестра (merge с существующей по `id`/`path`). */
export interface RepoRegistryInput {
  id?: string;
  path: string;
  name?: string;
  url?: string;
  type?: 'https' | 'ssh';
  defaultBranch?: string;
  sshKeyId?: string;
  lastFetch?: string;
}

/**
 * Путь записи реестра в виде, пригодном для сравнения: косметика записи
 * (сегменты `.`, ведущие `./`, дублирующиеся `/`, хвостовой `/`, `\` вместо `/`)
 * не должна мешать найти репозиторий — `project_repo_fetch {path: "./app//"}`
 * ищет ту же запись, что и `path: "app"`.
 *
 * Это **только сравнение**, не резолв: `..`-сегменты остаются как есть (`a/../b`
 * остаётся `a/../b` и на `b` не матчится), а containment проверяется отдельно
 * (`GitService.resolveRepoPath`).
 *
 * Абсолютные пути (POSIX `/…`, Windows `C:\…`/`C:/…`, UNC `\\server\share`) —
 * отдельная ветка: только унификация разделителей и схлопывание `//`, поэтому
 * абсолютный путь по-прежнему не равен относительному (и запись реестра им не
 * находится).
 *
 * Путь из одних `.`/`./` — семантика «корень workspace» — канонизируется в `'.'`
 * (не в пустую строку: иначе запись `path: '.'` перестала бы находиться и
 * `upsert` начал бы плодить дубли). Пустой вход (`''`/`undefined`) → `''`
 * («запись не ищем»).
 *
 * Обратные слэши трактуются как разделители: Windows-инсталляции и агенты
 * присылают `\`. На POSIX это сознательный компромисс — имя каталога с `\` в
 * названии сравнится как путь (для реестра репозиториев это безопаснее, чем не
 * найти запись).
 */
export function comparableRepoPath(path: string | undefined): string {
  if (!path) return '';
  const unified = path.replace(/\\/g, '/');
  if (isAbsoluteRepoPath(unified)) {
    return unified.replace(/\/{2,}/g, '/');
  }
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  return segments.length > 0 ? segments.join('/') : '.';
}

/** Абсолютный путь в любой нотации (уже с прямыми слэшами): POSIX, Windows, UNC. */
function isAbsoluteRepoPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

/**
 * Запись реестра по `id` либо по пути (сравнение через `comparableRepoPath`).
 * Приоритет — `id`; пустой аргумент путь запись не ищет (иначе он совпал бы с
 * записью корня workspace, чей путь канонизируется в `'.'`).
 */
export function findRepoEntry(
  repos: GitRepoConfig[],
  id?: string,
  path?: string,
): GitRepoConfig | undefined {
  if (id) return repos.find((r) => r.id === id);
  const wanted = comparableRepoPath(path);
  if (!wanted) return undefined;
  return repos.find((r) => comparableRepoPath(r.path) === wanted);
}

/**
 * Upsert записи реестра (match по `id` или нормализованному пути). Чистая
 * функция: ничего не сохраняет — запись проекта делает вызывающий (у тула и
 * роута свои сторы/хуки).
 *
 * Сохраняется **канонический** путь (`./app` → `app`) — иначе запись `app` и
 * `./app` жили бы как два дубля. Запись корня workspace (`.`/`./`) остаётся `'.'`
 * — иначе она перестала бы находиться по `'.'`, а upsert создавал бы дубль.
 * Пустой вход (`''`) — остаётся исходный: запись пустого пути не создаём.
 */
export function upsertRepoEntry(
  repos: GitRepoConfig[],
  input: RepoRegistryInput,
): { entry: GitRepoConfig; next: GitRepoConfig[]; existing?: GitRepoConfig } {
  const existing = (input.id ? repos.find((r) => r.id === input.id) : undefined)
    ?? findRepoEntry(repos, undefined, input.path);

  const entry: GitRepoConfig = {
    id: existing?.id ?? input.id ?? randomUUID(),
    path: comparableRepoPath(input.path) || input.path,
    name: input.name ?? existing?.name,
    url: input.url ?? existing?.url,
    type: input.type ?? existing?.type,
    defaultBranch: input.defaultBranch ?? existing?.defaultBranch,
    sshKeyId: input.sshKeyId ?? existing?.sshKeyId,
    lastFetch: input.lastFetch ?? existing?.lastFetch,
  };

  const next = existing
    ? repos.map((r) => (r === existing ? entry : r))
    : [...repos, entry];
  return { entry, next, ...(existing ? { existing } : {}) };
}
