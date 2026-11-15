/**
 * PROP-132: настройки терминалов — `/api/v2/settings/terminal`.
 *
 * Контракт:
 * - `GET    /api/v2/settings/terminal` — эффективные значения секции
 *   (`enabled`, `autoRestore` + параметры выполнения `idleMinutes`,
 *   `maxPerProject`, `maxPerInstance`, `shell`, `auditInput`), источник по
 *   каждому полю (`sources`) и общий (`source`), база без runtime (`defaults`),
 *   env-фиксация (`envLocked` + список полей `envLockedFields`);
 * - `PUT    /api/v2/settings/terminal` `{…частичный патч…}` — runtime-override
 *   (**частичное** обновление), применяется **сразу**: `setEnabled`,
 *   `setAutoRestore`, `setLimits({idleMs, maxPerProject, maxPerInstance})`,
 *   `setDefaultShell`, `setAuditInput` — рестарт не нужен;
 * - `DELETE /api/v2/settings/terminal` — сброс runtime всех полей к
 *   env/config/default с тем же live-применением.
 *
 * ## Приоритет
 *
 * У каждого поля **свой** слой: env > runtime (`settings.json`/PG) >
 * config.yaml > default. Env-фиксация проверяется **по полю**: зафиксированное
 * env значение блокирует только свою настройку (`PUT {enabled}` не блокируется
 * фиксацией `idleMinutes`).
 *
 * ## Коды ошибок
 *
 * - `400 VALIDATION_ERROR` — неизвестный ключ, неверный тип, число вне границ
 *   (`TERMINAL_*_RANGE`) или оболочка не по `TERMINAL_SHELL_PATTERN`;
 * - `409 ENV_LOCKED` с `fields: TerminalSettingsField[]` — поле зафиксировано
 *   env; **ни одно** поле запроса при этом не применяется (частичный отказ не
 *   оставляет «половину» изменений).
 *
 * Образец — `settings-ssh.ts`/`metrics-settings.ts` (ADR-094); правило
 * приоритета — в `engine/terminal/config.ts` (единственный источник истины для
 * обоих вызывающих: старт процесса и этот роут).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { TerminalConfig } from '@itphx/synth-shared/config';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { TerminalRuntimeSettings } from '../../storage/runtime-settings.js';
import type { TerminalService } from '../../engine/terminal/service.js';
import {
  TERMINAL_IDLE_MINUTES_RANGE,
  TERMINAL_MAX_PER_INSTANCE_RANGE,
  TERMINAL_MAX_PER_PROJECT_RANGE,
  TERMINAL_SHELL_PATTERN,
  resolveTerminalSettings,
  type ResolvedTerminalSettings,
  type TerminalEnabledSource,
  type TerminalNumericBounds,
  type TerminalSettingsDefaults,
  type TerminalSettingsField,
  type TerminalSettingsSources,
} from '../../engine/terminal/config.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Зависимости фабрики. */
export interface TerminalSettingsDeps {
  /** Порт runtime-настроек (`{dataDir}/settings.json` / PG). */
  settingsStore: SettingsRepository;
  /**
   * Секция `terminal` из config.yaml **целиком** (объектная форма — приоритетнее
   * плоских полей). `undefined` — секции нет (дефолты).
   */
  config?: Partial<TerminalConfig>;
  /**
   * @deprecated Плоское `terminal.enabled` из config.yaml — используйте
   * `config: { enabled }`.
   */
  configEnabled?: boolean;
  /**
   * @deprecated Плоское `terminal.autoRestore` из config.yaml — используйте
   * `config: { autoRestore }`.
   */
  configAutoRestore?: boolean;
  /**
   * Сервис терминалов инстанса — live-применение всех полей. Не задан —
   * значение только сохраняется (тесты/сборка без сервиса).
   */
  terminalService?: TerminalService;
  /** Env (тесты); по умолчанию — `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** i18n-сообщения (backend передаёт `t(...)`; core — русские дефолты). */
export interface TerminalSettingsMessages {
  invalidEnabled?: (c: Context) => string;
  invalidAutoRestore?: (c: Context) => string;
  /** Общее сообщение валидации поля (`field` — имя поля запроса). */
  invalidField?: (c: Context, field: TerminalSettingsField) => string;
  /** Сообщение о невалидной оболочке. */
  invalidShell?: (c: Context) => string;
  envLocked?: (c: Context) => string;
}

/** Опции фабрики: guard'ы и сообщения. */
export interface TerminalSettingsOptions {
  /** Guard чтения; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  readGuard?: Middleware;
  /** Guard мутаций; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  writeGuard?: Middleware;
  messages?: TerminalSettingsMessages;
}

/** Ответ GET/PUT/DELETE — контракт с UI. */
export interface TerminalSettingsView extends TerminalSettingsDefaults {
  /**
   * Источник эффективных значений — наиболее специфичный слой из полей
   * (`env` > `runtime` > `config` > `default`).
   */
  source: TerminalEnabledSource;
  /** Источник **каждого** поля секции. */
  sources: TerminalSettingsSources;
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: TerminalSettingsDefaults;
  /** Env зафиксировал хотя бы одно из значений (runtime его не перекрывает). */
  envLocked: boolean;
  /** Поля, зафиксированные env: из UI они `disabled` и не уходят в `PUT`. */
  envLockedFields: TerminalSettingsField[];
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: false;
}

/** Канонический порядок полей секции (для `envLockedFields` и обхода). */
const TERMINAL_SETTINGS_FIELD_ORDER: readonly TerminalSettingsField[] = [
  'enabled',
  'autoRestore',
  'idleMinutes',
  'maxPerProject',
  'maxPerInstance',
  'shell',
  'auditInput',
];

/** Поля, чьё значение — число в границах. */
const NUMERIC_FIELDS: Record<
  'idleMinutes' | 'maxPerProject' | 'maxPerInstance',
  TerminalNumericBounds
> = {
  idleMinutes: TERMINAL_IDLE_MINUTES_RANGE,
  maxPerProject: TERMINAL_MAX_PER_PROJECT_RANGE,
  maxPerInstance: TERMINAL_MAX_PER_INSTANCE_RANGE,
};

const DEFAULT_INVALID_FIELD = (_c: Context, field: string): string =>
  `terminal.${field}: некорректное значение`;
const DEFAULT_INVALID_SHELL = (): string =>
  `terminal.shell: ожидается имя программы/путь без пробелов (${String(TERMINAL_SHELL_PATTERN)})`;
const DEFAULT_ENV_LOCKED = (): string =>
  'Задано через переменную окружения — изменение из UI недоступно';

/** Разбор патча: либо валидное частичное обновление, либо ошибка валидации. */
type ParsedPatch =
  | { ok: true; patch: Partial<TerminalRuntimeSettings>; fields: TerminalSettingsField[] }
  | { ok: false; field: TerminalSettingsField | null; unknownKey: string | null };

/** Известно ли поле секции. */
function isSettingsField(value: string): value is TerminalSettingsField {
  return (TERMINAL_SETTINGS_FIELD_ORDER as readonly string[]).includes(value);
}

/**
 * Фабрика роутов `/api/v2/settings/terminal`.
 * `auth.requireAuth` — обязательный guard по умолчанию (core, single-user);
 * managed backend передаёт `requirePermission('ADMIN')`.
 */
export function createTerminalSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: TerminalSettingsDeps,
  opts: TerminalSettingsOptions = {},
): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidEnabled =
    opts.messages?.invalidEnabled ?? ((c: Context) => DEFAULT_INVALID_FIELD(c, 'enabled'));
  const invalidAutoRestore =
    opts.messages?.invalidAutoRestore ?? ((c: Context) => DEFAULT_INVALID_FIELD(c, 'autoRestore'));
  const invalidField = opts.messages?.invalidField ?? DEFAULT_INVALID_FIELD;
  const invalidShell = opts.messages?.invalidShell ?? DEFAULT_INVALID_SHELL;
  const envLockedMessage = opts.messages?.envLocked ?? DEFAULT_ENV_LOCKED;

