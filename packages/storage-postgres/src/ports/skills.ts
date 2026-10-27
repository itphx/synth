/**
 * PG-реализация порта **instance-скиллов** (ADR-046 §4, ADR-116, ADR-097).
 *
 * Разделение хранения (ADR-116 §«Что переводится»):
 * - **метаданные** (заголовок `SKILL.md` — `name`/`description`/прочие ключи) —
 *   таблица `instance_skills` (миграция `026_instance_skills`): имя — ключ,
 *   `frontmatter` jsonb, `updated_at` — служебная метка записи;
 * - **содержимое** (`SKILL.md` и supporting-файлы) — blob-стор под
 *   `skills/<name>/SKILL.md` и `skills/<name>/<relPath>` (`BlobStore` остаётся
 *   файловым по конструкции, ADR-116 §2).
 *
 * Порт не отдаёт путей (ADR-116): домен работает через `listFiles`/`readFile`/
 * `writeFile`, раскладка blob-стора — деталь этой реализации.
 *
 * Семантика повторяет файловую реализацию core (`SkillStore`) и in-memory
 * (`MemorySkillRepository`):
 * - `create` — ошибка на дубль имени; `frontmatter` входа сохраняется, ключи
 *   `name`/`description` берутся из входа;
 * - `updateMarkdown` — перезапись заголовка с сохранением прочих ключей;
 * - `remove` — удаление записи и **всех** объектов скилла в blob-сторе;
 * - `listFiles` — supporting-файлы (без `SKILL.md`), относительные пути, размеры
 *   в байтах, порядок по пути;
 * - небезопасные относительные пути (`..`, абсолютные, `\`) не читаются и не
 *   пишутся.
 *
 * Порядок записи: сначала содержимое (`BlobStore`), затем метаданные — при сбое
 * второй записи «висящих» записей в таблице не остаётся (лишние объекты
 * blob-стора безвредны: их видно только через `listFiles` существующего скилла).
 */

import {
  SKILL_NAME_MAX,
  SKILL_NAME_REGEX,
  parseFrontmatter,
  stringifyFrontmatter,
} from '@itphx/synth-shared';
import type {
  BlobStore,
  CreateSkillInput,
  SkillRepository,
  StorageContext,
  UpdateSkillMarkdownInput,
} from '@itphx/synth-core';
import { jsonbParam } from '../json-param.js';
import type { PortDeps } from './deps.js';

/** Часть `StorageContext`, которой владеет группа «skills». */
export type SkillPorts = Pick<StorageContext, 'skills'>;

/** Корневой префикс скиллов в blob-сторе. */
const SKILLS_BLOB_PREFIX = 'skills';

/** Имя файла заголовка внутри каталога скилла. */
const SKILL_MARKDOWN_FILE = 'SKILL.md';

/** Проверка имени скилла (1–64, `^[a-z0-9]+(-[a-z0-9]+)*$`). */
function assertSkillName(name: string): void {
  if (!name || name.length > SKILL_NAME_MAX || !SKILL_NAME_REGEX.test(name)) {
    throw new Error(`Недопустимое имя скилла: ${name}`);
  }
}

/**
 * Нормализованный относительный путь внутри скилла; `null` — путь небезопасен
 * (абсолютный, с `..`, обратным слешем или NUL). Семантика — как у
 * `MemorySkillRepository.safeRelPath`.
 */
function safeRelPath(relPath: string): string | null {
  if (
    !relPath ||
    relPath.startsWith('/') ||
    relPath.includes('..') ||
    relPath.includes('\\') ||
    relPath.includes('\0')
  ) {
    return null;
  }
  const normalized = relPath.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!normalized) return null;
  return normalized;
}

/** Префикс каталога скилла в blob-сторе (`skills/<name>/`). */
function skillPrefix(name: string): string {
  return `${SKILLS_BLOB_PREFIX}/${name}/`;
}

/** Путь `SKILL.md` скилла в blob-сторе. */
function markdownPath(name: string): string {
  return `${skillPrefix(name)}${SKILL_MARKDOWN_FILE}`;
}

/**
 * ADR-116: instance-скиллы — метаданные в `instance_skills`, содержимое в
 * `BlobStore`.
 */
export class PgSkillRepository implements SkillRepository {
  constructor(
    private readonly _deps: PortDeps,
    private readonly _blobs: BlobStore,
  ) {}

  async exists(name: string): Promise<boolean> {
    // Невалидное имя не может быть в таблице — отвечаем `false`, а не ошибкой
    // (паритет с file/memory: `exists` не бросает).
    try {
      assertSkillName(name);
    } catch {
      return false;
    }
    const rows = await this._deps.connection.query<{ name: string }>(
      'SELECT name FROM instance_skills WHERE name = $1 LIMIT 1',
      [name],
    );
    return rows.length > 0;
  }

