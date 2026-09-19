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
    this.systemPromptsDir = options.systemPromptsDir ?? resolveSystemPromptsDir();
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

    for (const category of ['role', 'system'] as const) {
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

    // Осиротевшие overrides в system поддиректории userPromptsDir
    const seenByCategory: Record<string, Set<string>> = {};
    for (const cat of ['system'] as const) {
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
   * Файлы: prompts/system/RULES.{lang}.md (только локализованные, базового
   * RULES.md нет). Если для языка нет локализации — возвращается пустая строка ''.
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
   * Локализованные сообщения безопасности (deny/ask защищённых путей, запрещённых
   * команд). Файлы: prompts/security/{messageId}.{lang}.md → {messageId}.md.
   * Override через {userDataDir}/user/system/security/{messageId}.md и
   * {messageId}.{lang}.md — проверяется первым.
   *
   * Плейсхолдеры {{path}}, {{dir}}, {{command}}, {{reason}} заменяются значениями
   * из params (replace-подстановка через split/join — безопасно для `$`-символов).
   * Возвращает null, если файл не найден.
   */
  getSecurityMessage(messageId: string, language = 'ru', params?: Record<string, string>): string | null {
    const stem = messageId;

    // 1. Пользовательский override system-категории (каталог security/)
    const overridePath = this._resolveOverridePath('system', `security/${stem}.md`);
    const overrideLocalized = this._getLocalizedPath(overridePath, stem, language);
    if (overrideLocalized) {
      const content = this._readFile(overrideLocalized);
      if (content) return this._substParams(content, params);
    }
    const overrideContent = this._readFile(overridePath);
    if (overrideContent) return this._substParams(overrideContent, params);

    // 2. Встроенный prompts/security/{stem}.{lang}.md → {stem}.md
    const basePath = join(this.systemPromptsDir, 'security', `${stem}.md`);
    const localized = this._getLocalizedPath(basePath, stem, language);
    if (localized) {
      const content = this._readFile(localized);
      if (content) return this._substParams(content, params);
    }
    const baseContent = this._readFile(basePath);
    if (baseContent) return this._substParams(baseContent, params);

    return null;
  }

  /** Заменяет {{key}} на значения из params (split/join — без интерпретации `$`). */
  private _substParams(content: string, params?: Record<string, string>): string {
    if (!params) return content;
    let out = content;
    for (const [key, value] of Object.entries(params)) {
      out = out.split(`{{${key}}}`).join(value);
    }
    return out;
  }

  /**
   * AD-025: системный промпт режима сессии (plan/act/yolo).
   *
   * Файлы: prompts/system/MODE_{PLAN,ACT,YOLO}.{lang}.md — только локализованные
   * (базовых MODE_{X}.md больше нет). Override через {userDataDir}/user/system/
   * MODE_{X}.md и MODE_{X}.{lang}.md — стандартный механизм system-категории
   * (сохранение через saveFile/getFile/UI), проверяется первым.
   *
   * Приоритет: override локализованный → override базовый → встроенный локализованный.
   * Возвращает null, если файл не найден (неизвестный язык или режим).
   */
  getModePrompt(mode: string, language = 'ru'): string | null {
    const stem = `MODE_${mode.toUpperCase()}`;

    // 1. Пользовательский override system-категории
    const overridePath = this._resolveOverridePath('system', `${stem}.md`);
    const overrideLocalized = this._getLocalizedPath(overridePath, stem, language);
    if (overrideLocalized) {
      const content = this._readFile(overrideLocalized);
      if (content) return content;
    }
    const overrideContent = this._readFile(overridePath);
    if (overrideContent) return overrideContent;

    // 2. Встроенный prompts/system/MODE_{X}.{lang}.md
    return this._readPrompt(stem, 'system', language);
  }

  /**
   * AD-028/AD-039: промпт строгости цикла Plan→Build (auto/strict).
   *
   * Файлы: prompts/system/PLAN_MODE_AUTO.{lang}.md,
   * prompts/system/PLAN_MODE_STRICT_APPROVED.{lang}.md,
   * prompts/system/PLAN_MODE_STRICT_NOT_APPROVED.{lang}.md — только локализованные
   * (базовых PLAN_MODE_*.md нет). Override через {userDataDir}/user/system/ —
   * стандартный механизм system-категории, проверяется первым.
   *
   * Приоритет: override локализованный → override базовый → встроенный локализованный.
   * planMode 'off' → null (планирование отключено, блок не нужен).
   * Неизвестный язык → null (нет локализованного файла).
   */
  getPlanModePrompt(
    planMode: 'auto' | 'strict' | 'off',
    planApproved: boolean,
    language = 'ru',
  ): string | null {
    if (planMode === 'off') return null;
    const stem = planMode === 'auto'
      ? 'PLAN_MODE_AUTO'
      : planApproved
        ? 'PLAN_MODE_STRICT_APPROVED'
        : 'PLAN_MODE_STRICT_NOT_APPROVED';

    // 1. Пользовательский override system-категории
    const overridePath = this._resolveOverridePath('system', `${stem}.md`);
    const overrideLocalized = this._getLocalizedPath(overridePath, stem, language);
    if (overrideLocalized) {
      const content = this._readFile(overrideLocalized);
      if (content) return content;
    }
    const overrideContent = this._readFile(overridePath);
    if (overrideContent) return overrideContent;

    // 2. Встроенный prompts/system/{stem}.{lang}.md
    return this._readPrompt(stem, 'system', language);
  }

  /**
   * AD-039: инструкция по обновлению плана и todo.
   * Файлы: prompts/system/PLAN_GUIDE.{lang}.md — только локализованные
   * (базового PLAN_GUIDE.md нет). Override через {userDataDir}/user/system/.
   * Возвращает null, если файл не найден (неизвестный язык).
   */
  getPlanGuide(language = 'ru'): string | null {
    const stem = 'PLAN_GUIDE';

    // 1. Пользовательский override system-категории
    const overridePath = this._resolveOverridePath('system', `${stem}.md`);
    const overrideLocalized = this._getLocalizedPath(overridePath, stem, language);
    if (overrideLocalized) {
      const content = this._readFile(overrideLocalized);
      if (content) return content;
    }
    const overrideContent = this._readFile(overridePath);
    if (overrideContent) return overrideContent;

    // 2. Встроенный prompts/system/PLAN_GUIDE.{lang}.md
    return this._readPrompt(stem, 'system', language);
  }

  /**
   * AD-070 §3.1: политика режимов сессии (plan/act/yolo) — константный
   * stable-блок `mode.policy`. Что такое режимы, что переключение делает только
   * пользователь, что часть тулов может быть недоступна в текущем режиме.
   *
   * Файлы: prompts/system/MODE_POLICY.{lang}.md — только локализованные.
   * Override через {userDataDir}/user/system/ — стандартный механизм
   * system-категории, проверяется первым. Возвращает null, если файл не найден.
   */
  getModePolicy(language = 'ru'): string | null {
    const stem = 'MODE_POLICY';

    // 1. Пользовательский override system-категории
    const overridePath = this._resolveOverridePath('system', `${stem}.md`);
    const overrideLocalized = this._getLocalizedPath(overridePath, stem, language);
    if (overrideLocalized) {
      const content = this._readFile(overrideLocalized);
      if (content) return content;
    }
    const overrideContent = this._readFile(overridePath);
    if (overrideContent) return overrideContent;

    // 2. Встроенный prompts/system/MODE_POLICY.{lang}.md
    return this._readPrompt(stem, 'system', language);
  }
}
