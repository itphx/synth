/**
 * Конфигурация provisioner'а из env (PROP-135, Ф4b-2a/4b-2b).
 *
 * Provisioner — отдельный процесс (как исполнитель), поэтому конфигурация —
 * **только env**: у него нет доступа к каталогу данных инстанса.
 *
 * | Переменная | Обязательна | По умолчанию | Назначение |
 * |---|---|---|---|
 * | `SYNTH_PROVISIONER_TOKEN` | **да** | — | bearer-токен control plane |
 * | `SYNTH_PROVISIONER_HOST` | нет | `0.0.0.0` | адрес прослушивания |
 * | `SYNTH_PROVISIONER_PORT` | нет | `5200` | порт прослушивания |
 * | `SYNTH_PROVISIONER_PROVIDER` | нет | `static` | провайдер пулов (`static`\|`kubernetes`) |
 * | `SYNTH_PROVISIONER_PROFILES` | нет | `{}` | профили: `{"<profile>":{"image":…}}` |
 * | `SYNTH_PROVISIONER_STATIC_POOLS` | нет | `{}` | точные пулы: `{"<poolKey>":"http://…"}` |
 * | `SYNTH_PROVISIONER_IDLE_TIMEOUT_MS` | нет | `900000` | idle-таймаут проектного пула |
 * | `SYNTH_PROVISIONER_SESSION_IDLE_TIMEOUT_MS` | нет | `300000` | idle-таймаут сессионного пула |
 * | `SYNTH_PROVISIONER_MAX_LIFETIME_MS` | нет | `43200000` | предельное время жизни пула |
 * | `SYNTH_PROVISIONER_DRAIN_GRACE_MS` | нет | `30000` | пауза между drain и release |
 * | `SYNTH_PROVISIONER_MAX_POOLS` | нет | `50` | лимит живых пулов (`429` сверх) |
 * | `SYNTH_PROVISIONER_REAPER_INTERVAL_MS` | нет | `30000` | период уборщика |
 *
 * Kubernetes-провайдер (`SYNTH_PROVISIONER_PROVIDER=kubernetes`):
 *
 * | Переменная | Обязательна | По умолчанию | Назначение |
 * |---|---|---|---|
 * | `SYNTH_PROVISIONER_KUBERNETES_NAMESPACE` | нет | namespace ServiceAccount, иначе `synth` | namespace подов и секретов |
 * | `SYNTH_PROVISIONER_KUBERNETES_WORKSPACE_PVC` | **да** | — | PVC с рабочими каталогами проектов |
 * | `SYNTH_PROVISIONER_KUBERNETES_WORKSPACE_MOUNT` | нет | `/var/synth/data/workspaces` | точка монтирования PVC в пуле |
 * | `SYNTH_PROVISIONER_KUBERNETES_SERVICE_ACCOUNT` | нет | — | ServiceAccount пула |
 * | `SYNTH_PROVISIONER_KUBERNETES_IMAGE_PULL_SECRETS` | нет | — | csv имён imagePullSecret'ов |
 * | `SYNTH_PROVISIONER_KUBERNETES_API_SERVER` | нет | `https://kubernetes.default.svc` | адрес API |
 * | `SYNTH_PROVISIONER_KUBERNETES_TOKEN_FILE` | нет | `…/serviceaccount/token` | файл токена provisioner'а |
 * | `SYNTH_PROVISIONER_KUBERNETES_CA_FILE` | нет | `…/serviceaccount/ca.crt` | CA API-сервера |
 * | `SYNTH_PROVISIONER_KUBERNETES_START_TIMEOUT_MS` | нет | `120000` | ожидание Running/Ready пода |
 * | `SYNTH_PROVISIONER_KUBERNETES_POLL_INTERVAL_MS` | нет | `1000` | период опроса пода |
 * | `SYNTH_PROVISIONER_KUBERNETES_EXECUTOR_PORT` | нет | `5100` | порт исполнителя в поде |
 * | `SYNTH_PROVISIONER_KUBERNETES_TERMINATION_GRACE_SECONDS` | нет | `30` | grace-период пода |
 * | `SYNTH_PROVISIONER_KUBERNETES_FS_GROUP` | нет | `1000` | `fsGroup` подов пула; `none`/`null` — не выставлять (NFS) |
 *
 * Внешний чекер команд пулов (PROP-136b-2b; действует только при
 * `provider=kubernetes` — static-пул provisioner не создаёт):
 *
 * | Переменная | Обязательна | По умолчанию | Назначение |
 * |---|---|---|---|
 * | `SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_ENABLED` | нет | `false` | добавить env чекера в под пула |
 * | `SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_PROVIDER` | нет | `http` | `http`\|`opa` |
 * | `SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_URL` | при `enabled` | — | адрес чекера (`http(s)://…`) |
 * | `SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_TOKEN` | нет | — | значение токена (из Secret в env provisioner'а) |
 * | `SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_TOKEN_FILE` | нет | — | файл токена provisioner'а (альтернатива `TOKEN`) |
 * | `SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_FAIL_MODE` | нет | `closed` | `closed`\|`open` |
 * | `SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_TIMEOUT_MS` | нет | `2000` | таймаут запроса к чекеру, мс |
 * | `SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_CACHE_TTL_MS` | нет | `60000` | TTL кэша вердиктов, мс (`0` — без кэша) |
 * | `SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_OPA_PATH` | нет | `/v1/data/synth/exec/decision` | путь OPA-решения |
 *
 * Токен чекера **не попадает в env пода значением**: provisioner кладёт его
 * в уже создаваемый для пула `Secret` (ключ `command-policy-token`) и
 * монтирует файлом, а под получает `SYNTH_EXECUTOR_COMMAND_POLICY_TOKEN_FILE`
 * (у исполнителя токен — только файл). Значение не логируется и в values не
 * пишется (инвариант 13).
 *
 * **Fail-closed**: без токена процесс не стартует — provisioner без
 * аутентификации поднимал бы исполнителей по анонимному запросу. Битый JSON,
 * неизвестный `provider`, профиль без `url` (static) или без `image`
 * (kubernetes), отсутствие PVC, нечисловые значения, невалидные имена
 * Kubernetes-объектов — тоже ошибка старта: явная настройка оператора не
 * должна молча превращаться в дефолт.
 *
 * Токен provisioner'а читается один раз и удаляется из `process.env`
 * (`scrubProvisionerToken`); токен доступа к API кластера provisioner читает
 * сам (файл ServiceAccount) и **никогда не логирует** — ни его, ни токены
 * пулов.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { formatIssues } from './format.js';

/** Env-имена provisioner'а. */
export const PROVISIONER_ENV = {
  token: 'SYNTH_PROVISIONER_TOKEN',
  host: 'SYNTH_PROVISIONER_HOST',
  port: 'SYNTH_PROVISIONER_PORT',
  provider: 'SYNTH_PROVISIONER_PROVIDER',
  profiles: 'SYNTH_PROVISIONER_PROFILES',
  staticPools: 'SYNTH_PROVISIONER_STATIC_POOLS',
  idleTimeoutMs: 'SYNTH_PROVISIONER_IDLE_TIMEOUT_MS',
  sessionIdleTimeoutMs: 'SYNTH_PROVISIONER_SESSION_IDLE_TIMEOUT_MS',
  maxLifetimeMs: 'SYNTH_PROVISIONER_MAX_LIFETIME_MS',
  drainGraceMs: 'SYNTH_PROVISIONER_DRAIN_GRACE_MS',
  maxPools: 'SYNTH_PROVISIONER_MAX_POOLS',
  reaperIntervalMs: 'SYNTH_PROVISIONER_REAPER_INTERVAL_MS',
} as const;

