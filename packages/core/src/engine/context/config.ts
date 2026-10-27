import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContextFileInfo, ContextFileContent, ContextCategory } from '@itphx/synth-shared';
import { atomicWrite } from '@itphx/synth-shared';
import { info, warning } from '../../logger.js';
import type { ContextFileRepository } from '../../storage/ports/context-file-repository.js';

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
  /**
   * Источник пользовательских override-файлов (ADR-116). Не задан — файловый
   * (`{userDataDir}/user`, `{userDataDir}/roles`, `{userDataDir}/user/system`),
   * как раньше; в PostgreSQL-драйвере — процесс-локальный кэш таблицы
   * `context_files` (`PgContextFileRepository`).
   */
  overrides?: ContextOverrideSource;
}

/** Пользовательский override-файл (категория + имя + размер/время). */
export interface ContextOverrideEntry {
  category: ContextCategory;
  filename: string;
  content?: string;
  size: number;
  /** Время последней записи, мс (эпоха). */
  modifiedAt: number;
}

/**
 * Источник пользовательских override-файлов порта `ContextFileRepository`
 * (ADR-096/ADR-116).
 *
 * Синхронный (сборка промпта на горячем пути). Файловая реализация читает
 * `{userDataDir}`, PostgreSQL-драйвер — процесс-локальный кэш строк таблицы
 * `context_files` (прогрев — `warm()`/`reload()`).
 */
export interface ContextOverrideSource {
  /** Есть ли override (без чтения содержимого). */
  has(category: ContextCategory, filename: string): boolean;
  /** Содержимое override (`null` — нет файла). */
  read(category: ContextCategory, filename: string): string | null;
  /** Все пользовательские файлы (без системных промптов образа). */
  list(): ContextOverrideEntry[];
}

/** Путь пользовательского override-файла в файловой раскладке. */
function userOverridePath(
  dirs: { promptsDir: string; rolesDir: string },
  category: ContextCategory,
  filename: string,
): string {
  if (category === 'role') return join(dirs.rolesDir, filename);
  if (category === 'user') return join(dirs.promptsDir, filename);
  return join(dirs.promptsDir, CATEGORY_DIRS[category], filename);
}

/** Рекурсивный список `.md`-файлов; `filename` — относительный путь от `baseDir`. */
function scanMarkdownFiles(
  baseDir: string,
  onFile: (filename: string, size: number, modifiedAt: number) => void,
): void {
  const walk = (currentDir: string, relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, rel);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      try {
        const s = statSync(fullPath);
        onFile(rel, s.size, s.mtimeMs);
      } catch {
        // гонка удаления — пропускаем
      }
    }
  };
  walk(baseDir, '');
}

/**
 * Файловый источник override-файлов (поведение прежнее): `{userDataDir}/user/*.md`
 * — категория `user`, `{userDataDir}/roles/*.md` — `role`,
 * `{userDataDir}/user/system/**` — override системных промптов.
 */
export class FileContextOverrideSource implements ContextOverrideSource {
  constructor(private readonly _dirs: { promptsDir: string; rolesDir: string }) {}

  has(category: ContextCategory, filename: string): boolean {
    return existsSync(userOverridePath(this._dirs, category, filename));
  }

  read(category: ContextCategory, filename: string): string | null {
    return readTextFile(userOverridePath(this._dirs, category, filename));
  }

