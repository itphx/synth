import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillRepository } from '../../storage/ports/skill-repository.js';
import { filesSignature } from '../file-signature.js';
import type { SkillSource } from './types.js';

/**
 * ADR-046 §8.3 / решение 2: ленивая инвалидация кэша скиллов по сигнатуре
 * источника.
 *
 * `fs.watch`/chokidar не используются: реестр при каждом обращении сравнивает
 * дешёвую подпись каталога-источника с сохранённой и пере-сканирует только при
 * изменении. Явный `POST /api/v2/skills/reload` вызывает `SkillRegistry.reload()`.
 *
 * Два вида источника (ADR-116):
 * - ФС-каталог (project/config/external/url) — `filesSignature` по `SKILL.md`
 *   подкаталогов (`floor(mtimeMs):size`, см. `file-signature.ts`);
 * - порт `SkillRepository` (instance) — путей нет, подпись строится по составу
 *   (`listNames`) и размеру `SKILL.md` (`readMarkdown`): правка тела меняет
 *   подпись. Состав supporting-файлов в подпись **не** входит намеренно:
 *   `listFiles` в blob-бэкенде — обход дерева на каждый скилл, а любая запись
 *   через домен (`create`/`updateMarkdown`/`writeFile`/`remove`) и так вызывает
 *   `SkillRegistry.reload()`.
 */
export class SkillWatcher {
  private readonly _snapshots = new Map<string, string>();

  /**
   * Подпись источника. ФС-каталог: `имя:floor(mtime):size` по каждому
   * `SKILL.md` подкаталога. Порт: `имя:размер SKILL.md` по каждому скиллу.
   * Отсутствие каталога/пустой репозиторий → пустая подпись.
   */
  async snapshot(source: SkillSource | string): Promise<string> {
    if (typeof source !== 'string' && source.repository) {
      return this._portSignature(source.repository);
    }
    const sourceDir = typeof source === 'string' ? source : source.dir;
    let entries;
    try {
      entries = await readdir(sourceDir, { withFileTypes: true });
    } catch {
      return '';
    }

    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    return filesSignature(
      dirs.map((name) => ({ id: name, path: join(sourceDir, name, 'SKILL.md') })),
    );
  }

  /** Сохранённая подпись каталога (последний успешный скан). */
  cached(sourceDir: string): string | undefined {
    return this._snapshots.get(sourceDir);
  }

  /** Запоминает подпись после успешного сканирования. */
  remember(sourceDir: string, signature: string): void {
    this._snapshots.set(sourceDir, signature);
  }

  /** Сброс подписей (принудительный reload). */
  clear(): void {
    this._snapshots.clear();
  }

  /**
   * Подпись порт-источника: состав скиллов (`listNames`) и размер `SKILL.md`
   * (`readMarkdown`). Ошибка чтения одного скилла не ломает подпись — он
   * учитывается как пустой (пере-скан покажет фактическое состояние).
   */
  private async _portSignature(repository: SkillRepository): Promise<string> {
    let names: string[];
    try {
      names = [...(await repository.listNames())].sort();
    } catch {
      return '';
    }
    const parts: string[] = [];
    for (const name of names) {
      let markdownSize = 0;
      try {
        markdownSize = Buffer.byteLength((await repository.readMarkdown(name)) ?? '', 'utf-8');
      } catch {
        markdownSize = 0;
      }
      parts.push(`${name}:${markdownSize}`);
    }
    return parts.join('|');
  }
}