/** Env-имена Kubernetes-провайдера. */
export const PROVISIONER_KUBERNETES_ENV = {
  namespace: 'SYNTH_PROVISIONER_KUBERNETES_NAMESPACE',
  workspacePvc: 'SYNTH_PROVISIONER_KUBERNETES_WORKSPACE_PVC',
  workspaceMount: 'SYNTH_PROVISIONER_KUBERNETES_WORKSPACE_MOUNT',
  serviceAccount: 'SYNTH_PROVISIONER_KUBERNETES_SERVICE_ACCOUNT',
  imagePullSecrets: 'SYNTH_PROVISIONER_KUBERNETES_IMAGE_PULL_SECRETS',
  apiServer: 'SYNTH_PROVISIONER_KUBERNETES_API_SERVER',
  tokenFile: 'SYNTH_PROVISIONER_KUBERNETES_TOKEN_FILE',
  caFile: 'SYNTH_PROVISIONER_KUBERNETES_CA_FILE',
  startTimeoutMs: 'SYNTH_PROVISIONER_KUBERNETES_START_TIMEOUT_MS',
  pollIntervalMs: 'SYNTH_PROVISIONER_KUBERNETES_POLL_INTERVAL_MS',
  executorPort: 'SYNTH_PROVISIONER_KUBERNETES_EXECUTOR_PORT',
  terminationGraceSeconds: 'SYNTH_PROVISIONER_KUBERNETES_TERMINATION_GRACE_SECONDS',
  fsGroup: 'SYNTH_PROVISIONER_KUBERNETES_FS_GROUP',
} as const;

/** Env-имена внешнего чекера команд пулов (PROP-136b-2b). */
export const PROVISIONER_COMMAND_POLICY_ENV = {
  enabled: 'SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_ENABLED',
  provider: 'SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_PROVIDER',
  url: 'SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_URL',
  token: 'SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_TOKEN',
  tokenFile: 'SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_TOKEN_FILE',
  failMode: 'SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_FAIL_MODE',
  timeoutMs: 'SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_TIMEOUT_MS',
  cacheTtlMs: 'SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_CACHE_TTL_MS',
  opaPath: 'SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_OPA_PATH',
} as const;

/** Дефолты внешнего чекера команд пулов. */
export const EXECUTOR_COMMAND_POLICY_DEFAULTS = {
  enabled: false,
  provider: 'http',
  failMode: 'closed',
  timeoutMs: 2_000,
  cacheTtlMs: 60_000,
  opaPath: '/v1/data/synth/exec/decision',
} as const;

/** Провайдеры чекера, которые понимает исполнитель. */
export const EXECUTOR_COMMAND_POLICY_PROVIDERS = ['http', 'opa'] as const;
/** Режимы недоступности чекера. */
export const EXECUTOR_COMMAND_POLICY_FAIL_MODES = ['closed', 'open'] as const;

/** Дефолты provisioner'а. */
export const PROVISIONER_DEFAULTS = {
  host: '0.0.0.0',
  port: 5200,
  provider: 'static',
  idleTimeoutMs: 900_000,
  sessionIdleTimeoutMs: 300_000,
  maxLifetimeMs: 43_200_000,
  drainGraceMs: 30_000,
  maxPools: 50,
  reaperIntervalMs: 30_000,
} as const;