  list(): ContextOverrideEntry[] {
    const out: ContextOverrideEntry[] = [];
    // Роли — плоский каталог (имя файла = имя роли).
    try {
      for (const entry of readdirSync(this._dirs.rolesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        try {
          const s = statSync(join(this._dirs.rolesDir, entry.name));
          out.push({ category: 'role', filename: entry.name, size: s.size, modifiedAt: s.mtimeMs });
        } catch {
          // ignore
        }
      }
    } catch {
      // каталога нет
    }
    // Пользовательские файлы — верхний уровень.
    try {
      for (const entry of readdirSync(this._dirs.promptsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        try {
          const s = statSync(join(this._dirs.promptsDir, entry.name));
          out.push({ category: 'user', filename: entry.name, size: s.size, modifiedAt: s.mtimeMs });
        } catch {
          // ignore
        }
      }
    } catch {
      // каталога нет
    }
    // Override системных промптов — `user/system/**`.
    scanMarkdownFiles(join(this._dirs.promptsDir, CATEGORY_DIRS.system), (filename, size, modifiedAt) => {
      out.push({ category: 'system', filename, size, modifiedAt });
    });
    return out;
  }
}

/** Чтение текстового файла; `null` — нет файла/ошибка. */
function readTextFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

export class ContextConfig implements ContextFileRepository {
  readonly systemPromptsDir: string;
  readonly userPromptsDir: string;
  readonly userRolesDir: string;

  private _enabledFiles: string[] = [];
  private readonly _overrides: ContextOverrideSource;

  constructor(options: ContextConfigOptions) {
    this.systemPromptsDir = options.systemPromptsDir ?? resolveSystemPromptsDir();
    this.userPromptsDir = join(options.userDataDir, 'user');
    this.userRolesDir = join(options.userDataDir, 'roles');
    this._enabledFiles = ['SOUL.md', 'COMPANY.md', 'ABOUT.md'];
    this._overrides = options.overrides ?? new FileContextOverrideSource({
      promptsDir: this.userPromptsDir,
      rolesDir: this.userRolesDir,
    });
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

  /**
   * Локализованное имя override-файла в той же поддиректории:
   * `system/MODE_PLAN.md` + `ru` → `system/MODE_PLAN.ru.md`.
   */
  private _localizedOverrideName(filename: string, stem: string, language: string): string {
    const slash = filename.lastIndexOf('/');
    const dir = slash >= 0 ? filename.slice(0, slash + 1) : '';
    return `${dir}${stem}.${language}.md`;
  }

  /** Override-файл: локализованный вариант, затем базовый (как раньше). */
  private _readOverridePair(
    category: ContextCategory,
    filename: string,
    stem: string,
    language: string,
  ): string | null {
    const localized = this._overrides.read(
      category,
      this._localizedOverrideName(filename, stem, language),
    );
    if (localized) return localized;
    return this._overrides.read(category, filename);
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
    const overrides = this._overrides.list();
    const byKey = new Map(
      overrides.map((entry) => [`${entry.category}\0${entry.filename}`, entry] as const),
    );

    // 1. Системные роли и системные промпты (промпты образа — всегда ФС).
    const systemRoleNames = new Set<string>();
    const systemPaths = new Set<string>();
    scanMarkdownFiles(this._resolveSystemPath('role'), (filename, size, modifiedAt) => {
      const name = filename.split('/').pop() ?? filename;
      systemRoleNames.add(name);
      const override = byKey.get(`role\0${name}`);
      files.push({
        filename: name,
        isSystem: true,
        isOverridden: override !== undefined,
        category: 'role',
        // У перекрытой роли размер/время — из override (паритет с прежним поведением).
        size: override?.size ?? size,
        modifiedAt: override?.modifiedAt ?? modifiedAt,
      });
    });
    scanMarkdownFiles(this._resolveSystemPath('system'), (filename, size, modifiedAt) => {
      systemPaths.add(filename);
      files.push({
        filename,
        isSystem: true,
        isOverridden: byKey.has(`system\0${filename}`),
        category: 'system',
        size,
        modifiedAt,
      });
    });

    // 2. Пользовательские файлы и override'ы (не системные).
    for (const entry of overrides) {
      const enabled = this._enabledFiles.includes(entry.filename);
      if (entry.category === 'role') {
        if (systemRoleNames.has(entry.filename)) continue;
        files.push({
          filename: entry.filename,
          isSystem: false,
          isOverridden: false,
          category: 'role',
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          enabled,
        });
        continue;
      }
      if (entry.category === 'user') {
        // `listAllFiles` показывает только верхний уровень (паритет с ФС-раскладкой).
        if (entry.filename.includes('/')) continue;
        files.push({
          filename: entry.filename,
          isSystem: false,
          isOverridden: false,
          category: 'user',
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          enabled,
        });
        continue;
      }
      // override системного промпта, которого нет в образе (осиротевший).
      if (systemPaths.has(entry.filename)) continue;
      files.push({
        filename: entry.filename,
        isSystem: false,
        isOverridden: true,
        category: 'system',
        size: entry.size,
        modifiedAt: entry.modifiedAt,
      });
    }

    files.sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return a.filename.localeCompare(b.filename);
    });
    return files;
  }

  // --- Чтение файла ---

  getFile(filename: string, category: ContextCategory): ContextFileContent | null {
    const override = this._overrides.read(category, filename);
    if (override !== null) {
      return { filename, content: override, isSystem: false, isOverridden: true, category };
    }

    if (category === 'user') return null;

    const systemPath = join(this._resolveSystemPath(category), filename);
    const content = this._readFile(systemPath);
    if (content !== null) {
      return { filename, content, isSystem: true, isOverridden: false, category };
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
    const stem = contextFile.replace(/\.md$/, '');

    // 1. Пользовательский override в roles/ (базовый, затем локализованный).
    const roleOverride = this._overrides.read('role', contextFile);
    if (roleOverride) return roleOverride;
    const roleLocalized = this._overrides.read(
      'role',
      this._localizedOverrideName(contextFile, stem, language),
    );
    if (roleLocalized) return roleLocalized;

    // 2. fallback: user/ категория (только при явном contextFileOverride)
    if (contextFileOverride) {
      const userOverride = this._overrides.read('user', contextFile);
      if (userOverride) return userOverride;
      const userLocalized = this._overrides.read(
        'user',
        this._localizedOverrideName(contextFile, stem, language),
      );
      if (userLocalized) return userLocalized;
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

  /**
   * ADR-051: статическое описание системного пользователя «Scheduler»
   * (prompt-блок `scheduler`, включается в сессиях с активным расписанием).
   * Файлы: prompts/system/SCHEDULER.{lang}.md — только локализованные
   * (базового SCHEDULER.md нет). Override через {userDataDir}/user/system/ —
   * стандартный механизм system-категории, проверяется первым.
   * Возвращает пустую строку, если файл не найден.
   */
  getSchedulerNotice(language = 'ru'): string {
    const stem = 'SCHEDULER';

    // 1. Пользовательский override system-категории
    const override = this._readOverridePair('system', `${stem}.md`, stem, language);
    if (override) return override;

    // 2. Встроенный prompts/system/SCHEDULER.{lang}.md
    return this._readPrompt(stem, 'system', language) ?? '';
  }

  /**
   * ADR-051: volatile-пояснение для хода, инициированного планировщиком, —
   * «текущее сообщение автоматическое, человек не участвует». Блок
   * `scheduler.turn` (volatile, order 40).
   *
   * Файлы: prompts/system/SCHEDULER_TURN.{lang}.md — только локализованные
   * (базового SCHEDULER_TURN.md нет). Override через {userDataDir}/user/system/ —
   * стандартный механизм system-категории, проверяется первым.
   * Возвращает пустую строку, если файл не найден.
   */
  getSchedulerTurnNotice(language = 'ru'): string {
    const stem = 'SCHEDULER_TURN';

    // 1. Пользовательский override system-категории
    const override = this._readOverridePair('system', `${stem}.md`, stem, language);
    if (override) return override;

    // 2. Встроенный prompts/system/SCHEDULER_TURN.{lang}.md
    return this._readPrompt(stem, 'system', language) ?? '';
  }

  /**
   * Требование «только текст» для финального шага-отчёта саб-агента,
   * которого коснулся лимит шагов (механика opencode: принудительный
   * финальный шаг с запретом инструментов).
   *
   * Файлы: prompts/system/MAX_STEPS.{lang}.md — только локализованные
   * (базового MAX_STEPS.md нет). Override через {userDataDir}/user/system/ —
   * стандартный механизм system-категории, проверяется первым.
   * Плейсхолдер `{limit}` подставляет вызывающий код (лимит шагов агента).
   * Возвращает пустую строку, если файл не найден.
   */
  getMaxStepsPrompt(language = 'ru'): string {
    const stem = 'MAX_STEPS';

    // 1. Пользовательский override system-категории
    const override = this._readOverridePair('system', `${stem}.md`, stem, language);
    if (override) return override;

    // 2. Встроенный prompts/system/MAX_STEPS.{lang}.md
    return this._readPrompt(stem, 'system', language) ?? '';
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

  /**
   * ADR-115: блок «вложения не доставлены» для LLM-сообщения (шаблон с
   * плейсхолдером `{items}` — списком отброшенных вложений).
   *
   * Файлы: prompts/system/ATTACHMENTS_DROPPED.{lang}.md — только локализованные
   * (базового ATTACHMENTS_DROPPED.md нет). Override через
   * {userDataDir}/user/system/ — стандартный механизм system-категории,
   * проверяется первым. Возвращает пустую строку, если файла нет (вызывающий
   * код переходит на короткую техническую строку).
   */
  getAttachmentsDroppedTemplate(language = 'ru'): string {
    const stem = 'ATTACHMENTS_DROPPED';

    // 1. Пользовательский override system-категории
    const override = this._readOverridePair('system', `${stem}.md`, stem, language);
    if (override) return override;

    // 2. Встроенный prompts/system/ATTACHMENTS_DROPPED.{lang}.md
    return this._readPrompt(stem, 'system', language) ?? '';
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
   * ADR-036: инструкция по работе с обфусцированными секретами (⟦SYNTH_SECRET_N⟧).
   * Файлы: prompts/system/GATEWAY.{lang}.md → GATEWAY.md (fallback).
   */
  getGatewayInstructions(language = 'ru'): string {
    return this._readPrompt('GATEWAY', 'system', language) ?? '';
  }

  /**
   * ADR-107: инструкция по работе с памятью (только когда память доступна в
   * сессии). Файлы: prompts/system/MEMORY.{lang}.md → MEMORY.md (fallback).
   */
  getMemoryInstructions(language = 'ru'): string {
    return this._readPrompt('MEMORY', 'system', language) ?? '';
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
    const override = this._readOverridePair('system', `security/${stem}.md`, stem, language);
    if (override) return this._substParams(override, params);

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
   * ADR-025: системный промпт режима сессии (plan/act/yolo).
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
    const override = this._readOverridePair('system', `${stem}.md`, stem, language);
    if (override) return override;

    // 2. Встроенный prompts/system/MODE_{X}.{lang}.md
    return this._readPrompt(stem, 'system', language);
  }

  /**
   * ADR-028/ADR-039: промпт строгости цикла Plan→Build (auto/strict).
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
    const override = this._readOverridePair('system', `${stem}.md`, stem, language);
    if (override) return override;

    // 2. Встроенный prompts/system/{stem}.{lang}.md
    return this._readPrompt(stem, 'system', language);
  }

  /**
   * ADR-039: инструкция по обновлению плана и todo.
   * Файлы: prompts/system/PLAN_GUIDE.{lang}.md — только локализованные
   * (базового PLAN_GUIDE.md нет). Override через {userDataDir}/user/system/.
   * Возвращает null, если файл не найден (неизвестный язык).
   */
  getPlanGuide(language = 'ru'): string | null {
    const stem = 'PLAN_GUIDE';

    // 1. Пользовательский override system-категории
    const override = this._readOverridePair('system', `${stem}.md`, stem, language);
    if (override) return override;

    // 2. Встроенный prompts/system/PLAN_GUIDE.{lang}.md
    return this._readPrompt(stem, 'system', language);
  }

  /**
   * ADR-070 §3.1: политика режимов сессии (plan/act/yolo) — константный
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
    const override = this._readOverridePair('system', `${stem}.md`, stem, language);
    if (override) return override;

    // 2. Встроенный prompts/system/MODE_POLICY.{lang}.md
    return this._readPrompt(stem, 'system', language);
  }

  /**
   * ADR-034: инструкция классификации задачи (вызов `classify_conversation`).
   * Файлы: prompts/system/CLASSIFICATION.{lang}.md — только локализованные.
   * Override через {userDataDir}/user/system/ — стандартный механизм
   * system-категории, проверяется первым. Возвращает пустую строку, если файла нет.
   */
  getClassificationInstructions(language = 'ru'): string {
    const stem = 'CLASSIFICATION';

    // 1. Пользовательский override system-категории
    const override = this._readOverridePair('system', `${stem}.md`, stem, language);
    if (override) return override;

    // 2. Встроенный prompts/system/CLASSIFICATION.{lang}.md
    return this._readPrompt(stem, 'system', language) ?? '';
  }
}
