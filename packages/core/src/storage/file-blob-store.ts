import { createReadStream } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { BlobReadRange, BlobStat, BlobStore } from './ports/blob-store.js';

export interface FileBlobStoreConfig {
  /** Корень blob-хранилища (абсолютный или относительный путь). */
  root: string;
}

/**
 * Файловая реализация `BlobStore` (ADR-005: атомарная запись tmp→rename).
 *
 * Containment: принимаются только относительные пути; `..`, `\` и абсолютные
 * пути отклоняются (по образцу `JsonStore._validateKey`). Итоговый путь
 * дополнительно проверяется префиксом корня.
 */
export class FileBlobStore implements BlobStore {
  private readonly _root: string;

  constructor(config: FileBlobStoreConfig) {
    this._root = resolve(config.root);
  }

  /** Валидация относительного пути (без выхода за корень). */
  private _validate(path: string): void {
    if (!path || isAbsolute(path) || path.includes('..') || path.includes('\\') || path.includes('\0')) {
      throw new Error(`Недопустимый путь blob: ${path}`);
    }
  }

  /** Абсолютный путь внутри корня (после валидации). */
  private _resolve(path: string): string {
    const target = resolve(this._root, path);
    const base = this._root.endsWith(sep) ? this._root : this._root + sep;
    if (target !== this._root && !target.startsWith(base)) {
      throw new Error(`Путь blob вне корня: ${path}`);
    }
    return target;
  }

  async read(path: string): Promise<Buffer | null> {
    this._validate(path);
    try {
      return await readFile(this._resolve(path));
    } catch {
      return null;
    }
  }

  async write(path: string, data: Buffer | string, opts?: { mode?: number }): Promise<void> {
    this._validate(path);
    const target = this._resolve(path);
    await mkdir(dirname(target), { recursive: true });

    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, buf, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
    await rename(tmp, target);
    // `rename` сохраняет права tmp-файла; при явном `mode` фиксируем его поверх umask.
    if (opts?.mode !== undefined) await chmod(target, opts.mode);
  }

  async append(path: string, data: Buffer | string): Promise<void> {
    this._validate(path);
    const target = this._resolve(path);
    await mkdir(dirname(target), { recursive: true });
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    await appendFile(target, buf);
  }

  async delete(path: string): Promise<void> {
    this._validate(path);
    await unlink(this._resolve(path)).catch(() => {});
  }

  async exists(path: string): Promise<boolean> {
    this._validate(path);
    try {
      await stat(this._resolve(path));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix?: string): Promise<Array<{ path: string; size: number }>> {
    const baseRel = (prefix ?? '').replace(/^[/\\]+|[/\\]+$/g, '');
    if (baseRel) this._validate(baseRel);

    const all: Array<{ path: string; size: number }> = [];
    await this._walk(this._root, '', all);

    const filtered = baseRel
      ? all.filter((e) => e.path === baseRel || e.path.startsWith(`${baseRel}/`))
      : all;
    return filtered.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * ADR-115: метаданные объекта (размер/mtime) — `null`, если объекта нет
   * или это не обычный файл.
   */
  async stat(path: string): Promise<BlobStat | null> {
    this._validate(path);
    try {
      const s = await stat(this._resolve(path));
      if (!s.isFile()) return null;
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * ADR-115: потоковое чтение объекта; диапазон — включительно с обоих
   * концов (как у `fs.createReadStream`). `null` — объекта нет (поток не
   * создаётся — вызывающий отдаёт 404 без чтения).
   */
  async readStream(path: string, opts?: BlobReadRange): Promise<Readable | null> {
    this._validate(path);
    const target = this._resolve(path);
    try {
      const s = await stat(target);
      if (!s.isFile()) return null;
    } catch {
      return null;
    }
    return createReadStream(target, {
      ...(opts?.start !== undefined ? { start: opts.start } : {}),
      ...(opts?.end !== undefined ? { end: opts.end } : {}),
    });
  }

  /** Рекурсивный обход с относительными (posix-style) путями. */
  private async _walk(absDir: string, relDir: string, out: Array<{ path: string; size: number }>): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Пропускаем незавершённые tmp-файлы атомарной записи.
      if (entry.name.includes('.tmp.')) continue;
      const abs = join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await this._walk(abs, rel, out);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const s = await stat(abs);
        out.push({ path: rel, size: s.size });
      } catch {
        // гонка удаления — пропускаем
      }
    }
  }
}
