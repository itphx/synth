import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandScanResult, CommandSource } from './types.js';
import { mergeCommandScans, scanCommandSource } from './discovery.js';

interface CacheEntry {
  signature: string;
  result: CommandScanResult;
}

/** Подпись каталога: `file:mtime:size` по каждому `*.md` (отсортировано). */
async function snapshotDir(dir: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    try {
      const info = await stat(join(dir, entry.name));
      parts.push(`${entry.name}:${Math.floor(info.mtimeMs)}:${info.size}`);
    } catch {
      // пропускаем
    }
  }
  parts.sort();
  return parts.join('|');
}

/**
 * AD-046 §8.3: реестр шаблонных команд — discovery + кэш с ленивой
 * mtime-инвалидацией (по образцу `SkillRegistry`).
 */
export class CommandRegistry {
  private readonly _cache = new Map<string, CacheEntry>();
  private readonly _sources: (opts?: { projectWorkspace?: string }) => CommandSource[] | Promise<CommandSource[]>;

  constructor(opts: {
    sources: (opts?: { projectWorkspace?: string }) => CommandSource[] | Promise<CommandSource[]>;
  }) {
    this._sources = opts.sources;
  }

  async list(opts?: { projectWorkspace?: string }): Promise<CommandScanResult> {
    const sources = await this._sources(opts);
    const entries: Array<{ source: CommandSource; result: CommandScanResult }> = [];
    for (const source of sources) {
      entries.push({ source, result: await this._loadSource(source) });
    }
    return mergeCommandScans(entries);
  }

  reload(): void {
    this._cache.clear();
  }

  private async _loadSource(source: CommandSource): Promise<CommandScanResult> {
    const signature = await snapshotDir(source.dir);
    const cached = this._cache.get(source.dir);
    if (cached && cached.signature === signature) return cached.result;
    const result = await scanCommandSource(source);
    this._cache.set(source.dir, { signature, result });
    return result;
  }
}