  async listNames(): Promise<string[]> {
    const rows = await this._deps.connection.query<{ name: string }>(
      'SELECT name FROM instance_skills ORDER BY name ASC',
    );
    return rows.map((row) => row.name);
  }

  async readMarkdown(name: string): Promise<string | null> {
    try {
      assertSkillName(name);
    } catch {
      return null;
    }
    const buffer = await this._blobs.read(markdownPath(name));
    return buffer ? buffer.toString('utf-8') : null;
  }

  async create(input: CreateSkillInput): Promise<void> {
    assertSkillName(input.name);
    if (await this.exists(input.name)) {
      throw new Error(`Скилл "${input.name}" уже существует`);
    }

    const frontmatter: Record<string, unknown> = { ...(input.frontmatter ?? {}) };
    frontmatter.name = input.name;
    frontmatter.description = input.description;
    const markdown = stringifyFrontmatter(frontmatter, input.body ?? '');

    await this._blobs.write(markdownPath(input.name), markdown);
    for (const [rel, content] of Object.entries(input.files ?? {})) {
      const target = safeRelPath(rel);
      if (!target) throw new Error(`Небезопасный путь supporting-файла: ${rel}`);
      await this._blobs.write(`${skillPrefix(input.name)}${target}`, content);
    }
    await this._upsertMetadata(input.name, frontmatter);
  }

  async updateMarkdown(name: string, patch: UpdateSkillMarkdownInput): Promise<void> {
    assertSkillName(name);
    const raw = await this.readMarkdown(name);
    if (raw === null) {
      throw new Error(`Скилл "${name}" не найден`);
    }
    const frontmatter = parseFrontmatter(raw);
    const data: Record<string, unknown> = { ...frontmatter.data, name };
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.metadata !== undefined) {
      const existing =
        typeof data.metadata === 'object' && data.metadata !== null && !Array.isArray(data.metadata)
          ? (data.metadata as Record<string, unknown>)
          : {};
      data.metadata = { ...existing, ...patch.metadata };
    }
    const body = patch.body !== undefined ? patch.body : frontmatter.body;

    await this._blobs.write(markdownPath(name), stringifyFrontmatter(data, body));
    await this._upsertMetadata(name, data);
  }

  async remove(name: string): Promise<boolean> {
    assertSkillName(name);
    if (!(await this.exists(name))) return false;
    // Содержимое: все объекты каталога скилла (`SKILL.md` + supporting).
    const objects = await this._blobs.list(skillPrefix(name));
    for (const object of objects) {
      await this._blobs.delete(object.path);
    }
    await this._deps.connection.query('DELETE FROM instance_skills WHERE name = $1', [name]);
    return true;
  }

  async readFile(name: string, relPath: string): Promise<string | null> {
    const target = safeRelPath(relPath);
    if (!target) return null;
    const buffer = await this._blobs.read(`${skillPrefix(name)}${target}`);
    return buffer ? buffer.toString('utf-8') : null;
  }

  async writeFile(name: string, relPath: string, content: string): Promise<void> {
    assertSkillName(name);
    const target = safeRelPath(relPath);
    if (!target) throw new Error(`Небезопасный путь supporting-файла: ${relPath}`);
    await this._blobs.write(`${skillPrefix(name)}${target}`, content);
  }

  async deleteFile(name: string, relPath: string): Promise<boolean> {
    const target = safeRelPath(relPath);
    if (!target) return false;
    // Удаление отсутствующего файла — не ошибка (паритет с file/memory).
    await this._blobs.delete(`${skillPrefix(name)}${target}`);
    return true;
  }

  async listFiles(name: string): Promise<Array<{ path: string; size: number }>> {
    const prefix = skillPrefix(name);
    const objects = await this._blobs.list(prefix);
    const files: Array<{ path: string; size: number }> = [];
    for (const object of objects) {
      if (!object.path.startsWith(prefix)) continue;
      const rel = object.path.slice(prefix.length);
      if (!rel || rel === SKILL_MARKDOWN_FILE) continue;
      files.push({ path: rel, size: object.size });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Upsert метаданных: заголовок скилла и служебная метка записи. */
  private async _upsertMetadata(name: string, frontmatter: Record<string, unknown>): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO instance_skills (name, frontmatter, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (name) DO UPDATE SET
         frontmatter = EXCLUDED.frontmatter,
         updated_at = now()`,
      [name, jsonbParam(frontmatter)],
    );
  }
}

/** Собрать порт instance-скиллов (ADR-046 §4, ADR-116). */
export function buildSkillPorts(deps: PortDeps, blobs: BlobStore): SkillPorts {
  return {
    skills: new PgSkillRepository(deps, blobs),
  };
}
