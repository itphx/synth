import { readFile, writeFile, rename, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import {
  SKILL_NAME_MAX,
  SKILL_NAME_REGEX,
  parseFrontmatter,
  stringifyFrontmatter,
  AsyncLock,
  atomicWrite,
} from '@itphx/synth-shared';
import type { SkillFileEntry, SkillRepository } from './ports/skill-repository.js';

export interface SkillStoreConfig {
  dataDir: string;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  body?: string;
  files?: Record<string, string>;
  /**
   * Дополнительные ключи frontmatter (импорт из пакета/миграция между
   * backend'ами): сливаются поверх `name`/`description` — эти два поля всегда
   * берутся из входа и не перезаписываются заголовком.
   */
  frontmatter?: Record<string, unknown>;
}

export interface UpdateSkillMarkdownInput {
  description?: string;
  body?: string;
  /** Дополнительные ключи frontmatter (сливаются поверх существующих). */
  metadata?: Record<string, unknown>;
}

/**
 * ADR-046 §4.1/§4.3: instance-скиллы — дерево файлов под `{dataDir}/skills/<name>/`
 * (`SKILL.md` + supporting-файлы). Запись — атомарная (tmp → rename, ADR-005),
 * образец — `McpRegistryStore` (`AsyncLock` + `atomicWrite`).
 *
 * Пути — деталь этой реализации: порт (`SkillRepository`) их не отдаёт
 * (ADR-116), домен работает через `listFiles`/`readFile`/`writeFile`.
 */
export class SkillStore implements SkillRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: SkillStoreConfig) {}

  async exists(name: string): Promise<boolean> {
    try {
      await stat(join(this._dir(name), 'SKILL.md'));
      return true;
    } catch {
      return false;
    }
  }

  /** Имена instance-скиллов (каталоги с `SKILL.md`), отсортированы. */
  async listNames(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this._root(), { withFileTypes: true });
    } catch {
      return [];
    }
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await stat(join(this._root(), entry.name, 'SKILL.md'));
        names.push(entry.name);
      } catch {
        // каталог без SKILL.md — пропускаем
      }
    }
    return names.sort();
  }

  /** Сырой `SKILL.md` (null, если скилла нет). */
  async readMarkdown(name: string): Promise<string | null> {
    try {
      return await readFile(join(this._dir(name), 'SKILL.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  /** Создаёт instance-скилл. Ошибка, если уже существует. */
  async create(input: CreateSkillInput): Promise<void> {
    assertSkillName(input.name);
    await this._lock.acquire();
    try {
      if (await this.exists(input.name)) {
        throw new Error(`Скилл "${input.name}" уже существует`);
      }
      const data: Record<string, unknown> = { ...(input.frontmatter ?? {}) };
      data.name = input.name;
      data.description = input.description;
      const content = stringifyFrontmatter(data, input.body ?? '');
      await this._atomicWrite(join(this._dir(input.name), 'SKILL.md'), content);
      for (const [rel, body] of Object.entries(input.files ?? {})) {
        const target = this._safeResolve(input.name, rel);
        if (!target) throw new Error(`Небезопасный путь supporting-файла: ${rel}`);
        await this._atomicWrite(target, body);
      }
    } finally {
      this._lock.release();
    }
  }

  /** Перезаписывает `SKILL.md` (description/body/metadata) с сохранением прочих ключей. */
  async updateMarkdown(name: string, patch: UpdateSkillMarkdownInput): Promise<void> {
    assertSkillName(name);
    await this._lock.acquire();
    try {
      const raw = await this.readMarkdown(name);
      if (raw === null) {
        throw new Error(`Скилл "${name}" не найден`);
      }
      const fm = parseFrontmatter(raw);
      const data: Record<string, unknown> = { ...fm.data, name };
      if (patch.description !== undefined) data.description = patch.description;
      if (patch.metadata !== undefined) {
        const existing = typeof data.metadata === 'object' && data.metadata !== null && !Array.isArray(data.metadata)
          ? data.metadata as Record<string, unknown>
          : {};
        data.metadata = { ...existing, ...patch.metadata };
      }
      const body = patch.body !== undefined ? patch.body : fm.body;
      await this._atomicWrite(join(this._dir(name), 'SKILL.md'), stringifyFrontmatter(data, body));
    } finally {
      this._lock.release();
    }
  }

  /** Удаляет instance-скилл (всё дерево). */
  async remove(name: string): Promise<boolean> {
    assertSkillName(name);
    await this._lock.acquire();
    try {
      if (!(await this.exists(name))) return false;
      await rm(this._dir(name), { recursive: true, force: true });
      return true;
    } finally {
      this._lock.release();
    }
  }

  /** Читает supporting-файл (null — нет файла/небезопасный путь). */
  async readFile(name: string, relPath: string): Promise<string | null> {
    const target = this._safeResolve(name, relPath);
    if (!target) return null;
    try {
      return await readFile(target, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Записывает supporting-файл (атомарно, с созданием подкаталогов). */
  async writeFile(name: string, relPath: string, content: string): Promise<void> {
    assertSkillName(name);
    const target = this._safeResolve(name, relPath);
    if (!target) throw new Error(`Небезопасный путь supporting-файла: ${relPath}`);
    await this._lock.acquire();
    try {
      await this._atomicWrite(target, content);
    } finally {
      this._lock.release();
    }
  }

  /** Удаляет supporting-файл. */
  async deleteFile(name: string, relPath: string): Promise<boolean> {
    const target = this._safeResolve(name, relPath);
    if (!target) return false;
    await this._lock.acquire();
    try {
      await rm(target, { force: true });
      return true;
    } finally {
      this._lock.release();
    }
  }

  /**
   * Supporting-файлы скилла (рекурсивно, без `SKILL.md`), отсортированы по пути.
   * Отсутствующий каталог — `[]` (паритет с `listNames`).
   */
  async listFiles(name: string): Promise<SkillFileEntry[]> {
    const files: SkillFileEntry[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(rel ? join(this._dir(name), rel) : this._dir(name), {
          withFileTypes: true,
        });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(childRel);
        } else if (entry.isFile() && childRel !== 'SKILL.md') {
          try {
            const info = await stat(join(this._dir(name), childRel));
            files.push({ path: childRel, size: info.size });
          } catch {
            // гонка удаления — пропускаем
          }
        }
      }
    };
    await walk('');
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Корень instance-скиллов (внутренний путь файловой реализации). */
  private _root(): string {
    return join(this._config.dataDir, 'skills');
  }

  /** Каталог скилла (внутренний путь файловой реализации). */
  private _dir(name: string): string {
    assertSkillName(name);
    return join(this._root(), name);
  }

  private _safeResolve(name: string, relPath: string): string | null {
    const base = resolve(this._dir(name));
    const target = resolve(base, relPath);
    if (target !== base && !target.startsWith(base.endsWith(sep) ? base : base + sep)) return null;
    if (target === base) return null;
    return target;
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

function assertSkillName(name: string): void {
  if (!name || name.length > SKILL_NAME_MAX || !SKILL_NAME_REGEX.test(name)) {
    throw new Error(`Недопустимое имя скилла: ${name}`);
  }
}