/** Каталог ServiceAccount, смонтированный Kubernetes в под. */
export const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** Дефолты Kubernetes-провайдера. */
export const KUBERNETES_DEFAULTS = {
  /** Fallback namespace, если файл ServiceAccount недоступен (dev/тесты). */
  namespace: 'synth',
  workspaceMount: '/var/synth/data/workspaces',
  apiServer: 'https://kubernetes.default.svc',
  tokenFile: `${SERVICE_ACCOUNT_DIR}/token`,
  caFile: `${SERVICE_ACCOUNT_DIR}/ca.crt`,
  namespaceFile: `${SERVICE_ACCOUNT_DIR}/namespace`,
  startTimeoutMs: 120_000,
  pollIntervalMs: 1_000,
  executorPort: 5100,
  terminationGraceSeconds: 30,
  /** `fsGroup` подов пула (non-root uid/gid 1000). */
  fsGroup: 1000,
} as const;

/** Провайдеры пулов, которые умеет собирать фабрика. */
export const PROVISIONER_PROVIDERS = ['static', 'kubernetes'] as const;

/** Имя провайдера пулов. */
export type ProvisionerProviderName = (typeof PROVISIONER_PROVIDERS)[number];

/** http(s)-URL: единственная схема, которую понимает transport портов. */
const httpUrlSchema = z.string().trim().min(1).refine(
  (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'ожидается http(s)-URL' },
);

/**
 * Значение ресурса (`500m`, `1Gi`, …) — количество разбирает Kubernetes.
 *
 * Формат — **quantity** Kubernetes: мусор отвергаем на старте (fail-closed),
 * иначе под не поднялся бы с `422` от API-сервера.
 */
const quantitySchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.test(value),
    { message: 'ожидается количество ресурса Kubernetes (например, 500m, 2, 4Gi)' },
  );

/**
 * Список ресурсов контейнера (requests/limits).
 *
 * Известные ключи объявлены явно, **произвольные — через `catchall`**
 * (`nvidia.com/gpu`, `example.com/fpga`): без них GPU-профиль не задать.
 */
const resourceListSchema = z
  .object({
    cpu: quantitySchema.optional(),
    memory: quantitySchema.optional(),
    ephemeralStorage: quantitySchema.optional(),
  })
  .catchall(quantitySchema);

/** Блок `resources` профиля: `requests` и/или `limits`. */
const resourcesSchema = z
  .object({
    requests: resourceListSchema.optional(),
    limits: resourceListSchema.optional(),
  })
  .strict();

/**
 * Ключ label/annotation Kubernetes (RFC 1123 с необязательным префиксом).
 *
 * Значение приходит от оператора — невалидный ключ API-сервер отверг бы под
 * целиком, поэтому проверяем на разборе конфигурации.
 */
const kubernetesKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/,
    { message: 'ожидается ключ label/annotation Kubernetes' },
  );

/** Значение label Kubernetes (≤63 символов, `[A-Za-z0-9._-]`). */
const kubernetesLabelValueSchema = z
  .string()
  .trim()
  .max(63)
  .regex(/^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/, {
    message: 'ожидается значение label Kubernetes (до 63 символов)',
  });

/** Значение annotation Kubernetes — произвольная строка (длиннее label'а). */
const kubernetesAnnotationValueSchema = z.string().max(4096);

/** Операторы toleration пода. */
const TOLERATION_OPERATORS = ['Exists', 'Equal'] as const;
/** Эффекты toleration пода. */
const TOLERATION_EFFECTS = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'] as const;

/** Toleration профиля (placement пода). */
const tolerationSchema = z
  .object({
    /** Ключ taint'а ноды. */
    key: z.string().trim().min(1).max(253).optional(),
    /** Оператор сопоставления. */
    operator: z.enum(TOLERATION_OPERATORS).optional(),
    /** Значение taint'а (для `Equal`). */
    value: z.string().trim().max(63).optional(),
    /** Эффект toleration. */
    effect: z.enum(TOLERATION_EFFECTS).optional(),
    /** Срок жизни toleration для `NoExecute`, с. */
    tolerationSeconds: z.number().int().min(0).optional(),
  })
  .strict();

/** Предел размера блока `affinity` (JSON) — 8 КиБ. */
const AFFINITY_MAX_BYTES = 8 * 1024;

/**
 * `affinity` профиля — **passthrough** (структуру provisioner не
 * интерпретирует), но с пределом размера: блок уезжает в pod spec как есть.
 */
const affinitySchema = z
  .record(z.string().trim().min(1).max(253), z.unknown())
  .refine((value) => (JSON.stringify(value)?.length ?? 0) <= AFFINITY_MAX_BYTES, {
    message: `affinity: предел ${AFFINITY_MAX_BYTES} байт`,
  });

/** Имя Kubernetes-объекта (DNS-1123 subdomain, урезанное до 253 символов). */
const kubernetesNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, {
    message: 'ожидается DNS-1123 имя Kubernetes-объекта',
  });

/**
 * Описание MCP-сервера профиля (PROP-135 слайз 5b-1).
 *
 * Формат — как у исполнителя (`SYNTH_EXECUTOR_MCP_SERVERS`, ADR-077 шаг B1):
 * `{name, command, args?, env?}`. Значения `env` — как есть (это могут быть
 * токены хостингов): provisioner их **не логирует** и не пишет в диагностику,
 * но они попадают в spec пода (см. README чарта — `kubectl describe pod` их
 * покажет).
 */
