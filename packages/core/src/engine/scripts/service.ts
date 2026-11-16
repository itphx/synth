import { basename, isAbsolute, relative, resolve } from 'node:path';
import type {
  ScriptDetail,
  ScriptDiagnostic,
  ScriptRunResponse,
  ScriptSummary,
} from '@itphx/synth-shared';
import type { ProcessService } from '../processes/service.js';
import { BackgroundUnsupportedError } from '../processes/types.js';
import { isLexicallyInside, isSymlinkEscapeInRoots, toolRoots } from '../tools/path-utils.js';
import { splitScriptArguments } from './args.js';
import {
  buildScriptSources,
  listUndeclaredExecutables,
  mergeScriptScans,
  scanScriptSource,
} from './discovery.js';
import { ScriptError, type ScriptRuntimeConfig, type TemplateScript } from './types.js';

/**
 * ADR-126 §5: доменный сервис скриптов проекта.
 *
 * Единственная точка, через которую скрипт видно и запускают: HTTP-роут,
 * тул `script_run` и ранняя фаза оркестратора (`!`-лексер) зовут **его**, а
 * не разбирают формат декларации сами.
 *
 * Инварианты:
 * 1. **Discovery — свежий на каждый вызов** (без глобального кэша): реестр
 *    меняется правкой файлов проекта, кэш здесь был бы источником расхождений.
 * 2. **Права не решаются здесь** (ADR-029): правило `permission.rules.script`,
 *    режим сессии и права проекта решает вызывающий. Сервис знает только
 *    **trust каталога** (ADR-126 §9) — это свойство источника, а не права.
 * 3. **Исполнение — только через `ProcessService`** (ADR-113/ADR-077):
 *    фоновый процесс, лог в blob-хранилище, события `process.*`.
 * 4. **Аргументы не конкатенируются в shell**: argv-форма — отдельные
 *    элементы, shell-форма — `SYNTH_ARGS`/`SYNTH_ARG_<n>`.
 */

/** Минимальный логгер (console-совместимый). */
export interface ScriptLogger {
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface ScriptServiceOptions {
  /** Рантайм-конфиг модуля скриптов (пути источников, trust-каталоги). */
  config: ScriptRuntimeConfig;
  /** Сервис фоновых процессов — единственный путь исполнения. */
  processService: ProcessService;
  /** Логгер (по умолчанию — console). */
  logger?: ScriptLogger;
}

/** Контекст чтения реестра скриптов. */
export interface ScriptListContext {
  /** Рабочий каталог проекта (`project.workspace`) — источник project-скриптов. */
  projectWorkspace?: string;
}

/** Вход запуска скрипта. */
export interface ScriptRunInput {
  /** Имя скрипта (`^[a-z0-9]+(-[a-z0-9]+)*$`). */
  name: string;
  /** Аргументы пользователя (разбираются лексером, без shell-подстановок). */
  args?: string;
  /** Сессия-владелец (в её канале публикуются события процесса). */
  sessionId: string;
  /** Проект сессии-владельца (необязательно). */
  projectId?: string;
  /** Рабочий каталог сессии — база для относительного `cwd` скрипта. */
  workingDir: string;
  /** Дополнительные корни периметра сессии (например корень проекта). */
  allowedRoots?: string[];
  /** Кто инициировал запуск: человек или агент (ADR-126 §5). */
  origin: 'user' | 'agent';
  /** Рабочий каталог проекта — для поиска project-скриптов. */
  projectWorkspace?: string;
}

/** Результат чтения реестра скриптов. */
export interface ScriptListResult {
  scripts: ScriptSummary[];
  diagnostics: ScriptDiagnostic[];
}

export class ScriptService {
  private readonly _config: ScriptRuntimeConfig;
  private readonly _processService: ProcessService;
  private readonly _logger: ScriptLogger;

  constructor(options: ScriptServiceOptions) {
    this._config = options.config;
    this._processService = options.processService;
    this._logger = options.logger ?? {
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
    };
  }

