/**
 * PROP-136 (слайс 136a): файловый append-only журнал **исполнений** команд
 * (`execute_shell`/`sandbox_exec`).
 *
 * ## Зачем
 *
 * Shell — произвольный код: `shell-guard` и path-периметр — guardrail и UX, а
 * не граница безопасности. Вместо мнимой изоляции ядро пишет наблюдаемый
 * след: на каждый запуск две записи (`started` до запуска, `finished` после),
 * связанные одним `id`. Тела вывода не пишутся — только размер, hash и флаг
 * обрезки; команда — **обезличенная** (карта обфускации сессии ADR-036 +
 * редакция значений секретов) и обрезанная до `COMMAND_AUDIT_MAX_COMMAND_BYTES`.
 *
 * ## Формат и хранилище
 *
 * JSONL `{dataDir}/audit/commands.jsonl` (или `security.commandAudit.path`):
 * одна строка — одна запись. Каталог `audit/` уже используется LLM/security-
 * аудитом, поэтому отдельного порта слоя хранения здесь нет — это журнал
 * процесса (остаток: PG-репозиторий, слайс 136b/следующий).
 *
 * `append` защищён `AsyncLock` (конкурирующие записи не перемешивают строки) и
 * **бросает** при ошибке: вызывающий решает — при включённом журнале ошибка
 * записи `started` **блокирует** выполнение команды (PROP-136).
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { AsyncLock, atomicWrite } from '@itphx/synth-shared';
import type {
  CommandAuditConfig,
  CommandAuditDecision,
  CommandAuditEntry,
  CommandAuditPhase,
} from '@itphx/synth-shared';
import {
  COMMAND_AUDIT_MAX_COMMAND_BYTES,
  COMMAND_AUDIT_TOOLS,
  DEFAULT_COMMAND_AUDIT_RETENTION_DAYS,
} from '@itphx/synth-shared';

// Пределы/дефолты журнала — один источник (shared); реэкспорт для вызывающих.
export {
  COMMAND_AUDIT_MAX_COMMAND_BYTES,
  COMMAND_AUDIT_TOOLS,
  DEFAULT_COMMAND_AUDIT_RETENTION_DAYS,
} from '@itphx/synth-shared';
import { obfuscateSecrets } from '../gateway/obfuscator.js';

/** Счётчики журнала (ADR-094): реализация — `metrics/collectors/command-audit.ts`. */
export interface CommandAuditMetricsSink {
  /** Запись успешно добавлена. */
  onWritten(phase: CommandAuditPhase, tool: string): void;
  /** Запись не удалась (журнал включён — вызывающий блокирует исполнение). */
  onFailed(phase: CommandAuditPhase, tool: string): void;
  /** `prune` удалил записи. */
  onDropped(count: number): void;
}

export interface CommandAuditLogOptions {
  /** Каталог данных инстанса (`{dataDir}/audit/commands.jsonl`). */
  dataDir: string;
  /** Секция `security.commandAudit` конфига (не задана — дефолты). */
  config?: Partial<CommandAuditConfig>;
  /** Окружение для env-оверрайдов (тесты); по умолчанию `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Метрики (только при включённом реестре). */
  metrics?: CommandAuditMetricsSink;
}

export interface CommandAuditListOptions {
  sessionId?: string;
  projectId?: string;
  /** Нижняя граница `ts` (ISO-8601, включительно). */
  from?: string;
  /** Верхняя граница `ts` (ISO-8601, включительно). */
  to?: string;
  decision?: CommandAuditDecision;
  /** Последние N записей (свежие первыми). */
  limit?: number;
}

/** Имя файла журнала по умолчанию (`{dataDir}/audit/commands.jsonl`). */
export const COMMAND_AUDIT_FILE_NAME = 'commands.jsonl';

/** Тулы, исполнение которых журналируется (PROP-136). */
export function isCommandAuditTool(toolName: string): boolean {
  return (COMMAND_AUDIT_TOOLS as readonly string[]).includes(toolName);
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Эффективная секция `security.commandAudit`.
 *
 * Приоритет (ADR-023): env > config > defaults. Переменные —
 * `SYNTH_COMMAND_AUDIT_ENABLED` (bool) и `SYNTH_COMMAND_AUDIT_RETENTION_DAYS`
 * (целое). Невалидное значение env **игнорируется** (остаётся config/дефолт):
 * это настройка журнала, а не прав доступа, — опечатка не должна ломать старт.
 */
export function resolveCommandAuditConfig(
  config?: Partial<CommandAuditConfig>,
  env: NodeJS.ProcessEnv = process.env,
): CommandAuditConfig {
  const enabled = _parseBool(env['SYNTH_COMMAND_AUDIT_ENABLED']) ?? config?.enabled ?? false;
  const retentionFromEnv = _parsePositiveInt(env['SYNTH_COMMAND_AUDIT_RETENTION_DAYS']);
  const retentionDays = retentionFromEnv
    ?? (typeof config?.retentionDays === 'number' && Number.isFinite(config.retentionDays)
      ? Math.floor(config.retentionDays)
      : DEFAULT_COMMAND_AUDIT_RETENTION_DAYS);
  return {
    enabled,
    retentionDays,
    path: config?.path ?? '',
  };
}

function _parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return undefined;
}

