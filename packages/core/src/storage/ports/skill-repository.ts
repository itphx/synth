import type { CreateSkillInput, UpdateSkillMarkdownInput } from '../skill-store.js';

/**
 * Порт instance-хранилища скиллов — дерево файлов (`SKILL.md` + supporting)
 * (ADR-046, реализация — `SkillStore`).
 *
 * `root()`/`skillDir()` — пути файлового дерева, используются доменом
 * (`SkillService` собирает supporting-файлы по `skillDir`). Это переходный
 * слой: на следующем шаге W2.1+ дерево скиллов переводится на `BlobStore`, а
 * path-методы уходят из порта (@future-backend — дерево в объектном хранилище).
 */
export interface SkillRepository {
  /** Корень instance-скиллов. @future-backend — деталь файловой реализации. */
  root(): string;
  /** Абсолютный путь каталога скилла. @future-backend — деталь файловой реализации. */
  skillDir(name: string): string;
  exists(name: string): Promise<boolean>;
  listNames(): Promise<string[]>;
  readMarkdown(name: string): Promise<string | null>;
  create(input: CreateSkillInput): Promise<void>;
  updateMarkdown(name: string, patch: UpdateSkillMarkdownInput): Promise<void>;
  remove(name: string): Promise<boolean>;
  readFile(name: string, relPath: string): Promise<string | null>;
  writeFile(name: string, relPath: string, content: string): Promise<void>;
  deleteFile(name: string, relPath: string): Promise<boolean>;
}