  /**
   * Список скриптов реестра + диагностика.
   *
   * Недоверенный проектный источник не скрывается: скрипт виден с
   * `available: false` и `unavailableReason: 'trusted'`.
   */
  async list(ctx: ScriptListContext = {}): Promise<ScriptListResult> {
    const { scripts, diagnostics } = await this._discover(ctx.projectWorkspace);

    const summary: ScriptSummary[] = scripts.map((script) => this._toSummary(script));

    // Подсказка «объявите скрипт» — исполняемые файлы проекта без
    // декларации (ADR-126 §5). Только проектные: инстанс и конфиг — не
    // репозиторий пользователя.
    if (ctx.projectWorkspace) {
      try {
        const undeclared = await listUndeclaredExecutables(ctx.projectWorkspace);
        for (const path of undeclared) {
          diagnostics.push({
            level: 'warning',
            code: 'undeclared-executable',
            message: `исполняемый файл "${path}" не объявлен скриптом: добавьте декларацию в .synth/scripts`,
            path,
          });
        }
      } catch (err) {
        this._logger.warn?.(
          `[ScriptService] поиск необъявленных исполняемых файлов не удался: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { scripts: summary, diagnostics };
  }

  /**
   * Детали одного скрипта. `null` — скрипт не объявлен.
   *
   * Недоверенный скрипт тоже возвращается (`available: false`) — иначе
   * вызывающий не отличил бы «нет скрипта» от «нельзя запускать».
   */
  async get(name: string, ctx: ScriptListContext = {}): Promise<ScriptDetail | null> {
    const { scripts } = await this._discover(ctx.projectWorkspace);
    const script = scripts.find((item) => item.name === name);
    if (!script) return null;
    return this._toDetail(script, ctx.projectWorkspace);
  }

  /**
   * Запустить скрипт.
   *
   * Запуск всегда **фоновый** (ADR-113): процесс пишет лог, события идут в
   * канал сессии-владельца. Декларация `background: false` означает
   * «ждать завершения» — это делает вызывающий (ответ ждёт `process.exited`),
   * отдельного пути исполнения не создаётся (ADR-126 §5).
   *
   * @throws ScriptError `script_not_found` — скрипт не объявлен;
   *   `script_untrusted` — каталог источника недоверенный;
   *   `script_args_invalid` — аргументы не разобрались;
   *   `script_args_not_allowed` — скрипт не принимает аргументы;
   *   `script_cwd_outside` — `cwd` скрипта вне периметра сессии;
   *   `script_background_disabled` — фоновое исполнение недоступно в
   *   текущем режиме исполнения.
   */
  async run(input: ScriptRunInput): Promise<ScriptRunResponse> {
    const { scripts } = await this._discover(input.projectWorkspace);
    const script = scripts.find((item) => item.name === input.name);
    if (!script) {
      throw new ScriptError('script_not_found', `скрипт "${input.name}" не объявлен`);
    }
    if (!script.trusted) {
      throw new ScriptError(
        'script_untrusted',
        `скрипт "${input.name}" недоступен: каталог проекта недоверенный`,
      );
    }

    // Аргументы разбирает лексер — конкатенации в shell нет (ADR-126 §5).
    const args = splitScriptArguments(input.args ?? '');
    if (!script.args && args.length > 0) {
      throw new ScriptError(
        'script_args_not_allowed',
        `скрипт "${input.name}" не принимает аргументы`,
      );
    }

    const cwd = this._resolveCwd(script, input);

    try {
      const result = await this._processService.spawn({
        sessionId: input.sessionId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        // Для argv-формы `command` не нужен: запуск идёт без локальной
        // оболочки (ADR-124 Ф4a). Для shell-формы — строка из декларации.
        ...(script.shell ? { command: script.run } : {}),
        ...(script.shell ? {} : { argv: { file: script.run, args } }),
        cwd,
        env: buildEnv(script, args),
        timeoutMs: script.timeout ?? 0,
        // Бинарные требования: из декларации, иначе — `bash` для shell-формы.
        // Для argv-формы требования не задаются: запускается сам файл.
        requires: script.requires ?? (script.shell ? ['bash'] : []),
        title: script.name,
        origin: input.origin,
        // ADR-126 §5: метка скрипта в записи реестра фоновых прогонов —
        // UI показывает бейдж по `metadata.script`.
        metadata: { script: script.name },
      });
      return {
        run_id: result.runId,
        process_id: result.processId,
        log_path: result.logPath,
        status: 'running',
      };
    } catch (err) {
      if (isBackgroundUnsupportedError(err)) {
        throw new ScriptError(
          'script_background_disabled',
          'Фоновое исполнение недоступно в текущем режиме исполнения',
        );
      }
      throw err;
    }
  }

  /**
   * Свежий discovery: источники → сканы → слияние (first-wins).
   *
   * Диагностика отдаётся с **относительными** путями: абсолютные пути
   * наружу не отдаются (инвариант «секреты/пути наружу»).
   */
  private async _discover(projectWorkspace?: string): Promise<{
    scripts: TemplateScript[];
    diagnostics: ScriptDiagnostic[];
  }> {
    const sources = buildScriptSources({
      dataDir: this._config.dataDir,
      ...(projectWorkspace ? { projectWorkspace } : {}),
      configPaths: this._config.scriptsPaths,
      ...(this._config.trustedProjectDirs
        ? { trustedProjectDirs: this._config.trustedProjectDirs }
        : {}),
      ...(this._config.home ? { home: this._config.home } : {}),
    });

    const scans = await Promise.all(sources.map((source) => scanScriptSource(source)));
    const merged = mergeScriptScans(
      sources.map((source, index) => ({ source, result: scans[index]! })),
    );

    const roots = this._pathRoots(projectWorkspace, sources.map((source) => source.dir));
    return {
      scripts: merged.scripts,
      diagnostics: merged.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        ...(diagnostic.path
          ? { path: this._relativePath(diagnostic.path, roots) }
          : {}),
      })),
    };
  }

  /**
   * Корни, относительно которых пути приводятся к относительным:
   * workspace проекта → каталог данных инстанса → каталоги источников.
   */
  private _pathRoots(projectWorkspace: string | undefined, sourceDirs: string[]): string[] {
    const roots: string[] = [];
    if (projectWorkspace) roots.push(resolve(projectWorkspace));
    roots.push(resolve(this._config.dataDir));
    for (const dir of sourceDirs) roots.push(resolve(dir));
    return roots;
  }

  /** Привести абсолютный путь к относительному (относительно корней). */
  private _relativePath(path: string, roots: readonly string[]): string {
    if (!isAbsolute(path)) return path;
    for (const root of roots) {
      const rel = relative(root, path);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      return rel;
    }
    // Путь вне известных корней наружу не отдаём — остаётся имя файла.
    return basename(path);
  }

  /**
   * Рабочий каталог скрипта: `resolve(workingDir, script.cwd ?? '.')`.
   *
   * Containment — периметр сессии (`workingDir` + `allowedRoots`,
   * ADR-114): каталог вне периметра или ушедший наружу через симлинк —
   * отказ (`script_cwd_outside`). Права (permission-слой) здесь не решаются:
   * периметр — это **граница**, а не разрешение (ADR-029).
   */
  private _resolveCwd(script: TemplateScript, input: ScriptRunInput): string {
    const cwd = resolve(input.workingDir, script.cwd ?? '.');
    const roots = toolRoots({
      workingDir: input.workingDir,
      ...(input.allowedRoots ? { allowedRoots: input.allowedRoots } : {}),
    });
    const inside = roots.some((root) => isLexicallyInside(root, cwd));
    if (!inside || isSymlinkEscapeInRoots(roots, cwd)) {
      throw new ScriptError(
        'script_cwd_outside',
        `рабочий каталог скрипта "${script.name}" вне периметра сессии`,
      );
    }
    return cwd;
  }

  /** Сводка скрипта для списка. */
  private _toSummary(script: TemplateScript): ScriptSummary {
    return {
      name: script.name,
      description: script.description,
      origin: script.origin,
      ...(script.argumentHint ? { argumentHint: script.argumentHint } : {}),
      available: script.trusted,
      ...(script.trusted ? {} : { unavailableReason: 'trusted' as const }),
      trusted: script.trusted,
      background: script.background,
    };
  }

  /** Детали скрипта (путь файла — относительный). */
  private _toDetail(script: TemplateScript, projectWorkspace?: string): ScriptDetail {
    return {
      ...this._toSummary(script),
      run: script.run,
      shell: script.shell,
      ...(script.cwd ? { cwd: script.cwd } : {}),
      args: script.args,
      ...(script.timeout !== undefined ? { timeout: script.timeout } : {}),
      ...(script.requires ? { requires: script.requires } : {}),
      file: this._relativeFile(script, projectWorkspace),
      body: script.body,
    };
  }

  /**
   * Путь файла декларации относительно источника:
   * проект — от workspace, инстанс — от каталога данных, конфиг — от
   * каталога-источника.
   */
  private _relativeFile(script: TemplateScript, projectWorkspace?: string): string {
    if (script.origin === 'project' && projectWorkspace) {
      return relative(resolve(projectWorkspace), script.file);
    }
    if (script.origin === 'instance') {
      return relative(resolve(this._config.dataDir), script.file);
    }
    return relative(resolve(script.dir), script.file);
  }
}

/**
 * Окружение запуска: переменные декларации + аргументы.
 *
 * Аргументы **не подставляются в строку запуска**. Для shell-формы они идут
 * отдельными переменными (`SYNTH_ARGS` — склеенная строка, `SYNTH_ARG_<n>` —
 * по одному), чтобы значение аргумента не стало частью shell-команды
 * (ADR-126 §5). Для argv-формы аргументы уходят в `argv`, поэтому
 * `SYNTH_*`-переменные не добавляются.
 */
function buildEnv(script: TemplateScript, args: string[]): Record<string, string> {
  const env: Record<string, string> = { ...(script.env ?? {}) };
  if (!script.shell) return env;
  env['SYNTH_ARGS'] = args.join(' ');
  args.forEach((value, index) => {
    env[`SYNTH_ARG_${index + 1}`] = value;
  });
  return env;
}

/**
 * Фоновое исполнение недоступно (исполнитель старой версии, ADR-077).
 *
 * Проверка структурная: ошибка может прийти из другой копии модуля core
 * (`dist`), где `instanceof` не срабатывает.
 */
function isBackgroundUnsupportedError(err: unknown): boolean {
  if (err instanceof BackgroundUnsupportedError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'BackgroundUnsupportedError'
  );
}
