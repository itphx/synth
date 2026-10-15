import { readFile, writeFile, rename, mkdir, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { SkillBundle } from '@itphx/synth-shared';
import { SKILL_NAME_REGEX, SKILL_NAME_MAX, AsyncLock, atomicWrite, stringifyFrontmatter } from '@itphx/synth-shared';
import { parseBundleFile } from '../engine/commands/bundles.js';
import type { SkillBundleRepository } from './ports/skill-bundle-repository.js';

export interface SkillBundleStoreConfig {
  dataDir: string;
  /** `config.commands.bundlesPath` (по умолчанию `skill-bundles`). */
  bundlesPath?: string;
}

/**
 * ADR-046 §7.3/§8.3: instance-хранилище bundles (`{dataDir}/{bundlesPath}/<name>.yaml`).
 * Запись — атомарная (tmp → rename, ADR-005), образец — `SkillStore`.
 */
export class SkillBundleStore implements SkillBundleRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: SkillBundleStoreConfig) {}

  root(): string {
    return join(this._config.dataDir, this._config.bundlesPath ?? 'skill-bundles');
  }

  file(name: string): string {
    assertBundleName(name);
    return join(this.root(), `${name}.yaml`);
  }

  async exists(name: string): Promise<boolean> {
    try {
      await readFile(this.file(name));
      return true;
    } catch {
      return false;
    }
  }

  async get(name: string): Promise<SkillBundle | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.file(name), 'utf-8');
    } catch {
      return undefined;
    }
    const parsed = parseBundleFile(raw, name);
    return parsed.bundle;
  }

  async list(): Promise<SkillBundle[]> {
    let entries;
    try {
      entries = await readdir(this.root(), { withFileTypes: true });
    } catch {
      return [];
    }
    const out: SkillBundle[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue;
      const name = entry.name.slice(0, -'.yaml'.length);
      if (name.length === 0 || name.length > SKILL_NAME_MAX || !SKILL_NAME_REGEX.test(name)) continue;
      const bundle = await this.get(name);
      if (bundle) out.push(bundle);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async set(bundle: SkillBundle): Promise<void> {
    assertBundleName(bundle.name);
    await this._lock.acquire();
    try {
      const content = stringifyFrontmatter(
        {
          name: bundle.name,
          description: bundle.description,
          skills: bundle.skills,
          ...(bundle.instruction !== undefined ? { instruction: bundle.instruction } : {}),
        },
        '',
      );
      await this._atomicWrite(this.file(bundle.name), content);
    } finally {
      this._lock.release();
    }
  }

  async remove(name: string): Promise<boolean> {
    assertBundleName(name);
    await this._lock.acquire();
    try {
      if (!(await this.exists(name))) return false;
      await rm(this.file(name), { force: true });
      return true;
    } finally {
      this._lock.release();
    }
  }

  private async _atomicWrite(path: string, data: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(
      (p, d) => writeFile(p, d, 'utf-8'),
      (o, n) => rename(o, n),
      path,
      data,
    );
  }
}

function assertBundleName(name: string): void {
  if (!name || name.length > SKILL_NAME_MAX || !SKILL_NAME_REGEX.test(name)) {
    throw new Error(`Недопустимое имя bundle: ${name}`);
  }
}
