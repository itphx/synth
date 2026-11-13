/**
 * ADR-135: контракты секции `execution` — канонические перечисления и
 * runtime-каталог профилей исполнения.
 *
 * Модуль **browser-safe** (только типы, константы и Zod): его читают и ядро
 * (`@itphx/synth-core`), и UI (админка «Исполнение»), поэтому канонические
 * списки значений живут здесь, а не в `config/types.ts` (config — Node-подмодуль,
 * в UI его брать нельзя).
 *
 * Runtime-каталог (`ExecutionRuntimeSettings`) — **admin-owned** секция
 * runtime-настроек: администратор управляет каталогом профилей и дефолтами
 * через `PUT /api/v2/settings/execution`; применяется при старте процесса
 * (`execution` — параметр запуска, инвариант 24 → `restartRequired`).
 */
import { z } from 'zod';

/**
 * Топология исполнения:
 * - `inline` (дефолт) — исполнение в процессе control plane;
 * - `remote` — отдельные исполнители (ADR-077).
 */
export const EXECUTION_MODES = ['inline', 'remote'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * Поведение при недоступном исполнителе:
 * - `fail` (дефолт) — fail-closed: инструмент недоступен с явной причиной;
 * - `inline-fallback` — backend исполняет команду сам; **только явной настройкой**
 *   (в managed-контуре это обход изоляции).
 */
export const EXECUTION_FAIL_MODES = ['fail', 'inline-fallback'] as const;
export type ExecutionFailMode = (typeof EXECUTION_FAIL_MODES)[number];

/**
 * Режим пула исполнителей (PROP-135, Ф4a).
 *
 * - `instance` (дефолт) — общий пул инстанса: один порт на процесс;
 * - `project` — порт на профиль для проекта (проектный пул);
 * - `session` — порт на профиль для сессии (эксклюзивный под).
 */
export const EXECUTION_POOLINGS = ['instance', 'project', 'session'] as const;
export type ExecutionPooling = (typeof EXECUTION_POOLINGS)[number];

/**
 * Поведение роутера исполнения, когда профиль непригоден (PROP-135, Ф4a):
 * - `instance` (дефолт) — откат на instance-порт (общий пул инстанса);
 * - `fail` — fail-closed: старт прерывается с понятной причиной.
 */
export const EXECUTION_FALLBACKS = ['instance', 'fail'] as const;
export type ExecutionFallback = (typeof EXECUTION_FALLBACKS)[number];

/**
 * Провайдер пулов исполнения (PROP-135, Ф4b-1):
 * - `static` (дефолт) — пулы **из конфигурации**;
 * - `http` — пулы запрашиваются у provisioner'а по HTTP.
 */
export const EXECUTION_POOL_PROVIDERS = ['static', 'http'] as const;
export type ExecutionPoolProviderKind = (typeof EXECUTION_POOL_PROVIDERS)[number];

/**
 * Сетевой класс профиля исполнения (PROP-135).
 *
 * **Метаданные**: описывают сетевой класс пула профиля (`none` — egress
 * запрещён, `restricted` — allowlist, `full` — без ограничений). Маршрутизацию
 * и создание портов значение **не** меняет.
 */
export const EXECUTION_PROFILE_NETWORKS = ['none', 'restricted', 'full'] as const;
export type ExecutionProfileNetwork = (typeof EXECUTION_PROFILE_NETWORKS)[number];

/** Список ресурсов профиля (`requests`/`limits` контейнера пула). */
export interface ExecutionProfileResourceList {
  /** CPU (`500m`, `1`). */
  cpu?: string;
  /** Память (`2Gi`). */
  memory?: string;
  /** Эфемерное хранилище (`1Gi`) — приходит от provisioner'а. */
  ephemeralStorage?: string;
}

/** Ресурсы профиля исполнения (как в PodSpec). */
export interface ExecutionProfileResources {
  requests?: ExecutionProfileResourceList;
  limits?: ExecutionProfileResourceList;
}

/** Таймаут exec-вызова по умолчанию (30 с — как у нынешних тулов). */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;

/** Таймаут обращения к provisioner'у пулов по умолчанию (10 с). */
export const DEFAULT_EXECUTION_PROVISIONER_TIMEOUT_MS = 10_000;

/**
 * Имя профиля исполнения для пула класса `browser` по умолчанию.
 *
 * Браузер — **проектный** пул (изоляция cookies между проектами), но профиль
 * у него свой: образ с браузером и MCP-сервером, а не образ обычных команд.
 */
export const DEFAULT_EXECUTION_BROWSER_PROFILE = 'browser';

/**
 * Имя MCP-сервера браузера в поде исполнителя по умолчанию (`playwright-mcp`).
 */
export const DEFAULT_EXECUTION_BROWSER_MCP_SERVER = 'playwright-mcp';

/** Предел длины имени профиля/сервера (RFC 1123 для имён Kubernetes). */
export const EXECUTION_RUNTIME_NAME_MAX = 253;

/** Предел длины описания профиля в runtime-каталоге. */
export const EXECUTION_RUNTIME_DESCRIPTION_MAX = 200;

/** Предел длины значения переменной окружения профиля. */
export const EXECUTION_RUNTIME_ENV_VALUE_MAX = 4096;

/**
 * Профиль исполнения в runtime-каталоге (ADR-135).
 *
 * Модель — как у профиля provisioner'а (`SYNTH_PROVISIONER_PROFILES`): образ
 * (`image`), адрес (`url`), сетевой класс, ресурсы, runtimeClass, read-only
 * корневая ФС, переменные окружения и **имена** MCP-серверов.
 *
 * `env` — переменные окружения пула; **секреты сюда не кладутся** (инвариант 13):
 * значения секретов задаются provisioner'у/исполнителю отдельно.
 */
export const executionRuntimeProfileSchema = z
  .object({
    /** Человекочитаемое описание (для админ-раздела «Исполнение»). */
    description: z.string().trim().max(EXECUTION_RUNTIME_DESCRIPTION_MAX).optional(),
    /** Образ пула (для `kubernetes`/динамических пулов). */
    image: z.string().trim().min(1).max(512).optional(),
    /** Адреса исполнителей профиля (для `static`). */
    url: z.array(z.string().trim().min(1)).optional(),
    /** Сетевой класс профиля. */
    network: z.enum(EXECUTION_PROFILE_NETWORKS).optional(),
    /** Ресурсы контейнера пула. */
    resources: z
      .object({
        requests: z
          .object({ cpu: z.string().optional(), memory: z.string().optional() })
          .optional(),
        limits: z
          .object({ cpu: z.string().optional(), memory: z.string().optional() })
          .optional(),
      })
      .optional(),
    /** `runtimeClassName` пода (например, `gvisor`, `kata`). */
    runtimeClass: z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX).optional(),
    /** Read-only корневая ФС контейнера (ADR-137; по умолчанию — у дефолта). */
    readOnlyRootFilesystem: z.boolean().optional(),
    /** Дополнительные переменные окружения пула (без секретов — инвариант 13). */
    env: z
      .record(
        z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX),
        z.string().max(EXECUTION_RUNTIME_ENV_VALUE_MAX),
      )
      .optional(),
    /** **Только имена** MCP-серверов профиля (без команд/env). */
    mcpServers: z.array(z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX)).optional(),
  })
  .strict();

