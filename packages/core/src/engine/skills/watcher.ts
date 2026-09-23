import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * AD-046 §8.3 / решение 2: ленивая инвалидация кэша скиллов по mtime.
 *
 * `fs.watch`/chokidar не используются: реестр при каждом обращении сравнивает
 * дешёвую подпись каталога-источника с сохранённой и пере-сканирует только при
 * изменении. Явный `POST /api/v2/skills/reload` вызывает `SkillRegistry.reload()`.
 */
export class SkillWatcher {
  private readonly _snapshots = new Map<string, string>();

  /**
   * Подпись каталога: `имя:floor(mtime):size` по каждому `SKILL.md` подкаталога
   * (отсортировано). Отсутствие каталога → пустая подпись.
   */
  async snapshot(sourceDir: string): Promise<string> {
    let entries;
    try {
      entries = await readdir(sourceDir, { withFileTypes: true });
    } catch {
      return '';
    }

    const parts: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const info = await stat(join(sourceDir, entry.name, 'SKILL.md'));
        parts.push(`${entry.name}:${Math.floor(info.mtimeMs)}:${info.size}`);
      } catch {
        // нет SKILL.md — не скилл
      }
    }
    parts.sort();
    return parts.join('|');
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
}