  /** Эффективные значения секции по runtime-снимку (config + env — из deps). */
  const resolveWith = (runtime: Partial<TerminalRuntimeSettings>): ResolvedTerminalSettings =>
    resolveTerminalSettings({
      ...(deps.config !== undefined ? { config: deps.config } : {}),
      ...(deps.configEnabled !== undefined ? { configEnabled: deps.configEnabled } : {}),
      ...(deps.configAutoRestore !== undefined
        ? { configAutoRestore: deps.configAutoRestore }
        : {}),
      runtime,
      env,
    });

  /** Снимок: эффективные значения, источники, база без runtime, env-фиксация. */
  const buildView = async (): Promise<TerminalSettingsView> => {
    const runtime = await deps.settingsStore.getTerminal();
    const resolved = resolveWith(runtime);
    return {
      enabled: resolved.enabled,
      autoRestore: resolved.autoRestore,
      idleMinutes: resolved.idleMinutes,
      maxPerProject: resolved.maxPerProject,
      maxPerInstance: resolved.maxPerInstance,
      shell: resolved.shell,
      auditInput: resolved.auditInput,
      source: resolved.source,
      sources: resolved.sources,
      defaults: resolved.defaults,
      envLocked: resolved.envLocked,
      envLockedFields: TERMINAL_SETTINGS_FIELD_ORDER.filter((field) => resolved.envLock[field]),
      restartRequired: false,
    };
  };

  /**
   * Live-применение значений (без рестарта).
   *
   * Порядок как при старте: `setAutoRestore` → `setEnabled` (выключатель
   * закрывает живые терминалы, поэтому идёт последним из флагов). Параметры
   * выполнения сервис читает на каждой операции — `setLimits`/`setDefaultShell`/
   * `setAuditInput` действуют сразу.
   */
  const applyLive = (resolved: ResolvedTerminalSettings): void => {
    const service = deps.terminalService;
    if (!service) return;
    service.setAutoRestore(resolved.autoRestore);
    service.setLimits({
      idleMs: resolved.idleMinutes * 60_000,
      maxPerProject: resolved.maxPerProject,
      maxPerInstance: resolved.maxPerInstance,
    });
    service.setDefaultShell(resolved.shell);
    service.setAuditInput(resolved.auditInput);
    service.setEnabled(resolved.enabled);
  };

