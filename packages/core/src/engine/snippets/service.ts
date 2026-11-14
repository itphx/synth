import { mkdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, stringifyFrontmatter } from '@itphx/synth-shared';
import { isProjectTrusted } from '../skills/trust.js';
import {
  buildSnippetSources,
  instanceSnippetsDir,
  projectSnippetsDir,
  userSnippetsDir,
} from './discovery.js';
import { expandSnippetMentions } from './expand.js';
import { SnippetRegistry, resolveSnippet, resolveUntrustedSnippet } from './registry.js';
import { SNIPPET_NAME_REGEX } from './types.js';
import type {
  Snippet,
  SnippetDiagnostic,
  SnippetScope,
} from './types.js';
import type { ExpandSnippetsResult } from './expand.js';

/**
 * ADR-141 §4: фасад сниппетов — список, чтение, запись и раскрытие.
 *
 * Содержимое — **файлы** (как команды/скиллы), порт хранилища и PostgreSQL
 * здесь не заводим: сниппеты — это контент-файлы markdown, а не записи БД.
 * Запись атомарная (tmp → rename, ADR-005).
 */

/** Коды отказов доменного слоя сниппетов. */
export type SnippetErrorCode =
  | 'invalid-name'
  | 'invalid-alias'
  | 'missing-user'
  | 'missing-workspace'
  | 'not-found'
  | 'conflict';

/** Доменная ошибка сниппетов (машинный код + текст). */
export class SnippetError extends Error {
  constructor(
    readonly code: SnippetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SnippetError';
  }
}

export interface SnippetServiceOptions {
  /** Корень данных инстанса (`$SYNTH_DATA_DIR`). */
  dataDir: string;
  /** `config.skills.trustedProjectDirs` — project-trust гейт. */
  trustedProjectDirs?: readonly string[];
  home?: string;
  /** Свой реестр (тесты/переиспользование кэша). */
  registry?: SnippetRegistry;
}

/** Контекст выбора уровней (пользователь + проект). */
export interface SnippetScopeContext {
  /** Пользователь (уровень `user`). */
  userId?: string;
  /** Рабочий каталог проекта (уровень `project`). */
  projectWorkspace?: string;
}

/** Вход записи сниппета. */
export interface SnippetWriteInput extends SnippetScopeContext {
  name: string;
  body: string;
  description?: string;
  aliases?: string[];
  scope: SnippetScope;
}

/** Идентификатор пользователя в пути: без разделителей и `..`. */
const SAFE_USER_ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

interface SnippetTarget {
  dir: string;
  file: string;
  trusted: boolean;
}

/**
 * Доменный сервис сниппетов: единая точка для HTTP-контура (следующий этап),
 * UI и раскрытия в промпте.
 */
export class SnippetService {
  private readonly _opts: SnippetServiceOptions;
  private readonly _registry: SnippetRegistry;

  constructor(opts: SnippetServiceOptions) {
    this._opts = opts;
    this._registry =
      opts.registry ??
      new SnippetRegistry({
        sources: (o) =>
          buildSnippetSources({
            dataDir: opts.dataDir,
            userId: o?.userId,
            projectWorkspace: o?.projectWorkspace,
            trustedProjectDirs: opts.trustedProjectDirs,
            home: opts.home,
          }),
      });
  }

  /**
   * Список видимых сниппетов (уровни `user > project > instance`).
   * Недоверенные проектные сниппеты видны с `trusted: false`.
   */
  async list(opts?: SnippetScopeContext): Promise<{
    snippets: Snippet[];
    diagnostics: SnippetDiagnostic[];
  }> {
    const index = await this._registry.index(opts);
    return { snippets: index.snippets, diagnostics: index.diagnostics };
  }

  /**
   * Сниппет по каноническому имени или алиасу (`undefined` — не найден).
   *
   * Недоверенный проектный сниппет тоже находится (у него `trusted: false`) —
   * он виден в `list`, но не раскрывается (см. `expandText`).
   */
  async get(name: string, opts?: SnippetScopeContext): Promise<Snippet | undefined> {
    const index = await this._registry.index(opts);
    const token = name.trim();
    return resolveSnippet(index, token) ?? resolveUntrustedSnippet(index, token);
  }

  /**
   * Раскрытие сниппетов в пользовательском тексте (ADR-141 §4 «Раскрытие»):
   * один проход, без рекурсии, лимиты 15 раскрытий / 64 КБ.
   */
  async expandText(text: string, opts?: SnippetScopeContext): Promise<ExpandSnippetsResult> {
    const index = await this._registry.index(opts);
    return expandSnippetMentions(text, { index });
  }