/** Профиль исполнения в runtime-каталоге (ADR-135). */
export type ExecutionRuntimeProfile = z.infer<typeof executionRuntimeProfileSchema>;

/**
 * Runtime-каталог профилей исполнения и дефолтов (ADR-135).
 *
 * Секция runtime-настроек инстанса (`settings.json`/PG), **admin-owned**:
 * администратор управляет каталогом и дефолтами через
 * `GET/PUT/DELETE /api/v2/settings/execution`.
 *
 * Приоритет эффективного значения: **env/CLI > runtime > config.yaml**
 * (env/CLI разрешаются внутри `resolveExecutionConfig`, ADR-023).
 *
 * `profiles` — **полная замена** каталога config.yaml (как `profiles`/`rules`
 * в прокси, ADR-099): так администратор может и добавить профиль, и удалить
 * профиль из конфига. Пока runtime-каталог не задан, действует каталог
 * config.yaml.
 */
export const executionRuntimeSettingsSchema = z
  .object({
    /** Имя профиля по умолчанию (должен быть в каталоге). */
    defaultProfile: z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX).optional(),
    /** Профиль пула класса `browser` (браузер — свой образ/профиль). */
    browserProfile: z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX).optional(),
    /** Явный каталог браузерных профилей (каждый — из каталога профилей). */
    browserProfiles: z
      .array(z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX))
      .optional(),
    /** Режим пула исполнителей. */
    pooling: z.enum(EXECUTION_POOLINGS).optional(),
    /** Поведение роутера при непригодном профиле. */
    fallback: z.enum(EXECUTION_FALLBACKS).optional(),
    /** Каталог профилей исполнения (заменяет каталог config.yaml целиком). */
    profiles: z
      .record(
        z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX),
        executionRuntimeProfileSchema,
      )
      .optional(),
  })
  .strict();

/** Runtime-каталог профилей исполнения и дефолтов (ADR-135). */
export type ExecutionRuntimeSettings = z.infer<typeof executionRuntimeSettingsSchema>;
