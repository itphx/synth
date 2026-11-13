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

/**
 * Класс профиля исполнения (ADR-135, аддендум §11).
 *
 * - `exec` (дефолт) — обычные команды: профиль адресуется exec-контуром;
 * - `browser` — браузерный профиль (свой образ/MCP-сервер): адресуется только
 *   браузерным пулом (`class: 'browser'`);
 * - `both` — профиль годится и туда, и туда (общий образ пулов).
 *
 * Класс определяет, в какой каталог попадает профиль: exec-каталог —
 * `exec|both`, браузерный — `browser|both` (см. `resolveBrowserProfileNames`/
 * `resolveExecutionProfileNames` в `@itphx/synth-shared/config`).
 */
export const EXECUTION_PROFILE_CLASSES = ['exec', 'browser', 'both'] as const;
export type ExecutionProfileClass = (typeof EXECUTION_PROFILE_CLASSES)[number];

/**
 * Происхождение профиля эффективного каталога (ADR-135, аддендум §11).
 *
 * - `config` — профиль задан в `config.yaml` (его можно **отключить**);
 * - `runtime` — профиль создан в runtime-каталоге (удаляется удалением из
 *   `profiles`).
 */
export type ExecutionProfileOrigin = 'config' | 'runtime';

/**
 * MCP-сервер профиля исполнения (ADR-135, аддендум §11).
 *
 * В **config-уровне** (`execution.remote.profiles.<name>.mcpServers`) — только
 * **имена** серверов (метаданные): команда там не нужна. В **runtime-каталоге**
 * (`/api/v2/settings/execution`) — полное описание: имя + команда (+ аргументы
 * и env), потому что provisioner запускает сервер у себя и команду знать
 * обязан.
 *
 * `command` необязателен: записи, сохранённые старой версией runtime-секции
 * (только имена), нормализуются в `{ name }` — такие записи в `profileSpec`
 * provisioner'а **не** уходят (под получит дефолт образа).
 */
export interface ExecutionMcpServer {
  /** Имя MCP-сервера (уникально в профиле). */
  name: string;
  /** Команда запуска сервера (в runtime-каталоге — обязательна для spec). */
  command?: string;
  /** Аргументы команды. */
  args?: string[];
  /** Переменные окружения сервера (без секретов — инвариант 13). */
  env?: Record<string, string>;
}

/**
 * Список ресурсов профиля (`requests`/`limits` контейнера пула).
 *
 * Известные ключи (`cpu`/`memory`/`ephemeralStorage`) вынесены отдельными
 * полями, но **список произвольный**: расширенные ресурсы Kubernetes
 * (`nvidia.com/gpu`, `example.com/fpga`, …) задаются своими ключами — без
 * них GPU-профиль не выразить.
 */
export interface ExecutionProfileResourceList {
  /** CPU (`500m`, `1`). */
  cpu?: string;
  /** Память (`2Gi`). */
  memory?: string;
  /** Эфемерное хранилище (`1Gi`) — приходит от provisioner'а. */
  ephemeralStorage?: string;
  /**
   * Произвольные ключи ресурсов (`nvidia.com/gpu: "1"`) — количество
   * разбирает Kubernetes. Значение — строка в формате quantity.
   */
  [key: string]: string | undefined;
}

/**
 * Оператор toleration пода (`Exists` | `Equal`).
 *
 * `Exists` — переносить на ноду с любым значением ключа; `Equal` — только с
 * указанным значением (тогда `value` обязателен).
 */
export const EXECUTION_TOLERATION_OPERATORS = ['Exists', 'Equal'] as const;
export type ExecutionTolerationOperator = (typeof EXECUTION_TOLERATION_OPERATORS)[number];

/**
 * Эффект toleration пода (`NoSchedule` | `PreferNoSchedule` | `NoExecute`).
 */
export const EXECUTION_TOLERATION_EFFECTS = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'] as const;
export type ExecutionTolerationEffect = (typeof EXECUTION_TOLERATION_EFFECTS)[number];

/**
 * Toleration профиля — правило размещения пода на нодах.
 *
 * Passthrough в `spec.tolerations` пода: provisioner не интерпретирует
 * значения, Kubernetes — да.
 */
export interface ExecutionProfileToleration {
  /** Ключ taint'а ноды. */
  key?: string;
  /** Оператор сопоставления (`Exists` | `Equal`). */
  operator?: ExecutionTolerationOperator;
  /** Значение taint'а (для `Equal`). */
  value?: string;
  /** Эффект toleration. */
  effect?: ExecutionTolerationEffect;
  /** Срок жизни toleration для `NoExecute`, с. */
  tolerationSeconds?: number;
}

/**
 * Предел размера блока `affinity` (JSON) — 8 КиБ.
 *
 * `affinity` — **passthrough**: provisioner не интерпретирует структуру, но
 * размер ограничен (иначе в pod spec уедет произвольный объект).
 */