  /** Разобрать тело PUT: только известные поля, строгие типы и границы. */
  const parsePatch = (body: unknown): ParsedPatch => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, field: null, unknownKey: null };
    }
    const raw = body as Record<string, unknown>;
    const keys = Object.keys(raw);
    // Неизвестные ключи запрещены: иначе опечатка (`maxPerProjectt`) молча
    // не применялась бы, а ответ выглядел бы успешным.
    for (const key of keys) {
      if (!isSettingsField(key)) return { ok: false, field: null, unknownKey: key };
    }
    if (keys.length === 0) return { ok: false, field: null, unknownKey: null };

    const patch: Partial<TerminalRuntimeSettings> = {};
    const fields: TerminalSettingsField[] = [];
    for (const key of keys) {
      const field = key as TerminalSettingsField;
      const value = raw[key];
      switch (field) {
        case 'enabled':
          if (typeof value !== 'boolean') return { ok: false, field, unknownKey: null };
          patch.enabled = value;
          break;
        case 'autoRestore':
          if (typeof value !== 'boolean') return { ok: false, field, unknownKey: null };
          patch.autoRestore = value;
          break;
        case 'auditInput':
          if (typeof value !== 'boolean') return { ok: false, field, unknownKey: null };
          patch.auditInput = value;
          break;
        case 'idleMinutes':
        case 'maxPerProject':
        case 'maxPerInstance': {
          const bounds = NUMERIC_FIELDS[field];
          if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            !Number.isInteger(value) ||
            value < bounds.min ||
            value > bounds.max
          ) {
            return { ok: false, field, unknownKey: null };
          }
          patch[field] = value;
          break;
        }
        case 'shell': {
          if (value === null) {
            patch.shell = null;
            break;
          }
          if (typeof value !== 'string') return { ok: false, field, unknownKey: null };
          const trimmed = value.trim();
          // Пустая строка — явный сброс к платформенному дефолту.
          if (trimmed === '') {
            patch.shell = null;
            break;
          }
          if (!TERMINAL_SHELL_PATTERN.test(trimmed)) {
            return { ok: false, field, unknownKey: null };
          }
          patch.shell = trimmed;
          break;
        }
      }
      fields.push(field);
    }
    return { ok: true, patch, fields };
  };

  app.get('/terminal', readGuard, async (c) => c.json(await buildView()));

  app.put('/terminal', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = parsePatch(body);
    if (!parsed.ok) {
      const message =
        parsed.unknownKey !== null
          ? `terminal: неизвестное поле "${parsed.unknownKey}"`
          : parsed.field === 'shell'
            ? invalidShell(c)
            : parsed.field === 'enabled'
              ? invalidEnabled(c)
              : parsed.field === 'autoRestore'
                ? invalidAutoRestore(c)
                : parsed.field !== null
                  ? invalidField(c, parsed.field)
                  : 'terminal: ожидается объект с полями настроек';
      return c.json({ error: { code: 'VALIDATION_ERROR', message } }, 400);
    }

    const runtime = await deps.settingsStore.getTerminal();
    const before = resolveWith(runtime);

    // Env-фиксация — **по полю**: отказ перечисляет все зафиксированные поля
    // запроса, и ничего не применяется (частичное изменение оставило бы UI с
    // «половиной» патча).
    const locked = parsed.fields.filter((field) => before.envLock[field]);
    if (locked.length > 0) {
      return c.json(
        { error: { code: 'ENV_LOCKED', message: envLockedMessage(c), fields: locked } },
        409,
      );
    }

    // Runtime-override — **частичный**: незаданное поле сохраняется (секция
    // пишется целиком, поэтому мержим с текущим значением).
    const merged: Partial<TerminalRuntimeSettings> = { ...runtime, ...parsed.patch };
    await deps.settingsStore.setTerminal(merged);
    applyLive(resolveWith(merged));

    return c.json(await buildView());
  });

  app.delete('/terminal', writeGuard, async (c) => {
    const runtime = await deps.settingsStore.getTerminal();
    const before = resolveWith(runtime);
    // Сброс runtime невозможен, если хотя бы одно из полей зафиксировано env:
    // сброс не дал бы полного эффекта (env всё равно задаёт значение).
    if (before.envLocked) {
      const locked = TERMINAL_SETTINGS_FIELD_ORDER.filter((field) => before.envLock[field]);
      return c.json(
        { error: { code: 'ENV_LOCKED', message: envLockedMessage(c), fields: locked } },
        409,
      );
    }

    await deps.settingsStore.clearTerminal();
    // После сброса эффективные значения — config/default (env заблокировал бы
    // операцию выше): применяем их к живому сервису.
    applyLive(resolveWith({}));

    return c.json(await buildView());
  });

  return app;
}
