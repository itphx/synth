import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContextFileInfo, ContextFileContent, ContextCategory } from '@itphx/synth-shared';
import { atomicWrite } from '@itphx/synth-shared';
import { info, warning } from '../../logger.js';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Резолвинг корня пакета @itphx/synth-core по package.json — поиск вверх от startDir.
 * Работает одинаково при src-запуске (tsx), dist-запуске и в установленном пакете
 * node_modules/@itphx/synth-core (включая Docker-образ, где копируется только dist/).
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

/**
 * Каталог встроенных промптов: {root}/prompts (источник, публикуется в npm через files).
 * Fallback на {root}/dist/prompts — сборка core копирует промпты в dist/, поэтому
 * в Docker-образе (где рядом с package.json нет prompts/, а есть только dist/)
 * промпты находятся там.
 */
function resolveSystemPromptsDir(): string {
  const root = findPackageRoot(CURRENT_DIR);
  const candidates = [join(root, 'prompts'), join(root, 'dist', 'prompts')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

const CATEGORY_DIRS: Record<ContextCategory, string> = {
  user: 'user',
  role: 'roles',
  system: 'system',
  tsm: 'tsm',
};

interface ContextConfigOptions {
  userDataDir: string;
  systemPromptsDir?: string;
}

export class ContextConfig {
  readonly systemPromptsDir: string;
  readonly userPromptsDir: string;
  readonly userRolesDir: string;
  readonly userModesDir: string;

  private _enabledFiles: string[] = [];

  constructor(options: ContextConfigOptions) {
    this.systemPromptsDir = options.systemPromptsDir ?? resolveSystemPromptsDir();
    this.userPromptsDir = join(options.userDataDir, 'user');
    this.userRolesDir = join(options.userDataDir, 'roles');
    this.userModesDir = join(options.userDataDir, 'modes');
    this._enabledFiles = ['SOUL.md', 'COMPANY.md', 'ABOUT.md'];
  }

  private _getLocalizedPath(basePath: string, stem: string, language: string): string | null {
    const parent = dirname(basePath);
    const localized = join(parent, `${stem}.${language}.md`);
    return existsSync(localized) ? localized : null;
  }

  private _resolveSystemPath(category: ContextCategory): string {
    return join(this.systemPromptsDir, CATEGORY_DIRS[category]);
  }

  private _resolveOverridePath(category: ContextCategory, filename: string): string {
    if (category === 'role') return join(this.userRolesDir, filename);
    if (category === 'user') return join(this.userPromptsDir, filename);
    return join(this.userPromptsDir, CATEGORY_DIRS[category], filename);
  }

  private _readFile(path: string): string | null {
    try {
      if (!existsSync(path)) return null;
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  }

  private _readPrompt(baseStem: string, category: ContextCategory, language: string): string | null {
    const systemDir = this._resolveSystemPath(category);
    const basePath = join(systemDir, `${baseStem}.md`);

    const localized = this._getLocalizedPath(basePath, baseStem, language);
    if (localized) {
      const content = this._readFile(localized);
      if (content) return content;
    }

    return this._readFile(basePath) ?? null;
  }

  // --- Список всех файлов ---

  listAllFiles(): ContextFileInfo[] {
    const files: ContextFileInfo[] = [];
    const overriddenRoles: Set<string> = new Set();
    const overriddenRolePaths: Map<string, string> = new Map();

    if (existsSync(this.userRolesDir)) {
      try {
        for (const e of readdirSync(this.userRolesDir, { withFileTypes: true })) {
          if (!e.isFile() || !e.name.endsWith('.md')) continue;
          const p = join(this.userRolesDir, e.name);
          overriddenRoles.add(e.name);
          overriddenRolePaths.set(e.name, p);
        }
      } catch { /* ignore */ }
    }

    for (const category of ['role', 'system', 'tsm'] as const) {
      const systemDir = this._resolveSystemPath(category);
      if (!existsSync(systemDir)) continue;

      try {
        this._collectFilesRecursive(systemDir, systemDir, category, overriddenRoles, overriddenRolePaths, files);
      } catch { /* ignore */ }
    }

    // кастомные роли только в userRolesDir
    const roleFileNames = files.filter(f => f.category === 'role').map(f => f.filename);
    for (const [name, p] of overriddenRolePaths) {
      if (roleFileNames.includes(name)) continue;
      try {
        const s = statSync(p);
        files.push({
          filename: name,
          isSystem: false,
          isOverridden: false,
          category: 'role',
          size: s.size,
          modifiedAt: s.mtimeMs,
          enabled: this._enabledFiles.includes(name),
        });
      } catch { /* ignore */ }
    }

    // user files из userPromptsDir
    if (existsSync(this.userPromptsDir)) {
      try {
        for (const e of readdirSync(this.userPromptsDir, { withFileTypes: true })) {
          if (!e.isFile() || !e.name.endsWith('.md')) continue;
          const p = join(this.userPromptsDir, e.name);
          const s = statSync(p);
          files.push({
            filename: e.name,
            isSystem: false,
            isOverridden: false,
            category: 'user',
            size: s.size,
            modifiedAt: s.mtimeMs,
            enabled: this._enabledFiles.includes(e.name),
          });
        }
      } catch { /* ignore */ }
    }

    // Осиротевшие overrides в system/tsm поддиректориях userPromptsDir
    const seenByCategory: Record<string, Set<string>> = {};
    for (const cat of ['system', 'tsm'] as const) {
      seenByCategory[cat] = new Set(files.filter(f => f.category === cat).map(f => f.filename));
      const overrideDir = join(this.userPromptsDir, CATEGORY_DIRS[cat]);
      if (existsSync(overrideDir)) {
        for (const e of readdirSync(overrideDir, { withFileTypes: true })) {
          if (!e.isFile() || !e.name.endsWith('.md')) continue;
          if (seenByCategory[cat]!.has(e.name)) continue;
          const p = join(overrideDir, e.name);
          const s = statSync(p);
          files.push({
            filename: e.name,
            isSystem: false,
            isOverridden: true,
            category: cat,
            size: s.size,
            modifiedAt: s.mtimeMs,
          });
        }
      }
    }

    files.sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return a.filename.localeCompare(b.filename);
    });
    return files;
  }

  private _collectFilesRecursive(
    baseDir: string,
    currentDir: string,
    category: ContextCategory,
    overriddenRoles: Set<string>,
    overriddenRolePaths: Map<string, string>,
    files: ContextFileInfo[],
  ): void {
    for (const e of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = join(currentDir, e.name);
      if (e.isDirectory()) {
        this._collectFilesRecursive(baseDir, fullPath, category, overriddenRoles, overriddenRolePaths, files);
        continue;
      }
      if (!e.name.endsWith('.md')) continue;

      const relativePath = fullPath.substring(baseDir.length + 1);

      let statSource = fullPath;
      let isOverridden = false;

      if (category === 'role') {
        isOverridden = overriddenRoles.has(e.name);
        if (isOverridden) statSource = overriddenRolePaths.get(e.name)!;
      } else {
        isOverridden = existsSync(this._resolveOverridePath(category, e.name));
      }

      try {
        const s = statSync(statSource);
        files.push({
          filename: category === 'role' ? e.name : relativePath,
          isSystem: true,
          isOverridden,
          category,
          size: s.size,
          modifiedAt: s.mtimeMs,
        });
      } catch { /* ignore */ }
    }
  }

  // --- Чтение файла ---

  getFile(filename: string, category: ContextCategory): ContextFileContent | null {
    const overridePath = this._resolveOverridePath(category, filename);
    if (existsSync(overridePath)) {
      const content = this._readFile(overridePath);
      if (content !== null) {
        return { filename, content, isSystem: false, isOverridden: true, category };
      }
    }

    if (category === 'user') return null;

    const systemPath = join(this._resolveSystemPath(category), filename);
    if (existsSync(systemPath)) {
      const content = this._readFile(systemPath);
      if (content !== null) {
        return { filename, content, isSystem: true, isOverridden: false, category };
      }
    }

    return null;
  }

  // --- Сохранение / удаление / восстановление ---

  async saveFile(filename: string, content: string, category: ContextCategory): Promise<boolean> {
    const dir = category === 'role'
      ? this.userRolesDir
      : category === 'user'
        ? this.userPromptsDir
        : join(this.userPromptsDir, CATEGORY_DIRS[category]);

    try {
      await mkdir(dir, { recursive: true });
      const path = join(dir, filename);
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        rename,
        path,
        content,
      );
      info('CONTEXT', `Saved context file: ${category}/${filename}`);
      return true;
    } catch (e) {
      warning('CONTEXT', `Failed to save context file ${category}/${filename}: ${e}`);
      return false;
    }
  }

  async deleteFile(filename: string, category: ContextCategory): Promise<boolean> {
    const path = this._resolveOverridePath(category, filename);
    if (!existsSync(path)) return false;
    try {
      await unlink(path);
      info('CONTEXT', `Deleted context file: ${category}/${filename}`);
      return true;
    } catch (e) {
      warning('CONTEXT', `Failed to delete context file: ${e}`);
      return false;
    }
  }

  restoreFile(filename: string, category: ContextCategory): Promise<boolean> {
    return this.deleteFile(filename, category);
  }

  // --- Enabled files ---

  getEnabledFiles(): string[] {
    return [...this._enabledFiles];
  }

  setEnabledFiles(files: string[]): void {
    this._enabledFiles = [...files];
  }

  // --- Специализированные загрузчики ---

  getRolePrompt(agentId: string, contextFileOverride?: string, language = 'ru'): string | null {
    const contextFile = contextFileOverride || `${agentId.toUpperCase()}.md`;

    // 1. Проверяем пользовательский override в roles/
    const userRolePath = this._resolveOverridePath('role', contextFile);
    if (this._readFile(userRolePath)) return this._readFile(userRolePath);

    const stem = contextFile.replace(/\.md$/, '');
    const userLocalized = this._getLocalizedPath(userRolePath, stem, language);
    if (userLocalized && this._readFile(userLocalized)) return this._readFile(userLocalized);

    // 2. fallback: user/ категория (только при явном contextFileOverride)
    if (contextFileOverride) {
      const userPath = this._resolveOverridePath('user', contextFile);
      const content = this._readFile(userPath);
      if (content) return content;
      const userLoc = this._getLocalizedPath(userPath, stem, language);
      if (userLoc && this._readFile(userLoc)) return this._readFile(userLoc);
    }

    // 3. Системный prompts/roles/
    const systemDir = this._resolveSystemPath('role');
    const basePath = join(systemDir, contextFile);
    const localized = this._getLocalizedPath(basePath, stem, language);
    if (localized) {
      const content = this._readFile(localized);
      if (content) return content;
    }

    return this._readFile(basePath);
  }

  getRolesDescription(language = 'ru'): string {
    return this._readPrompt('ROLES_DESCRIPTION', 'system', language) ?? '';
  }

  getInterviewTemplate(language = 'ru'): string {
    return this._readPrompt('INTERVIEW', 'system', language) ?? '';
  }

  getParticipantsNotice(language = 'ru'): string {
    return this._readPrompt('PARTICIPANTS_NOTICE', 'system', language) ?? '';
  }

  getSummarizerPrompt(language = 'ru'): string {
    return this._readPrompt('SUMMARIZER', 'system', language) ?? '';
  }

  getUserContextTemplate(language = 'ru'): string {
    return this._readPrompt('USER_CONTEXT', 'system', language) ?? '';
  }

  getCompressedDialogTemplate(language = 'ru'): string {
    return this._readPrompt('COMPRESSED_DIALOG', 'system', language) ?? '';
  }

  getStickyNotesTemplate(language = 'ru'): string {
    return this._readPrompt('STICKY_NOTES', 'system', language) ?? '';
  }

  getRoutingInstructions(language = 'ru'): string {
    return this._readPrompt('ROUTING', 'system', language) ?? '';
  }

  /**
   * Глобальная секция [RULES] защиты от Indirect Prompt Injection.
   * Файлы: prompts/system/RULES.{lang}.md → RULES.md (fallback).
   */
  getRules(language = 'ru'): string {
    return this._readPrompt('RULES', 'system', language) ?? '';
  }

  /**
   * AD-036: инструкция по работе с обфусцированными секретами (⟦SYNTH_SECRET_N⟧).
   * Файлы: prompts/system/GATEWAY.{lang}.md → GATEWAY.md (fallback).
   */
  getGatewayInstructions(language = 'ru'): string {
    return this._readPrompt('GATEWAY', 'system', language) ?? '';
  }

  /**
   * AD-025: системный промпт режима сессии (plan/act/yolo).
   *
   * Приоритет (по аналогии с getRolePrompt):
   *   1. Пользовательский override: {userDataDir}/modes/{mode}.{lang}.md → {mode}.md
   *   2. Встроенный: {systemPromptsDir}/modes/{mode}.{lang}.md → {mode}.md
   * Возвращает null, если файл не найден (fallback на встроенный текст движка).
   */
  getModePrompt(mode: string, language = 'ru'): string | null {
    const stem = mode;

    // 1. Пользовательский override
    const userBasePath = join(this.userModesDir, `${stem}.md`);
    const userLocalized = this._getLocalizedPath(userBasePath, stem, language);
    if (userLocalized) {
      const content = this._readFile(userLocalized);
      if (content) return content;
    }
    const userContent = this._readFile(userBasePath);
    if (userContent) return userContent;

    // 2. Встроенный prompts/modes/
    const systemBasePath = join(this.systemPromptsDir, 'modes', `${stem}.md`);
    const systemLocalized = this._getLocalizedPath(systemBasePath, stem, language);
    if (systemLocalized) {
      const content = this._readFile(systemLocalized);
      if (content) return content;
    }
    return this._readFile(systemBasePath);
  }
}