export const EXECUTION_AFFINITY_MAX_BYTES = 8 * 1024;

/**
 * Проверка значения ресурса — формат quantity Kubernetes
 * (`500m`, `2`, `1.5`, `4Gi`, `512Mi`, `1e3`).
 *
 * Fail-closed: мусор в значении ресурса Kubernetes отверг бы под — значит,
 * отвергаем его раньше (на разборе конфигурации).
 */
export function isValidResourceQuantity(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.test(trimmed);
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
 * Таймаут одного вызова браузерного MCP-инструмента по умолчанию (2 мин).
 *
 * Как у MCP-вызова в core: навигация и снимок страницы бывают медленными,
 * но зависший вызов не должен держать ход бесконечно.
 */
export const DEFAULT_EXECUTION_BROWSER_TIMEOUT_MS = 120_000;

/**
 * Потолок таймаута одного вызова браузерного MCP-инструмента (10 мин).
 *
 * Явное значение (конфиг инстанса или параметр `timeout` у тула) выше
 * потолка — **ошибка конфигурации** (fail-closed), а не тихая обрезка:
 * оператор должен знать, что его значение не применится.
 */
export const MAX_EXECUTION_BROWSER_TIMEOUT_MS = 600_000;

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

/** Предел длины команды MCP-сервера профиля. */
export const EXECUTION_RUNTIME_COMMAND_MAX = 512;

/**
 * MCP-сервер профиля в runtime-форме (ADR-135, аддендум §11).
 *
 * Схема принимает **строковую** форму (legacy: старые runtime-записи хранили
 * только имена) и нормализует её в объект `{ name }`.
 */
export const executionRuntimeMcpServerSchema = z
  .object({
    /** Имя MCP-сервера (уникально в профиле). */
    name: z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX),
    /** Команда запуска сервера (legacy-запись — без команды). */
    command: z.string().trim().min(1).max(EXECUTION_RUNTIME_COMMAND_MAX).optional(),
    /** Аргументы команды. */
    args: z.array(z.string().max(EXECUTION_RUNTIME_COMMAND_MAX)).optional(),
    /** Переменные окружения сервера (без секретов — инвариант 13). */
    env: z
      .record(
        z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX),
        z.string().max(EXECUTION_RUNTIME_ENV_VALUE_MAX),
      )
      .optional(),
  })
  .strict();

/**
 * MCP-серверы профиля: строки (legacy) → объекты `{ name }`.
 *
 * Нормализация нужна для обратной совместимости: runtime-записи, сохранённые
 * до аддендума §11, хранят только имена серверов.
 */
const executionRuntimeMcpServersSchema = z.preprocess(
  (raw: unknown) =>
    Array.isArray(raw)
      ? raw.map((entry) => (typeof entry === 'string' ? { name: entry.trim() } : entry))
      : raw,
  z.array(executionRuntimeMcpServerSchema),
);

/**
 * Ключ label/annotation Kubernetes (RFC 1123 с необязательным префиксом).
 *
 * Значение приходит из каталога профилей (администратора) — невалидный ключ
 * API-сервер отверг бы под целиком, поэтому проверяем на разборе.
 */
export const executionPodKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/,
    { message: 'ожидается ключ label/annotation Kubernetes' },
  );

/** Значение label Kubernetes (≤63 символов, `[A-Za-z0-9._-]`). */
export const executionLabelValueSchema = z
  .string()
  .trim()
  .max(63)
  .regex(/^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/, {
    message: 'ожидается значение label Kubernetes (до 63 символов)',
  });

/** Значение annotation Kubernetes — произвольная строка (длиннее label'а). */
export const executionAnnotationValueSchema = z.string().max(4096);

/** Значение ресурса — количество в формате Kubernetes. */
const resourceQuantitySchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidResourceQuantity, {
    message: 'ожидается количество ресурса Kubernetes (например, 500m, 2, 4Gi)',
  });

/**
 * Список ресурсов контейнера (`requests`/`limits`).
 *
 * Известные ключи объявлены явно, **произвольные — через `catchall`**
 * (`nvidia.com/gpu`, `example.com/fpga`): без них GPU-профиль не задать.
 */
export const executionResourceListSchema = z
  .object({
    cpu: resourceQuantitySchema.optional(),
    memory: resourceQuantitySchema.optional(),
    ephemeralStorage: resourceQuantitySchema.optional(),
  })
  .catchall(resourceQuantitySchema);