  /** Создание сниппета (файла). */
  async create(input: SnippetWriteInput): Promise<Snippet> {
    const target = this._resolveTarget(input);
    const name = input.name.trim();
    if (await exists(target.file)) {
      throw new SnippetError('conflict', `Сниппет "${name}" уже существует: ${target.file}`);
    }
    await this._write(target, input);
    return this._toSnippet(name, input, target);
  }

  /** Обновление существующего сниппета. */
  async update(input: SnippetWriteInput): Promise<Snippet> {
    const target = this._resolveTarget(input);
    const name = input.name.trim();
    if (!(await exists(target.file))) {
      throw new SnippetError('not-found', `Сниппет "${name}" не найден: ${target.file}`);
    }
    await this._write(target, input);
    return this._toSnippet(name, input, target);
  }

  /** Удаление сниппета. `false` — файла нет (идемпотентно). */
  async delete(input: {
    name: string;
    scope: SnippetScope;
    userId?: string;
    projectWorkspace?: string;
  }): Promise<boolean> {
    const target = this._resolveTarget(input);
    if (!(await exists(target.file))) return false;
    await rm(target.file, { force: true });
    this._registry.reload();
    return true;
  }

  /** Принудительный сброс кэша реестра (после внешней правки файлов). */
  reload(): void {
    this._registry.reload();
  }

  private async _write(target: SnippetTarget, input: SnippetWriteInput): Promise<void> {
    const name = input.name.trim();
    const aliases = normalizeAliases(input.aliases ?? [], name);
    const description = input.description?.trim();
    const content = stringifyFrontmatter(
      {
        name,
        ...(description ? { description } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
      },
      input.body.trim(),
    );
    await mkdir(target.dir, { recursive: true });
    await atomicWrite(
      (path, data) => writeFile(path, data, 'utf-8'),
      (from, to) => rename(from, to),
      target.file,
      content,
    );
    this._registry.reload();
  }

  private _toSnippet(name: string, input: SnippetWriteInput, target: SnippetTarget): Snippet {
    return {
      name,
      description: input.description?.trim(),
      aliases: normalizeAliases(input.aliases ?? [], name),
      body: input.body.trim(),
      scope: input.scope,
      file: target.file,
      trusted: target.trusted,
    };
  }

  /** Каталог/файл по уровню + проверка имени. */
  private _resolveTarget(input: {
    name: string;
    scope: SnippetScope;
    userId?: string;
    projectWorkspace?: string;
  }): SnippetTarget {
    const name = input.name.trim();
    if (!SNIPPET_NAME_REGEX.test(name)) {
      throw new SnippetError(
        'invalid-name',
        `Недопустимое имя сниппета "${name}" (ожидается [a-z0-9][a-z0-9_-]{0,79})`,
      );
    }
    switch (input.scope) {
      case 'instance': {
        const dir = instanceSnippetsDir(this._opts.dataDir);
        return { dir, file: join(dir, `${name}.md`), trusted: true };
      }
      case 'user': {
        const userId = input.userId?.trim();
        if (!userId) {
          throw new SnippetError('missing-user', 'Для пользовательского сниппета нужен userId');
        }
        if (!SAFE_USER_ID_REGEX.test(userId) || userId === '.' || userId === '..') {
          throw new SnippetError('invalid-name', `Недопустимый идентификатор пользователя "${userId}"`);
        }
        const dir = userSnippetsDir(this._opts.dataDir, userId);
        return { dir, file: join(dir, `${name}.md`), trusted: true };
      }
      case 'project': {
        const workspace = input.projectWorkspace?.trim();
        if (!workspace) {
          throw new SnippetError('missing-workspace', 'Для проектного сниппета нужен workspace проекта');
        }
        const dir = projectSnippetsDir(workspace);
        return {
          dir,
          file: join(dir, `${name}.md`),
          trusted: isProjectTrusted(
            workspace,
            this._opts.trustedProjectDirs ?? [],
            this._opts.home,
          ),
        };
      }
      default: {
        const unknownScope: never = input.scope;
        throw new SnippetError('invalid-name', `Неизвестный уровень сниппета: ${String(unknownScope)}`);
      }
    }
  }
}

/** Алиасы: без дублей, без имени самого сниппета, только валидные имена. */
function normalizeAliases(aliases: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (const raw of aliases) {
    const alias = raw.trim();
    if (!SNIPPET_NAME_REGEX.test(alias)) {
      throw new SnippetError('invalid-alias', `Недопустимый алиас сниппета "${alias}"`);
    }
    if (alias === name || out.includes(alias)) continue;
    out.push(alias);
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
