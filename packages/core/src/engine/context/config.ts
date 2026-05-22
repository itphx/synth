import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContextFileInfo, ContextFileContent, ContextCategory } from '@synth/shared';
import { atomicWrite } from '@synth/shared';
import { info, warning } from '../../logger.js';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

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

  private _enabledFiles: string[] = [];

  constructor(options: ContextConfigOptions) {
    this.systemPromptsDir = options.systemPromptsDir ?? join(CURRENT_DIR, '..', '..', '..', 'prompts');
    this.userPromptsDir = join(options.userDataDir, 'user');
    this.userRolesDir = join(options.userDataDir, 'roles');
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

  getStatusPrompt(mode: string, language = 'ru'): string {
    const baseStem = mode === 'orchestrator' ? 'ORCHESTRATOR' : 'SIMPLE';
    return this._readPrompt(baseStem, 'tsm', language) ?? '';
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
}