const mcpServerSchema = z
  .object({
    /** Имя MCP-сервера (уникально в профиле). */
    name: z.string().trim().min(1).max(256),
    /** Команда запуска сервера. */
    command: z.string().trim().min(1).max(1024),
    /** Аргументы команды. */
    args: z.array(z.string().max(1024)).optional(),
    /** Переменные окружения сервера (значения — как есть). */
    env: z.record(z.string().trim().min(1).max(256), z.string()).optional(),
  })
  .strict();

/**
 * Список MCP-серверов профиля.
 *
 * Имена должны быть уникальны: исполнитель разбирает `SYNTH_EXECUTOR_MCP_SERVERS`
 * **строго** и падает при дубле — лучше отказать на старте provisioner'а
 * (fail-closed у оператора), чем поднимать под, который не стартует.
 */
const mcpServersSchema = z.array(mcpServerSchema).superRefine((servers, ctx) => {
  const seen = new Set<string>();
  servers.forEach((server, index) => {
    if (seen.has(server.name)) {
      ctx.addIssue({
        code: 'custom',
        message: `дубликат имени MCP-сервера "${server.name}"`,
        path: [index, 'name'],
      });
    }
    seen.add(server.name);
  });
});

/** Описание профиля исполнения. */
export const profileSchema = z
  .object({
    /**
     * Человекочитаемое описание профиля (для админ-раздела «Исполнение»):
     * какой образ/сеть/ресурсы внутри. На поведение пула не влияет.
     */
    description: z.string().trim().min(1).max(500).optional(),
    /** Образ пула (обязателен для `kubernetes`). */
    image: z.string().trim().min(1).max(512).optional(),
    /** Адрес исполнителя (обязателен для `static`). */
    url: httpUrlSchema.optional(),
    /** Сетевой класс профиля (подпись `synth.io/network`; политику задаёт чарт). */
    network: z.enum(['none', 'restricted', 'full']).optional(),
    /** Ресурсы контейнера пула (произвольные ключи — например, `nvidia.com/gpu`). */
    resources: resourcesSchema.optional(),
    /**
     * Произвольные аннотации пода (`metadata.annotations`).
     *
     * Служебные аннотации provisioner'а (`synth.io/*`) приоритетнее: конфликт
     * решается в пользу служебных — иначе под перестал бы усыновляться.
     */
    annotations: z.record(kubernetesKeySchema, kubernetesAnnotationValueSchema).optional(),
    /** Пользовательские метки пода (`metadata.labels`); служебные приоритетнее. */
    labels: z.record(kubernetesKeySchema, kubernetesLabelValueSchema).optional(),
    /** `spec.nodeSelector` пода — отбор нод по меткам. */
    nodeSelector: z.record(kubernetesKeySchema, kubernetesLabelValueSchema).optional(),
    /** `spec.tolerations` пода — правила размещения на «tainted» нодах. */
    tolerations: z.array(tolerationSchema).optional(),
    /** `spec.affinity` пода — passthrough (JSON, ≤8 КиБ). */
    affinity: affinitySchema.optional(),
    /** `runtimeClassName` пода (например, `gvisor`, `kata`). */
    runtimeClass: kubernetesNameSchema.optional(),
    /** Read-only корневая ФС контейнера (по умолчанию `true`). */
    readOnlyRootFilesystem: z.boolean().optional(),
    /** Дополнительные переменные окружения контейнера pools. */
    env: z.record(z.string().trim().min(1).max(256), z.string()).optional(),
    /**
     * MCP-серверы, которые исполнитель пула хостит у себя (PROP-135 слайс 5b-1):
     * уходят в env пода `SYNTH_EXECUTOR_MCP_SERVERS` (JSON). Пусто/не задано —
     * переменная не выставляется (дефолт образа: у flavor'ов с браузером —
     * Playwright MCP).
     */
    mcpServers: mcpServersSchema.optional(),
  })
  .strict();

/** Каталог профилей: имя профиля → описание. */
export const profilesSchema = z.record(z.string().trim().min(1), profileSchema);

/** Точные пулы: канонический ключ пула → адрес исполнителя. */
export const staticPoolsSchema = z.record(z.string().trim().min(1), httpUrlSchema);

/** Описание профиля из env. */
export type ProvisionerProfile = z.output<typeof profileSchema>;

/** Каталог профилей из env. */
export type ProvisionerProfiles = z.output<typeof profilesSchema>;

/** Эффективная конфигурация Kubernetes-провайдера. */
export interface ProvisionerKubernetesConfig {
  /** Namespace подов и секретов. */
  namespace: string;
  /** PVC с рабочими каталогами проектов. */
  workspacePvc: string;
  /** Точка монтирования PVC в пуле. */
  workspaceMount: string;
  /** ServiceAccount пула (если задан). */
  serviceAccount?: string;
  /** imagePullSecret'и пула. */
  imagePullSecrets: string[];
  /** Адрес Kubernetes API. */
  apiServer: string;
  /** Файл токена provisioner'а. */
  tokenFile: string;
  /** Файл CA Kubernetes API. */
  caFile: string;
  /** Ожидание Running/Ready пода, мс. */
  startTimeoutMs: number;
  /** Период опроса пода, мс. */
  pollIntervalMs: number;
  /** Порт исполнителя в поде. */
  executorPort: number;
  /** Grace-период завершения пода, с. */
  terminationGraceSeconds: number;
  /**
   * `fsGroup` подов пула: не задано — дефолт `1000`, `null` — не выставлять
   * в pod spec (например, NFS: kubelet иначе рекурсивно меняет владельца
   * всего тома при старте пода).
   */
  fsGroup?: number | null;
}