function _parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int >= 0 ? int : undefined;
}

/** Регулярки редакции значений (порядок важен: специфичное — раньше общего). */
const REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // URL с userinfo: `scheme://user:password@host` — логин и пароль скрываются.
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)(?::[^/\s@]+)?@/gi, '$1***@'],
  // `--password=…`, `--token=…`, `--api-key=…` и прочие `--<secretish>=<value>`.
  [
    /(--?(?:password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key|auth|credentials?)[=\s]+)([^\s;|&]+)/gi,
    '$1***',
  ],
  // `Bearer <token>` / `Basic <base64>` в заголовках и curl-командах.
  [/\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{6,})/gi, '$1 ***'],
];

/**
 * Редакция значений секретов в команде (PROP-136).
 *
 * Шаблоны: `Bearer …`, `--password=…` (и родственные ключи), URL с userinfo.
 * Значения заменяются на `***`; сами имена/схемы остаются — запись читаема,
 * но бесполезна как утечка. `secrets` — значения вызова (SSH-ключи, секреты
 * окружения): каждое вхождение тоже заменяется.
 */
export function redactCommand(command: string, secrets: string[] = []): string {
  if (!command) return command;
  let result = command;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join('***');
  }
  for (const [re, replacement] of REDACTION_PATTERNS) {
    result = result.replace(re, replacement);
  }
  return result;
}

/** sha256 (hex) — от полной строки, до обрезки. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Обрезка до предела в **байтах** без разрыва UTF-8: длина считается по
 * `Buffer.byteLength` очередного символа.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let bytes = 0;
  let result = '';
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += char;
  }
  return result;
}

/**
 * Текст команды для журнала: карта обфускации сессии (ADR-036) → редакция
 * значений → hash полной строки → обрезка (≤ `COMMAND_AUDIT_MAX_COMMAND_BYTES`).
 *
 * Карта обфускации — `placeholder → secret`: известные секреты получают свои
 * плейсхолдеры, незнакомые (модель прислала значение в открытом виде) —
 * новый плейсхолдер. Карта наружу не сохраняется: журналу нужен только текст.
 */
export function prepareCommandForAudit(
  command: string,
  opts: { secretsMap?: Record<string, string>; secrets?: string[] } = {},
): { command: string; commandHash: string } {
  let text = command;
  const map = opts.secretsMap;
  if (map && Object.keys(map).length > 0) {
    // Известные секреты сессии заменяются **по карте**, а не детектором:
    // у значения может не быть узнаваемого формата (`sk-…`, ключ и т.п.),
    // но оно уже признано секретом в этой сессии (ADR-036).
    const known = Object.entries(map)
      .filter(([, secret]) => Boolean(secret))
      .sort((a, b) => b[1].length - a[1].length);
    for (const [placeholder, secret] of known) {
      if (text.includes(secret)) text = text.split(secret).join(placeholder);
    }
    try {
      // Незнакомые секреты (модель прислала значение открытым текстом) —
      // штатный детектор: получит свой плейсхолдер.
      text = obfuscateSecrets(text, map).text;
    } catch {
      // Детектор не должен мешать аудиту: остаётся редакция по шаблонам.
    }
  }
  text = redactCommand(text, opts.secrets ?? []);
  return {
    command: truncateUtf8Bytes(text, COMMAND_AUDIT_MAX_COMMAND_BYTES),
    commandHash: sha256Hex(text),
  };
}

/** Команда из аргументов тула: `execute_shell` — `command`, `sandbox_exec` — `commands.join(' && ')`. */
export function commandFromToolArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'sandbox_exec') {
    const commands = args.commands;
    if (Array.isArray(commands)) {
      return commands.filter((c): c is string => typeof c === 'string').join(' && ');
    }
    return '';
  }
  return typeof args.command === 'string' ? args.command : '';
}

