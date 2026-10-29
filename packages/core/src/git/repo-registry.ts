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
 * (ведущие `./`, дублирующиеся `/`, хвостовой `/`) не должна мешать найти
 * репозиторий — `project_repo_fetch {path: "./app/"}` ищет ту же запись, что и
 * `path: "app"`.
 *
 * Это **только сравнение**, не резолв: `..`-сегменты и абсолютные пути
 * остаются как есть, поэтому на запись они по-прежнему не матчатся, а
 * containment проверяется отдельно (`GitService.resolveRepoPath`).
 */
export function comparableRepoPath(path: string | undefined): string {
  if (!path) return '';
  return path
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

/**
 * Запись реестра по `id` либо по пути (сравнение через `comparableRepoPath`).
 * Приоритет — `id`; пустой аргумент путь запись не ищет (иначе он совпал бы с
 * записью пустого пути — корнем workspace).
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
 * `./app` жили бы как два дубля. Канонический путь пуст (`.`/`./`) — остаётся
 * исходный: запись пустого пути не создаём.
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