/** Эффективная конфигурация внешнего чекера команд пулов. */
export interface ProvisionerExecutorCommandPolicyConfig {
  /** Добавлять env чекера в под пула. */
  enabled: boolean;
  /** Провайдер чекера (`http`|`opa`). */
  provider: 'http' | 'opa';
  /** Адрес чекера (обязателен при `enabled`). */
  url?: string;
  /**
   * Значение bearer-токена чекера (из env provisioner'а либо из `tokenFile`).
   * В логи и диагностику не попадает.
   */
  token?: string;
  /** Поведение при недоступном чекере. */
  failMode: 'closed' | 'open';
  /** Таймаут запроса к чекеру, мс. */
  timeoutMs: number;
  /** TTL кэша вердиктов, мс (`0` — без кэша). */
  cacheTtlMs: number;
  /** Путь OPA-решения (`provider: opa`). */
  opaPath: string;
}

/** Эффективная конфигурация provisioner'а. */
export interface ProvisionerConfig {
  /** Bearer-токен control plane (в логи не пишется). */
  token: string;
  /** Адрес прослушивания. */
  host: string;
  /** Порт прослушивания. */
  port: number;
  /** Провайдер пулов. */
  provider: ProvisionerProviderName;
  /** Каталог профилей исполнения. */
  profiles: ProvisionerProfiles;
  /** Точные пулы (тесты/дев): ключ → адрес. */
  staticPools: Record<string, string>;
  /** Kubernetes-провайдер (только при `provider=kubernetes`). */
  kubernetes?: ProvisionerKubernetesConfig;
  /** Внешний чекер команд в подах пулов (PROP-136b-2b; выключен по умолчанию). */
  executorCommandPolicy: ProvisionerExecutorCommandPolicyConfig;
  /** Idle-таймаут проектного/инстансного пула, мс. */
  idleTimeoutMs: number;
  /** Idle-таймаут сессионного пула, мс. */
  sessionIdleTimeoutMs: number;
  /** Предельное время жизни пула, мс. */
  maxLifetimeMs: number;
  /** Пауза между drain и release, мс. */
  drainGraceMs: number;
  /** Лимит живых пулов (сверх — `429`). */
  maxPools: number;
  /** Период уборщика, мс. */
  reaperIntervalMs: number;
}

/**
 * Разобрать JSON-значение env строгой схемой.
 *
 * @param raw значение env (пустое/незаданное — `fallback`)
 * @param envName имя переменной (для понятного текста ошибки)
 * @param schema схема значения
 * @param fallback значение по умолчанию
 */
