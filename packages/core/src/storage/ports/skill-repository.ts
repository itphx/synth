import type { CreateSkillInput, UpdateSkillMarkdownInput } from '../skill-store.js';

/**
 * ADR-046 / ADR-116: порт instance-хранилища скиллов — `SKILL.md` (тело и
 * frontmatter) + supporting-файлы.
 *
 * Порт **не отдаёт файловых путей**: домен (`SkillService`/discovery/loader)
 * работает с именами скиллов и относительными путями внутри скилла. Где лежит
 * содержимое — деталь backend'а: файловое дерево `{dataDir}/skills/<name>/`
 * (file/memory, ADR-005) или blob-стор `skills/<name>/…` (PostgreSQL-драйвер,
 * ADR-116: метаданные в SQL, содержимое — в `BlobStore`).
 *
 * `root()`/`skillDir()` убраны: это были пути файловой реализации, и домен
 * собирал supporting-файлы обходом каталога (несовместимо с blob-содержимым).
 * Вместо них — `listFiles`.
 */

/** Файл скилла для домена: относительный путь внутри скилла и размер в байтах. */
export interface SkillFileEntry {
  /** Относительный путь (`notes/readme.md`); `SKILL.md` не включается. */
  path: string;
  /** Размер содержимого в байтах. */
  size: number;
}

/**
 * Порт instance-хранилища скиллов (ADR-046 §4.1/§4.3; ADR-096 — слой хранения).
 */
export interface SkillRepository {
  /** Есть ли скилл (есть `SKILL.md`). */
  exists(name: string): Promise<boolean>;
  /** Имена instance-скиллов (детерминированный порядок — по имени). */
  listNames(): Promise<string[]>;
  /** Сырой `SKILL.md` (`null`, если скилла нет). */
  readMarkdown(name: string): Promise<string | null>;
  /**
   * Создаёт скилл. Ошибка, если уже существует.
   *
   * `files` — supporting-файлы (относительные пути → содержимое),
   * `frontmatter` — дополнительные ключи заголовка (импорт/миграция); ключи
   * `name`/`description` берутся из входа и приоритетнее.
   */
  create(input: CreateSkillInput): Promise<void>;
  /** Перезаписывает `SKILL.md` (description/body/metadata) с сохранением прочих ключей. */
  updateMarkdown(name: string, patch: UpdateSkillMarkdownInput): Promise<void>;
  /** Удаляет скилл целиком (`true` — был, `false` — не было). */
  remove(name: string): Promise<boolean>;
  /** Читает supporting-файл (`null` — нет файла или небезопасный путь). */
  readFile(name: string, relPath: string): Promise<string | null>;
  /** Записывает supporting-файл (создаёт подкаталоги). */
  writeFile(name: string, relPath: string, content: string): Promise<void>;
  /** Удаляет supporting-файл (`false` — небезопасный путь). */
  deleteFile(name: string, relPath: string): Promise<boolean>;
  /**
   * Supporting-файлы скилла (рекурсивно, **без** `SKILL.md`), отсортированы по
   * пути. Неизвестный скилл — `[]`.
   */
  listFiles(name: string): Promise<SkillFileEntry[]>;
}