/**
 * PROP-136: журнал исполнений команд — одна JSONL-строка на запись.
 *
 * `enabled` — эффективное значение конфига (env > config); `append` при
 * выключенном журнале — no-op (защита от случайной записи в обход проверки
 * вызывающего). `list` отдаёт записи «свежими первыми», битые строки
 * пропускает; `prune` удаляет записи старше `days` дней.
 */
export class CommandAuditLog {
  readonly enabled: boolean;

  private readonly _config: CommandAuditConfig;
  private readonly _path: string;
  private readonly _lock = new AsyncLock();
  private readonly _metrics?: CommandAuditMetricsSink;

  constructor(options: CommandAuditLogOptions) {
    this._config = resolveCommandAuditConfig(options.config, options.env ?? process.env);
    this.enabled = this._config.enabled;
    this._path = this._config.path || join(options.dataDir, 'audit', COMMAND_AUDIT_FILE_NAME);
    this._metrics = options.metrics;
  }

  /** Путь журнала (диагностика/тесты). */
  get path(): string {
    return this._path;
  }

  /** Срок хранения из эффективного конфига, дней (`<= 0` — без ограничения). */
  get retentionDays(): number {
    return this._config.retentionDays;
  }

  /**
   * Дозапись записи + `\n`. Каталог создаётся по необходимости.
   * **Бросает** при ошибке записи: решение о блокировке исполнения принимает
   * вызывающий (PROP-136: при включённом журнале — блокировать).
   */
  async append(entry: CommandAuditEntry): Promise<void> {
    if (!this.enabled) return;
    await this._lock.acquire();
    try {
      await mkdir(dirname(this._path), { recursive: true });
      await appendFile(this._path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
      this._metrics?.onWritten(entry.phase, entry.tool);
    } catch (e) {
      this._metrics?.onFailed(entry.phase, entry.tool);
      throw e;
    } finally {
      this._lock.release();
    }
  }

  /**
   * Чтение журнала (свежие первыми). Фильтры — `sessionId`/`projectId`/`from`/
   * `to`/`decision`; `limit` — последние N записей. Файла нет — `[]`;
   * повреждённые строки пропускаются.
   */
  async list(opts: CommandAuditListOptions = {}): Promise<CommandAuditEntry[]> {
    let entries = (await this._readAll()).reverse();
    if (opts.sessionId !== undefined) {
      entries = entries.filter((entry) => entry.sessionId === opts.sessionId);
    }
    if (opts.projectId !== undefined) {
      entries = entries.filter((entry) => entry.projectId === opts.projectId);
    }
    if (opts.from !== undefined) {
      entries = entries.filter((entry) => entry.ts >= opts.from!);
    }
    if (opts.to !== undefined) {
      entries = entries.filter((entry) => entry.ts <= opts.to!);
    }
    if (opts.decision !== undefined) {
      entries = entries.filter((entry) => entry.decision === opts.decision);
    }
    const { limit } = opts;
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return entries;
    return entries.slice(0, Math.floor(limit));
  }

  /**
   * Retention: удаляет записи старше `days` дней (атомарная перезапись
   * tmp→rename, ADR-005). `days <= 0` — ограничения нет (`0` удалённых).
   * Возвращает число удалённых записей.
   */
  async prune(days: number): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0;
    await this._lock.acquire();
    try {
      const entries = await this._readAll();
      if (entries.length === 0) return 0;
      const cutoff = Date.now() - Math.floor(days) * 24 * 60 * 60 * 1000;
      const kept = entries.filter((entry) => {
        const ts = Date.parse(entry.ts);
        // Невалидный `ts` — запись не удаляем (лучше лишняя, чем потерянная).
        return Number.isNaN(ts) || ts >= cutoff;
      });
      const removed = entries.length - kept.length;
      if (removed === 0) return 0;
      await mkdir(dirname(this._path), { recursive: true });
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        this._path,
        kept.map((entry) => JSON.stringify(entry)).join('\n') + (kept.length > 0 ? '\n' : ''),
      );
      this._metrics?.onDropped(removed);
      return removed;
    } finally {
      this._lock.release();
    }
  }

  private async _readAll(): Promise<CommandAuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this._path, 'utf8');
    } catch {
      return [];
    }

    const entries: CommandAuditEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as CommandAuditEntry);
      } catch (e) {
        console.warn(
          `[CommandAuditLog] повреждённая строка журнала исполнений пропущена: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return entries;
  }
}

/** Фабрика журнала (путь/`enabled` — из `security.commandAudit`). */
export function createCommandAuditLog(options: CommandAuditLogOptions): CommandAuditLog {
  return new CommandAuditLog(options);
}