export function parseJsonEnv<S extends z.ZodType>(
  raw: string | undefined,
  envName: string,
  schema: S,
  fallback: z.output<S>,
): z.output<S> {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `[provisioner] невалидный JSON в ${envName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`[provisioner] невалидное значение ${envName}: ${formatIssues(result.error)}`);
  }
  return result.data;
}

/** Разобрать целое значение env (строго: мусор — ошибка старта). */
function resolveInt(
  raw: string | undefined,
  envName: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `[provisioner] невалидное значение ${envName}="${raw}" — ожидается целое число в ${min}..${max}`,
    );
  }
  return value;
}

/**
 * Разобрать `fsGroup` подов пула.
 *
 * - пусто/не задано → дефолт `1000` (поведение прежних версий);
 * - `none`/`null` (trim, регистр не важен) → `null` — в pod spec не выставлять
 *   (NFS: kubelet не делает рекурсивный chown при старте пода);
 * - число → число; прочее — ошибка старта (fail-closed, как соседние поля).
 */
function resolveFsGroup(
  raw: string | undefined,
  envName: string,
  fallback: number,
): number | null {
  const value = (raw ?? '').trim();
  if (value === '') return fallback;
  const lowered = value.toLowerCase();
  if (lowered === 'none' || lowered === 'null') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `[provisioner] невалидное значение ${envName}="${raw}" — ожидается целое число ≥ 1, "none" или "null"`,
    );
  }
  return parsed;
}

/** Обязательная непустая строка env. */
function requireEnvString(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `[provisioner] обязательная переменная ${name} не задана — provisioner не стартует (fail-closed)`,
    );
  }
  return raw.trim();
}

/** Необязательная строка env (`undefined`/пусто — `undefined`). */
function optionalEnvString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim() ?? '';
  return raw === '' ? undefined : raw;
}

/** csv-список env (`undefined`/пусто — пустой массив). */
function resolveCsv(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = env[name]?.trim() ?? '';
  if (raw === '') return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Чтение файла (инъектируется тестами: в контейнере ServiceAccount-каталог есть не всегда). */
export type ConfigFileReader = (path: string) => string;

/** Параметры разбора конфигурации (швы для тестов). */
export interface ResolveConfigOptions {
  /** Читатель файлов (по умолчанию `node:fs.readFileSync`). */
  readFile?: ConfigFileReader;
}

/** Прочитать файл как текст (ошибка чтения — не ошибка конфигурации). */
function readFileOrUndefined(readFile: ConfigFileReader, path: string): string | undefined {
  try {
    const value = readFile(path).trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * Разобрать namespace: env → файл ServiceAccount → `synth`.
 *
 * Namespace пода — не секрет, но и угадывать его не нужно: Kubernetes сам
 * кладёт имя namespace в каталог ServiceAccount.
 */
function resolveNamespace(
  env: NodeJS.ProcessEnv,
  readFile: ConfigFileReader,
): string {
  const explicit = optionalEnvString(env, PROVISIONER_KUBERNETES_ENV.namespace);
  const value =
    explicit ?? readFileOrUndefined(readFile, KUBERNETES_DEFAULTS.namespaceFile) ?? KUBERNETES_DEFAULTS.namespace;
  const parsed = kubernetesNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `[provisioner] невалидный namespace "${value}" (${PROVISIONER_KUBERNETES_ENV.namespace}` +
        `${explicit === undefined ? ' / файл ServiceAccount' : ''}): ${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Проверить имя Kubernetes-объекта из env (fail-closed). */
function requireKubernetesName(value: string, envName: string): string {
  const parsed = kubernetesNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `[provisioner] невалидное значение ${envName}="${value}": ${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Собрать конфигурацию Kubernetes-провайдера (fail-closed). */
function resolveKubernetesConfig(
  env: NodeJS.ProcessEnv,
  readFile: ConfigFileReader,
): ProvisionerKubernetesConfig {
  const workspacePvc = requireEnvString(env, PROVISIONER_KUBERNETES_ENV.workspacePvc);
  const serviceAccount = optionalEnvString(env, PROVISIONER_KUBERNETES_ENV.serviceAccount);
  const imagePullSecrets = resolveCsv(env, PROVISIONER_KUBERNETES_ENV.imagePullSecrets).map((name) =>
    requireKubernetesName(name, PROVISIONER_KUBERNETES_ENV.imagePullSecrets),
  );

  const apiServer =
    optionalEnvString(env, PROVISIONER_KUBERNETES_ENV.apiServer) ?? KUBERNETES_DEFAULTS.apiServer;
  const apiServerParsed = httpUrlSchema.safeParse(apiServer);
  if (!apiServerParsed.success) {
    throw new Error(
      `[provisioner] невалидный адрес API ${PROVISIONER_KUBERNETES_ENV.apiServer}="${apiServer}"`,
    );
  }

  const workspaceMount =
    optionalEnvString(env, PROVISIONER_KUBERNETES_ENV.workspaceMount) ??
    KUBERNETES_DEFAULTS.workspaceMount;
  if (!workspaceMount.startsWith('/')) {
    throw new Error(
      `[provisioner] ${PROVISIONER_KUBERNETES_ENV.workspaceMount} должен быть абсолютным путём, ` +
        `получено "${workspaceMount}"`,
    );
  }

  return {
    namespace: resolveNamespace(env, readFile),
    workspacePvc: requireKubernetesName(workspacePvc, PROVISIONER_KUBERNETES_ENV.workspacePvc),
    workspaceMount,
    ...(serviceAccount !== undefined
      ? {
          serviceAccount: requireKubernetesName(
            serviceAccount,
            PROVISIONER_KUBERNETES_ENV.serviceAccount,
          ),
        }
      : {}),
    imagePullSecrets,
    apiServer,
    tokenFile:
      optionalEnvString(env, PROVISIONER_KUBERNETES_ENV.tokenFile) ??
      KUBERNETES_DEFAULTS.tokenFile,
    caFile:
      optionalEnvString(env, PROVISIONER_KUBERNETES_ENV.caFile) ?? KUBERNETES_DEFAULTS.caFile,
    startTimeoutMs: resolveInt(
      env[PROVISIONER_KUBERNETES_ENV.startTimeoutMs],
      PROVISIONER_KUBERNETES_ENV.startTimeoutMs,
      KUBERNETES_DEFAULTS.startTimeoutMs,
    ),
    pollIntervalMs: resolveInt(
      env[PROVISIONER_KUBERNETES_ENV.pollIntervalMs],
      PROVISIONER_KUBERNETES_ENV.pollIntervalMs,
      KUBERNETES_DEFAULTS.pollIntervalMs,
    ),
    executorPort: resolveInt(
      env[PROVISIONER_KUBERNETES_ENV.executorPort],
      PROVISIONER_KUBERNETES_ENV.executorPort,
      KUBERNETES_DEFAULTS.executorPort,
      1,
      65_535,
    ),
    terminationGraceSeconds: resolveInt(
      env[PROVISIONER_KUBERNETES_ENV.terminationGraceSeconds],
      PROVISIONER_KUBERNETES_ENV.terminationGraceSeconds,
      KUBERNETES_DEFAULTS.terminationGraceSeconds,
      0,
      3_600,
    ),
    fsGroup: resolveFsGroup(
      env[PROVISIONER_KUBERNETES_ENV.fsGroup],
      PROVISIONER_KUBERNETES_ENV.fsGroup,
      KUBERNETES_DEFAULTS.fsGroup,
    ),
  };
}

/** Разобрать значение из закрытого набора (неизвестное — ошибка старта). */
function resolveChoice<T extends string>(
  raw: string | undefined,
  envName: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = (raw ?? '').trim();
  if (value === '') return fallback;
  const match = allowed.find((item) => item === value);
  if (match === undefined) {
    throw new Error(
      `[provisioner] невалидное значение ${envName}="${value}" — ожидается ${allowed
        .map((item) => `"${item}"`)
        .join(' или ')}`,
    );
  }
  return match;
}

/** Разобрать булево env (`true`/`false`/`1`/`0`; прочее — ошибка старта). */
function resolveBoolEnv(raw: string | undefined, envName: string, fallback: boolean): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(
    `[provisioner] невалидное значение ${envName}="${raw}" — ожидается true|false`,
  );
}

/**
 * Разобрать конфигурацию внешнего чекера команд пулов (PROP-136b-2b).
 *
 * Включённый чекер без `url` — ошибка старта: иначе provisioner поднимал бы
 * пулы, где политика молча не применяется. Токен берётся значением из
 * `..._TOKEN` (Secret → env provisioner'а) либо из файла `..._TOKEN_FILE`; в
 * pod env он **не** передаётся — provisioner кладёт его в Secret пула.
 */
export function resolveExecutorCommandPolicy(
  env: NodeJS.ProcessEnv,
  readFile: ConfigFileReader,
): ProvisionerExecutorCommandPolicyConfig {
  const enabled = resolveBoolEnv(
    env[PROVISIONER_COMMAND_POLICY_ENV.enabled],
    PROVISIONER_COMMAND_POLICY_ENV.enabled,
    EXECUTOR_COMMAND_POLICY_DEFAULTS.enabled,
  );
  const provider = resolveChoice(
    env[PROVISIONER_COMMAND_POLICY_ENV.provider],
    PROVISIONER_COMMAND_POLICY_ENV.provider,
    EXECUTOR_COMMAND_POLICY_PROVIDERS,
    EXECUTOR_COMMAND_POLICY_DEFAULTS.provider,
  );
  const failMode = resolveChoice(
    env[PROVISIONER_COMMAND_POLICY_ENV.failMode],
    PROVISIONER_COMMAND_POLICY_ENV.failMode,
    EXECUTOR_COMMAND_POLICY_FAIL_MODES,
    EXECUTOR_COMMAND_POLICY_DEFAULTS.failMode,
  );
  const timeoutMs = resolveInt(
    env[PROVISIONER_COMMAND_POLICY_ENV.timeoutMs],
    PROVISIONER_COMMAND_POLICY_ENV.timeoutMs,
    EXECUTOR_COMMAND_POLICY_DEFAULTS.timeoutMs,
  );
  const cacheTtlMs = resolveInt(
    env[PROVISIONER_COMMAND_POLICY_ENV.cacheTtlMs],
    PROVISIONER_COMMAND_POLICY_ENV.cacheTtlMs,
    EXECUTOR_COMMAND_POLICY_DEFAULTS.cacheTtlMs,
    0,
  );
  const rawOpaPath =
    env[PROVISIONER_COMMAND_POLICY_ENV.opaPath]?.trim() ||
    EXECUTOR_COMMAND_POLICY_DEFAULTS.opaPath;
  if (!rawOpaPath.startsWith('/')) {
    throw new Error(
      `[provisioner] невалидное значение ${PROVISIONER_COMMAND_POLICY_ENV.opaPath}="${rawOpaPath}" — путь должен начинаться с "/"`,
    );
  }

  const config: ProvisionerExecutorCommandPolicyConfig = {
    enabled,
    provider,
    failMode,
    timeoutMs,
    cacheTtlMs,
    opaPath: rawOpaPath,
  };
  if (!enabled) return config;

  const rawUrl = env[PROVISIONER_COMMAND_POLICY_ENV.url]?.trim() ?? '';
  if (rawUrl === '') {
    throw new Error(
      `[provisioner] ${PROVISIONER_COMMAND_POLICY_ENV.enabled}="true" требует адрес чекера ` +
        `(${PROVISIONER_COMMAND_POLICY_ENV.url}) — provisioner не стартует (fail-closed)`,
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(
      `[provisioner] невалидное значение ${PROVISIONER_COMMAND_POLICY_ENV.url}="${rawUrl}" — ожидается http(s)-адрес`,
    );
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `[provisioner] невалидное значение ${PROVISIONER_COMMAND_POLICY_ENV.url}="${rawUrl}" — поддерживаются только http/https`,
    );
  }
  config.url = rawUrl.replace(/\/+$/, '');

  const inlineToken = env[PROVISIONER_COMMAND_POLICY_ENV.token]?.trim() ?? '';
  if (inlineToken !== '') {
    config.token = inlineToken;
  } else {
    const tokenFile = env[PROVISIONER_COMMAND_POLICY_ENV.tokenFile]?.trim() ?? '';
    if (tokenFile !== '') {
      let value: string;
      try {
        value = readFile(tokenFile).trim();
      } catch {
        throw new Error(
          `[provisioner] ${PROVISIONER_COMMAND_POLICY_ENV.tokenFile}="${tokenFile}" — ` +
            'файл токена чекера недоступен для чтения (provisioner не стартует, fail-closed)',
        );
      }
      if (value === '') {
        throw new Error(
          `[provisioner] ${PROVISIONER_COMMAND_POLICY_ENV.tokenFile}="${tokenFile}" — файл токена чекера пуст`,
        );
      }
      config.token = value;
    }
  }

  return config;
}

/** Разобрать имя провайдера (неизвестное — ошибка, не молчаливый `static`). */
function resolveProvider(env: NodeJS.ProcessEnv): ProvisionerProviderName {
  const raw = (env[PROVISIONER_ENV.provider] ?? '').trim() || PROVISIONER_DEFAULTS.provider;
  const match = PROVISIONER_PROVIDERS.find((name) => name === raw);
  if (match === undefined) {
    throw new Error(
      `[provisioner] неизвестный provider "${raw}" — ожидается ${PROVISIONER_PROVIDERS.map(
        (name) => `"${name}"`,
      ).join(' или ')} (${PROVISIONER_ENV.provider})`,
    );
  }
  return match;
}

/**
 * Разобрать конфигурацию provisioner'а из env.
 *
 * @param env окружение (по умолчанию `process.env`)
 * @param opts швы для тестов (читатель файлов ServiceAccount)
 * @throws Error при отсутствии обязательных значений или невалидном env (fail-closed)
 */
export function resolveProvisionerConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveConfigOptions = {},
): ProvisionerConfig {
  const readFile: ConfigFileReader =
    opts.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const provider = resolveProvider(env);

  const profiles = parseJsonEnv(
    env[PROVISIONER_ENV.profiles],
    PROVISIONER_ENV.profiles,
    profilesSchema,
    {},
  );
  const staticPools = parseJsonEnv(
    env[PROVISIONER_ENV.staticPools],
    PROVISIONER_ENV.staticPools,
    staticPoolsSchema,
    {},
  );

  if (provider === 'static') {
    // В static-режиме адрес профиля — единственный источник пула: профиль без
    // url сделал бы профиль «объявленным, но недоступным».
    for (const [name, profile] of Object.entries(profiles)) {
      if (profile.url === undefined) {
        throw new Error(
          `[provisioner] профиль "${name}" без url — в static-режиме url обязателен ` +
            `(${PROVISIONER_ENV.profiles})`,
        );
      }
    }
    if (Object.keys(profiles).length === 0 && Object.keys(staticPools).length === 0) {
      throw new Error(
        '[provisioner] не задано ни одного профиля и ни одного статического пула — ' +
          `provisioner не смог бы выдать ни одного пула (${PROVISIONER_ENV.profiles} / ${PROVISIONER_ENV.staticPools})`,
      );
    }
  } else {
    // kubernetes: пул — под с образом профиля. Профиль без образа поднять не из
    // чего, а статические адреса этот провайдер не использует — их наличие
    // означает, что оператор настроил не тот провайдер.
    if (Object.keys(staticPools).length > 0) {
      throw new Error(
        `[provisioner] ${PROVISIONER_ENV.staticPools} задан, но провайдер "kubernetes" ` +
          'статические пулы не использует — уберите переменную или смените провайдер',
      );
    }
    if (Object.keys(profiles).length === 0) {
      throw new Error(
        '[provisioner] провайдер "kubernetes" требует хотя бы один профиль с образом ' +
          `(${PROVISIONER_ENV.profiles})`,
      );
    }
    for (const [name, profile] of Object.entries(profiles)) {
      if (profile.image === undefined) {
        throw new Error(
          `[provisioner] профиль "${name}" без image — в режиме kubernetes image обязателен ` +
            `(${PROVISIONER_ENV.profiles})`,
        );
      }
    }
  }

  const host = env[PROVISIONER_ENV.host]?.trim() || PROVISIONER_DEFAULTS.host;
  const port = resolveInt(env[PROVISIONER_ENV.port], PROVISIONER_ENV.port, PROVISIONER_DEFAULTS.port, 1, 65_535);
  const kubernetes = provider === 'kubernetes' ? resolveKubernetesConfig(env, readFile) : undefined;

  return {
    token: requireEnvString(env, PROVISIONER_ENV.token),
    host,
    port,
    provider,
    profiles,
    staticPools,
    ...(kubernetes !== undefined ? { kubernetes } : {}),
    executorCommandPolicy: resolveExecutorCommandPolicy(env, readFile),
    idleTimeoutMs: resolveInt(
      env[PROVISIONER_ENV.idleTimeoutMs],
      PROVISIONER_ENV.idleTimeoutMs,
      PROVISIONER_DEFAULTS.idleTimeoutMs,
    ),
    sessionIdleTimeoutMs: resolveInt(
      env[PROVISIONER_ENV.sessionIdleTimeoutMs],
      PROVISIONER_ENV.sessionIdleTimeoutMs,
      PROVISIONER_DEFAULTS.sessionIdleTimeoutMs,
    ),
    maxLifetimeMs: resolveInt(
      env[PROVISIONER_ENV.maxLifetimeMs],
      PROVISIONER_ENV.maxLifetimeMs,
      PROVISIONER_DEFAULTS.maxLifetimeMs,
    ),
    drainGraceMs: resolveInt(
      env[PROVISIONER_ENV.drainGraceMs],
      PROVISIONER_ENV.drainGraceMs,
      PROVISIONER_DEFAULTS.drainGraceMs,
    ),
    maxPools: resolveInt(
      env[PROVISIONER_ENV.maxPools],
      PROVISIONER_ENV.maxPools,
      PROVISIONER_DEFAULTS.maxPools,
    ),
    reaperIntervalMs: resolveInt(
      env[PROVISIONER_ENV.reaperIntervalMs],
      PROVISIONER_ENV.reaperIntervalMs,
      PROVISIONER_DEFAULTS.reaperIntervalMs,
    ),
  };
}

/**
 * Убрать токен из `process.env` после чтения конфигурации.
 *
 * Provisioner не запускает дочерних процессов пользователя, но токен в
 * окружении не нужен никому: значение остаётся только в памяти процесса
 * (`ProvisionerConfig.token`).
 */
export function scrubProvisionerToken(env: NodeJS.ProcessEnv = process.env): void {
  delete env[PROVISIONER_ENV.token];
}
