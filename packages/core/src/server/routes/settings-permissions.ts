/**
 * Правила подтверждений **по умолчанию** — `/api/v2/settings/permissions`.
 *
 * Контракт:
 * - `GET    /api/v2/settings/permissions` — эффективная карта правил, её
 *   источник (`runtime`|`config`|`default`), база без runtime
 *   (`defaults: { rules }`) и `askTimeoutMs` (**не** управляется этой секцией);
 * - `PUT    /api/v2/settings/permissions` `{ rules }` — runtime-override,
 *   **заменяет карту целиком** (иначе снять правило было бы невозможно: оно
 *   «всплывало» бы из `config.permission.rules`); применяется **сразу**
 *   (`refresh()` живого состояния + депс-хук `onRulesChange`, рестарт не нужен);
 * - `DELETE /api/v2/settings/permissions` — сброс runtime к
 *   `config.permission.rules` с тем же живым применением.
 *
 * ## Приоритет
 *
 * **runtime (`settings.json`/PG) > `config.permission.rules` > пустая карта.**
 * Секции `permission` в `config.yaml` **нет** (решение владельца — только
 * runtime поверх существующей базы), env-слоя у правил тоже нет, поэтому
 * `source` бывает только `runtime`/`config`/`default`.
 *
 * Пустой объект `{}` — валидное значение «правил нет» (не путать с «не
 * задано»: «не задано» — отсутствие ключа `rules`, тогда действует база).
 *
 * ## Кого касается
 *
 * Правила — **инстанс-дефолт**: их получают сессии **без** собственного
 * `settings.permission` (снимок сессии не перезаписывается) и они же служат
 * `fallback`/`instance`-слоем резолва прав
 * (`engine/permission/effective.ts`).
 *
 * ## Валидация и ошибки
 *
 * - `400 VALIDATION_ERROR` — значение правила не из `allow|deny|ask`, не
 *   объект `{ <pattern>: allow|deny|ask }` (массив, число, `null`, вложенный
 *   объект глубже одного уровня), неизвестный ключ тела, `rules` не объект.
 *   Сообщение перечисляет **ключи** невалидных правил.
 *
 * ## Аудит
 *
 * `scope:'permission'`, `action:'update'`, `before` — прежняя карта, `after` —
 * новая (`DELETE` — база), `actor` — действующий пользователь; запись
 * best-effort через шов `recordPermissionAudit` (ошибка журнала не ломает
 * применение настройки).
 *
 * ## `askTimeoutMs`
 *
 * Таймаут подтверждения `ask` этой секцией **не управляется**: он живёт в
 * `config.permission.askTimeoutMs` + runtime `security.askTimeoutMs`
 * (`PUT /api/v2/settings/security`) и возвращается здесь только для контекста.
 *
 * Образец — `settings-audit.ts`/`settings-ssh.ts`; правило приоритета — в
 * `storage/runtime-settings.ts` (`resolvePermissionRules` — единственный
 * источник истины и для роута, и для живого состояния оркестратора).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { permissionRuleSchema } from '@itphx/synth-shared';
import type { PermissionConfig, PermissionRule } from '@itphx/synth-shared';
import { recordPermissionAudit } from '../../engine/permission/permission-audit.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../../engine/permission/derive.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import {
  resolvePermissionRules,
  type LivePermissionSettings,
  type PermissionRulesSource,
} from '../../storage/runtime-settings.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Тело `PUT`: карта правил целиком (неизвестные ключи тела — ошибка). */
const putBodySchema = z
  .object({ rules: z.record(z.string(), permissionRuleSchema) })
  .strict();

/** Зависимости фабрики. */
export interface PermissionSettingsDeps {
  /** Порт runtime-настроек (`{dataDir}/settings.json` / PG). */
  settingsStore: SettingsRepository;
  /** База — `config.permission` (правила и таймаут подтверждения). */
  config?: PermissionConfig;
  /**
   * Живое состояние правил (тот же экземпляр, что читает оркестратор):
   * после `PUT`/`DELETE` обновляется без рестарта.
   */
  live?: LivePermissionSettings;
  /**
   * Живое применение: получает **эффективную** карту после `PUT`/`DELETE`
   * (депс-хук точки сборки → `orchestrator.setDefaultPermissionRules`).
   */
  onRulesChange?: (rules: Record<string, PermissionRule>) => void | Promise<void>;
  /** Журнал security-аудита (`scope:'permission'`); не задан — записи нет. */
  securityAudit?: SecurityAuditRepository;
  /** Актор (id пользователя) для записей аудита. */
  resolveActor?: (c: { get(key: 'user'): unknown }) => string;
}

/** i18n-сообщения (backend передаёт `t(...)`; core — русские дефолты). */
export interface PermissionSettingsMessages {
  /** Невалидные правила запроса (`keys` — ключи невалидных правил). */
  invalidRules?: (c: Context, keys: string[]) => string;
  /** Тело запроса неизвестной формы (нет `rules`/лишние ключи). */
  invalidBody?: (c: Context) => string;
}

