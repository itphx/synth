import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isProjectWorkspaceTrusted } from './scope.js';

/** Раскрывает `~`/`~/…` в домашний каталог. */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(home, p.slice(2));
  return p;
}

/** Нормализует список доверенных проектных каталогов (раскрывает `~`, убирает пустые). */
export function normalizeTrustedProjectDirs(
  dirs: readonly string[],
  home: string = homedir(),
): string[] {
  return dirs
    .map((d) => expandHome(d.trim(), home))
    .filter((d) => d.length > 0);
}

/**
 * ADR-046 §4.4: бинарный project-trust. Недоверенный проектный каталог виден в
 * реестре, но скиллы из него не грузятся; trust выдаётся явно через
 * `skills.trustedProjectDirs`.
 */
export function isProjectTrusted(
  projectWorkspace: string,
  trustedProjectDirs: readonly string[],
  home: string = homedir(),
): boolean {
  return isProjectWorkspaceTrusted(projectWorkspace, normalizeTrustedProjectDirs(trustedProjectDirs, home));
}