/** Toleration профиля (placement пода). */
export const executionTolerationSchema = z
  .object({
    /** Ключ taint'а ноды. */
    key: z.string().trim().min(1).max(253).optional(),
    /** Оператор сопоставления. */
    operator: z.enum(EXECUTION_TOLERATION_OPERATORS).optional(),
    /** Значение taint'а (для `Equal`). */
    value: z.string().trim().max(63).optional(),
    /** Эффект toleration. */
    effect: z.enum(EXECUTION_TOLERATION_EFFECTS).optional(),
    /** Срок жизни toleration для `NoExecute`, с. */
    tolerationSeconds: z.number().int().min(0).optional(),
  })
  .strict();

/**
 * `affinity` профиля — **passthrough** (структуру не интерпретируем), но с
 * пределом размера: блок уезжает в pod spec как есть.
 */
export const executionAffinitySchema = z
  .record(z.string().trim().min(1).max(253), z.unknown())
  .refine(
    (value) => (JSON.stringify(value)?.length ?? 0) <= EXECUTION_AFFINITY_MAX_BYTES,
    { message: `affinity: предел ${EXECUTION_AFFINITY_MAX_BYTES} байт` },
  );

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
    /** Ресурсы контейнера пула (произвольные ключи — например, `nvidia.com/gpu`). */
    resources: z
      .object({
        requests: executionResourceListSchema.optional(),
        limits: executionResourceListSchema.optional(),
      })
      .optional(),
    /**
     * Произвольные аннотации пода (`metadata.annotations`).
     *
     * Служебные аннотации provisioner'а (`synth.io/*`) приоритетнее: конфликт
     * решается в пользу служебных — иначе под перестал бы усыновляться.
     */
    annotations: z
      .record(executionPodKeySchema, executionAnnotationValueSchema)
      .optional(),
    /**
     * Пользовательские метки пода (`metadata.labels`).
     *
     * Служебные метки (`synth.io/*`, `app.kubernetes.io/*`) приоритетнее.
     */
    labels: z.record(executionPodKeySchema, executionLabelValueSchema).optional(),
    /** `spec.nodeSelector` пода — отбор нод по меткам. */
    nodeSelector: z.record(executionPodKeySchema, executionLabelValueSchema).optional(),
    /** `spec.tolerations` пода — правила размещения на «tainted» нодах. */
    tolerations: z.array(executionTolerationSchema).optional(),
    /** `spec.affinity` пода — passthrough (JSON, ≤8 КиБ). */
    affinity: executionAffinitySchema.optional(),
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
    /**
     * Класс профиля (ADR-135, аддендум §11): `exec` (дефолт) | `browser` |
     * `both`. Не задан — `exec`, кроме профилей из legacy-списка
     * `browserProfiles` и профиля по умолчанию `browserProfile` (для них
     * эффективный класс — `browser`).
     */
    class: z.enum(EXECUTION_PROFILE_CLASSES).optional(),
    /**
     * MCP-серверы профиля: имя + команда (+ аргументы/env).
     *
     * Строковая форма (`['playwright-mcp']`) — legacy-записи: нормализуется
     * в `{ name }` (см. `executionRuntimeMcpServersSchema`).
     */
    mcpServers: executionRuntimeMcpServersSchema.optional(),
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
 * `profiles` — **merge** поверх каталога config.yaml (аддендум §11): запись
 * runtime-слоя **переопределяет** одноимённую запись config целиком, а
 * config-записи, которых нет в runtime, **сохраняются**. Профили из config
 * **не удаляются** — их можно **отключить** (`disabledProfiles`); профиль,
 * созданный в runtime (нет в config), удаляется удалением из `profiles`.
 */
export const executionRuntimeSettingsSchema = z
  .object({
    /** Имя профиля по умолчанию (должен быть в каталоге). */
    defaultProfile: z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX).optional(),
    /** Профиль пула класса `browser` (браузер — свой образ/профиль). */
    browserProfile: z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX).optional(),
    /**
     * Legacy-подсказка класса: имена браузерных профилей (как `browserProfiles`
     * в config.yaml). Профили из списка получают эффективный класс `browser`,
     * если класс не задан явно. Новые записи его не используют — класс
     * задаётся полем `class` профиля.
     */
    browserProfiles: z
      .array(z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX))
      .optional(),
    /**
     * Отключённые профили **config-базы** (ADR-135, аддендум §11).
     *
     * Имена только из config-каталога: профиль, созданный в runtime, удаляется
     * удалением из `profiles`. Профиль по умолчанию и браузерный профиль
     * отключить нельзя (400) — сначала назначьте другой.
     */
    disabledProfiles: z
      .array(z.string().trim().min(1).max(EXECUTION_RUNTIME_NAME_MAX))
      .optional(),
    /** Режим пула исполнителей. */
    pooling: z.enum(EXECUTION_POOLINGS).optional(),
    /** Поведение роутера при непригодном профиле. */
    fallback: z.enum(EXECUTION_FALLBACKS).optional(),
    /** Каталог профилей исполнения (merge поверх каталога config.yaml). */
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