/** Опции фабрики: guard'ы и сообщения. */
export interface PermissionSettingsOptions {
  /** Guard чтения; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  readGuard?: Middleware;
  /** Guard мутаций; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  writeGuard?: Middleware;
  messages?: PermissionSettingsMessages;
}

/** Ответ GET/PUT/DELETE — контракт с UI. */
export interface PermissionSettingsView {
  /** Эффективная карта правил (`{}` — правил нет). */
  rules: Record<string, PermissionRule>;
  /** Источник эффективной карты (env-слоя у правил нет). */
  source: PermissionRulesSource;
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: { rules: Record<string, PermissionRule> };
  /** Таймаут подтверждения `ask`, мс — **не** управляется этой секцией. */
  askTimeoutMs: number;
}

const DEFAULT_INVALID_RULES = (_c: Context, keys: string[]): string =>
  `permission.rules: невалидные правила (${keys.map((key) => `"${key}"`).join(', ')}) — ` +
  'ожидается allow|deny|ask либо объект { "<pattern>": allow|deny|ask }';
const DEFAULT_INVALID_BODY = (): string =>
  'ожидается тело `{ rules: Record<string, PermissionRule> }`';

/** Ключи правил, не прошедшие схему (путь `rules.<key>` в issue). */
function invalidRuleKeys(issues: z.core.$ZodIssue[]): string[] {
  const keys: string[] = [];
  for (const issue of issues) {
    const [head, key] = issue.path;
    if (head !== 'rules' || typeof key !== 'string') continue;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Фабрика роутов `/api/v2/settings/permissions`.
 * `auth.requireAuth` — обязательный guard по умолчанию (core, single-user);
 * managed backend передаёт `requirePermission('ADMIN')`.
 */
export function createPermissionSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: PermissionSettingsDeps,
  opts: PermissionSettingsOptions = {},
): Hono {
  const app = new Hono();
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidRules = opts.messages?.invalidRules ?? DEFAULT_INVALID_RULES;
  const invalidBody = opts.messages?.invalidBody ?? ((_c: Context) => DEFAULT_INVALID_BODY());

  /** Актор изменения (id пользователя; core без RBAC — `local`). */
  const actorOf = (c: { get(key: 'user'): unknown }): string => {
    if (deps.resolveActor) return deps.resolveActor(c);
    const user = c.get('user') as { id?: unknown } | undefined;
    return typeof user?.id === 'string' && user.id ? user.id : 'local';
  };

  /** Эффективные правила по runtime-снимку (config — из deps). */
  const resolveWith = (runtimeRules: Record<string, PermissionRule> | undefined) =>
    resolvePermissionRules({
      ...(deps.config !== undefined ? { config: deps.config } : {}),
      ...(runtimeRules !== undefined ? { runtime: { rules: runtimeRules } } : {}),
    });

  /** Таймаут подтверждения: этой секцией не управляется (только для контекста). */
  const askTimeoutMs = (): number =>
    deps.live?.getConfig().askTimeoutMs ?? deps.config?.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;

  /** Снимок ответа по эффективным правилам. */
  const viewOf = (resolved: ReturnType<typeof resolveWith>): PermissionSettingsView => ({
    rules: resolved.rules,
    source: resolved.source,
    defaults: { rules: resolved.defaults },
    askTimeoutMs: askTimeoutMs(),
  });

  /** Снимок из порта (persisted runtime — источник истины для `GET`). */
  const buildView = async (): Promise<PermissionSettingsView> =>
    viewOf(resolveWith(await deps.settingsStore.getPermissionRules()));

  /** Best-effort аудит правки правил (`scope:'permission'`, `action:'update'`). */
  const audit = async (
    c: { get(key: 'user'): unknown },
    before: Record<string, PermissionRule>,
    after: Record<string, PermissionRule>,
  ): Promise<void> => {
    if (!deps.securityAudit) return;
    await recordPermissionAudit(
      { repository: deps.securityAudit },
      { action: 'update', actor: actorOf(c), before, after },
    );
  };

  app.get('/permissions', readGuard, async (c) => c.json(await buildView()));

  app.put('/permissions', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = putBodySchema.safeParse(body);
    if (!parsed.success) {
      const keys = invalidRuleKeys(parsed.error.issues);
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: keys.length > 0 ? invalidRules(c, keys) : invalidBody(c),
          },
        },
        400,
      );
    }

    const before = resolveWith(await deps.settingsStore.getPermissionRules());
    // Runtime-карта пишется **целиком**: `{ rules }` заменяет базу, а не
    // дополняет её (иначе снятие правила из UI не работало бы).
    await deps.settingsStore.setPermissionRules(parsed.data.rules);
    deps.live?.setRuntime({ rules: parsed.data.rules });
    await deps.live?.refresh();

    const view = await buildView();
    await deps.onRulesChange?.(view.rules);
    await audit(c, before.rules, view.rules);

    return c.json(view);
  });

  app.delete('/permissions', writeGuard, async (c) => {
    const before = resolveWith(await deps.settingsStore.getPermissionRules());

    await deps.settingsStore.clearPermission();
    deps.live?.setRuntime(undefined);
    await deps.live?.refresh();

    const view = await buildView();
    await deps.onRulesChange?.(view.rules);
    await audit(c, before.rules, view.rules);

    return c.json(view);
  });

  return app;
}
