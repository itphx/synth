/**
 * Kubernetes-провайдер пулов (PROP-135, Ф4b-2b): под на проект/сессию.
 *
 * Один пул = один **под** исполнителя + один **секрет** с его токеном. Никакой
 * отдельной таблицы состояния: источник истины — labels/annotations объектов
 * (`synth.io/pool-hash`, `synth.io/pool-key`), поэтому после рестарта
 * provisioner'а пул **усыновляется** (`adopt`), а не создаётся заново.
 *
 * ```text
 * ensure(key)
 *   ├─ list pods по label synth.io/pool-hash=<sha256(key)[0..16]>
 *   │    ├─ под Running/Ready + секрет → вернуть http://<podIP>:<port> + токен
 *   │    ├─ под есть → ждать Running/Ready (adopt) → вернуть
 *   │    └─ под без секрета → удалить (осиротевшая пара) и создать заново
 *   ├─ create Secret synth-pool-<hash> (data.token, base64)
 *   ├─ create Pod synth-pool-<hash>
 *   └─ ждать Running/Ready до startTimeoutMs; таймаут → удалить под+секрет
 * ```
 *
 * ## Workspace
 *
 * Рабочие каталоги проектов лежат на одном PVC: под монтирует том
 * (`WORKSPACE_PVC` → `WORKSPACE_MOUNT`) и, если запрос передал
 * `workspaceSubPath`, монтирует **подкаталог** (`subPath`) — так проект и его
 * worktrees (`proj-slug/.worktrees/x`) видны пулу как обычные каталоги
 * (ADR-114). `subPath` валидируется: абсолютный путь, `..`, `.` и пустые
 * сегменты — `invalid_request` (`400`), иначе пул смонтировал бы чужой каталог.
 *
 * ## Безопасность
 *
 * Под и контейнер запускаются с жёстким `securityContext` (non-root uid 1000,
 * `fsGroup` 1000 — отключается конфигурацией для NFS-томов, — `seccompProfile:
 * RuntimeDefault`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`,
 * read-only корневая ФС по умолчанию). Токен пула живёт только в секрете и в
 * `secretKeyRef` — provisioner его не логирует и не отдаёт в диагностике
 * (`GET /v1/pools`).
 */

import { createHash } from 'node:crypto';
import type {
  ProvisionerExecutorCommandPolicyConfig,
  ProvisionerKubernetesConfig,
  ProvisionerProfile,
  ProvisionerProfiles,
} from './config.js';
import { PoolProvisionerError } from './errors.js';
import type { KubernetesClient, KubernetesManifest, KubernetesPod, KubernetesSecret } from './kubernetes.js';
import type { ProviderErrorMetricReason, ProvisionerMetrics } from './metrics.js';
import {
  isValidWorkspaceSubPath,
  WARM_IMAGE_TIMEOUT_MS,
  type EnsurePoolRequest,
  type EnsurePoolResponse,
  type ProfileResources,
  type ProvisionerProfileInfo,
  type WarmImageResult,
} from './protocol.js';
import type { PoolProvisioner } from './provider.js';
import { generatePoolToken } from './token.js';

/** Имя провайдера в диагностике и метриках. */
export const KUBERNETES_PROVIDER_NAME = 'kubernetes';

/** Label с хешем ключа пула (короткий, стабильный, без спецсимволов). */
export const POOL_HASH_LABEL = 'synth.io/pool-hash';
/** Label с именем профиля пула (санитизированное значение). */
export const POOL_PROFILE_LABEL = 'synth.io/profile';
/** Label с сетевым классом профиля (`none`/`restricted`/`full`). */
export const POOL_NETWORK_LABEL = 'synth.io/network';
/** Annotation с полным ключом пула (label не вмещает произвольную строку). */
export const POOL_KEY_ANNOTATION = 'synth.io/pool-key';

/** Annotation с отпечатком конфигурации чекера команд (смена → пересоздание пода). */
export const COMMAND_POLICY_ANNOTATION = 'synth.io/command-policy';

/**
 * Annotation с отпечатком состава MCP-серверов профиля (PROP-135 слайз 5b-1).
 *
 * Env пода неизменяем: под, созданный с прежним составом MCP-серверов, не
 * получит новый `SYNTH_EXECUTOR_MCP_SERVERS` без пересоздания — поэтому
 * состав входит в отпечаток (как политика команд).
 */
export const MCP_SERVERS_ANNOTATION = 'synth.io/mcp-servers';

/** Метка компонента прогрева образов. */
export const IMAGE_WARMER_COMPONENT_LABEL = 'synth.io/component';
/** Значение метки компонента прогрева образов. */
export const IMAGE_WARMER_COMPONENT = 'image-warmer';
/** Метка с хешем образа прогрева (уникальна на образ → селектор DaemonSet'а). */
export const IMAGE_WARMER_IMAGE_LABEL = 'synth.io/warm-image-hash';
/** Annotation с хешем образа (смена образа → пересоздание DaemonSet'а). */
export const IMAGE_WARMER_IMAGE_ANNOTATION = 'synth.io/warm-image-hash';
/** Annotation со ссылкой на образ (диагностика: `kubectl describe`). */
export const IMAGE_WARMER_IMAGE_REF_ANNOTATION = 'synth.io/warm-image';

/** Ключ токена чекера в Secret пула (`data.<key>`). */
export const COMMAND_POLICY_TOKEN_KEY = 'command-policy-token';
/** Каталог, куда монтируется файл токена чекера в поде. */
export const COMMAND_POLICY_MOUNT_PATH = '/etc/synth/command-policy';
/** Имя файла токена чекера внутри каталога монтирования. */
export const COMMAND_POLICY_TOKEN_FILE = 'token';
/** Режим файла токена (как у прочих Secret-томов: чтение владельцем/группой). */
const COMMAND_POLICY_FILE_MODE = 0o440;

/** Метка «что это за под» (как у чарта исполнителя). */
const APP_NAME_LABEL = 'app.kubernetes.io/name';
const APP_MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';

/** Порт контейнера по умолчанию (`SYNTH_PROVISIONER_KUBERNETES_EXECUTOR_PORT`). */
const DEFAULT_EXECUTOR_PORT = 5100;

/** Пользователь контейнера пула (не root, совпадает с образом исполнителя). */
const CONTAINER_UID = 1000;
/** Группа контейнера пула. */
const CONTAINER_GID = 1000;

/**
 * HOME исполнителя в образе (`ENV HOME=/home/synth`).
 *
 * При read-only корневой ФС монтируется `emptyDir`: кэши corepack/pnpm и
 * `PYTHONUSERBASE` пишутся именно сюда, иначе инструменты падали бы на
 * записи в `/home/synth`.
 */
const HOME_MOUNT = '/home/synth';

/**
 * Длина хеша ключа в имени объекта.
 *
 * 16 hex-символов: имени `synth-pool-<hash>` (27 символов) достаточно с запасом
 * до DNS-лимита 63, а коллизия на 50 живых пулах практически исключена.
 */
const POOL_HASH_LENGTH = 16;

/** Хеш ключа пула (стабильный идентификатор объектов в кластере). */
export function poolHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, POOL_HASH_LENGTH);
}

/**
 * Имя пода/секрета пула.
 */
export function poolObjectName(hash: string): string {
  return `synth-pool-${hash}`;
}

/**
 * Хеш ссылки на образ (для имени/меток DaemonSet'а прогрева).
 *
 * Тот же алгоритм, что у ключа пула: 16 hex-символов достаточно (имя
 * `synth-warm-<hash>` — 27 символов, до DNS-лимита 63).
 */
export function imageHash(image: string): string {
  return createHash('sha256').update(image).digest('hex').slice(0, POOL_HASH_LENGTH);
}

/** Имя DaemonSet'а прогрева образа. */
export function imageWarmerName(hash: string): string {
  return `synth-warm-${hash}`;
}

/**
 * Привести значение к допустимому значению label Kubernetes.
 *
 * Label values: `[A-Za-z0-9]` в начале и конце, внутри — `[-_.A-Za-z0-9]`,
 * не длиннее 63 символов. Имя профиля приходит из конфигурации оператора, но
 * поду с невалидным label API ответил бы `422` — санитизируем.
 */
export function sanitizeLabelValue(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '')
    .slice(0, 63);
  return cleaned === '' ? 'unknown' : cleaned;
}

/** Список ресурсов (requests/limits) без пустых полей. */
function toResourceList(
  list: NonNullable<ProfileResources['requests']> | undefined,
): NonNullable<ProfileResources['requests']> | undefined {
  if (list === undefined) return undefined;
  // Список ресурсов **произвольный** (`nvidia.com/gpu` и пр.) — копируются все
  // ключи, а не только cpu/memory/ephemeralStorage.
  const out: NonNullable<ProfileResources['requests']> = {};
  for (const [name, value] of Object.entries(list)) {
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Ресурсы профиля без пустых блоков (`undefined` — нечего показывать). */
function toProfileResources(
  resources: ProvisionerProfile['resources'],
): ProfileResources | undefined {
  if (resources === undefined) return undefined;
  const requests = toResourceList(resources.requests);
  const limits = toResourceList(resources.limits);
  if (requests === undefined && limits === undefined) return undefined;
  return {
    ...(requests !== undefined ? { requests } : {}),
    ...(limits !== undefined ? { limits } : {}),
  };
}

/**
 * Метаданные профиля из конфигурации (без секретов и запускающей конфигурации).
 *
 * MCP-серверы отдаются **только именами**: command/args/env — конфигурация
 * запуска (в env могут быть токены хостингов, инвариант 13).
 */
function profileInfoFromConfig(
  name: string,
  profile: ProvisionerProfile,
): ProvisionerProfileInfo {
  const resources = toProfileResources(profile.resources);
  const mcpServers = (profile.mcpServers ?? []).map((server) => server.name);
  return {
    name,
    ...(profile.description !== undefined ? { description: profile.description } : {}),
    ...(profile.image !== undefined ? { image: profile.image } : {}),
    ...(profile.network !== undefined ? { network: profile.network } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(profile.runtimeClass !== undefined ? { runtimeClass: profile.runtimeClass } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
  };
}

/** Готов ли под принимать трафик: Running, есть IP, Ready и не удаляется. */
export function isPodReady(pod: KubernetesPod): boolean {
  const status = pod.status;
  if (status === undefined) return false;
  // Terminating-под ещё может отдавать Ready, но это ресурс «на выход».
  if (pod.metadata?.deletionTimestamp !== undefined) return false;
  if (status.phase !== 'Running') return false;
  if ((status.podIP ?? '').trim() === '') return false;
  const conditions = status.conditions;
  if (Array.isArray(conditions)) {
    const ready = conditions.find((condition) => condition.type === 'Ready');
    if (ready !== undefined && ready.status !== 'True') return false;
  }
  const containers = status.containerStatuses;
  if (Array.isArray(containers)) {
    if (containers.length === 0) return false;
    if (!containers.every((container) => container.ready === true)) return false;
  }
  return true;
}

/** Токен из секрета (`data.token`, base64) либо `null`. */
function secretToken(secret: KubernetesSecret | null): string | null {
  const raw = secret?.data?.token;
  if (typeof raw !== 'string' || raw === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8').trim();
  } catch {
    return null;
  }
  return decoded === '' ? null : decoded;
}

/** Переменная окружения контейнера. */
interface ContainerEnv {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef: { name: string; key: string };
  };
}

/** Параметры сборки Pod-манифеста пула. */
export interface PoolPodManifestOptions {
  /** Ключ пула (полный — в annotation). */
  key: string;
  /** Хеш ключа (имя объекта, label). */
  hash: string;
  /** Имя профиля. */
  profileName: string;
  /** Описание профиля. */
  profile: ProvisionerProfile;
  /** Эффективная конфигурация Kubernetes-провайдера. */
  kubernetes: ProvisionerKubernetesConfig;
  /** Имя секрета с токеном пула. */
  secretName: string;
  /** Относительный путь внутри PVC (уже провалидирован). */
  workspaceSubPath?: string;
  /** Внешний чекер команд пула (выключен/не задан → прежний pod spec). */
  commandPolicy?: ProvisionerExecutorCommandPolicyConfig;
}

/**
 * Отпечаток конфигурации чекера команд для пода.
 *
 * Нужен на adopt: под, созданный с прежней конфигурацией, не получит новых
 * env/файла без пересоздания (env пода неизменяем). `off` — чекер выключен:
 * поды, созданные до появления аннотации, совместимы.
 */
export function commandPolicyFingerprint(
  policy: ProvisionerExecutorCommandPolicyConfig | undefined,
): string {
  if (policy?.enabled !== true) return 'off';
  const tokenDigest =
    policy.token === undefined ? '' : createHash('sha256').update(policy.token).digest('hex');
  const material = JSON.stringify({
    provider: policy.provider,
    url: policy.url ?? '',
    failMode: policy.failMode,
    timeoutMs: policy.timeoutMs,
    cacheTtlMs: policy.cacheTtlMs,
    opaPath: policy.opaPath,
    tokenDigest,
  });
  return `v1:${createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
}

/**
 * Отпечаток состава MCP-серверов профиля (PROP-135 слайз 5b-1).
 *
 * `off` — серверов нет: переменная `SYNTH_EXECUTOR_MCP_SERVERS` в поде не
 * выставляется (дефолт образа), и поды, созданные до появления аннотации,
 * совместимы. Непустой состав — хеш: смена состава требует пересоздания
 * пода (env пода неизменяем).
 */
export function mcpServersFingerprint(profile: ProvisionerProfile): string {
  const servers = profile.mcpServers ?? [];
  if (servers.length === 0) return 'off';
  return `v1:${createHash('sha256').update(JSON.stringify(servers)).digest('hex').slice(0, 16)}`;
}

/**
 * Описания MCP-серверов для env `SYNTH_EXECUTOR_MCP_SERVERS` (JSON).
 *
 * Формат — как разбирает исполнитель (ADR-077 шаг B1): `{name, command, args,
 * env}`. Значения `env` — **как есть** (там могут быть токены хостингов):
 * provisioner их не логирует и не показывает в диагностике, но они попадают
 * в spec пода (см. README чарта).
 */
export function buildMcpServersEnvValue(profile: ProvisionerProfile): string {
  const servers = profile.mcpServers ?? [];
  return JSON.stringify(
    servers.map((server) => ({
      name: server.name,
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
    })),
  );
}

/** Ресурсы контейнера без `undefined`-полей. */
function buildResources(profile: ProvisionerProfile): Record<string, unknown> | undefined {
  const resources = profile.resources;
  if (resources === undefined) return undefined;
  const block: Record<string, unknown> = {};
  const compact = (list: Record<string, string | undefined> | undefined): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(list ?? {})) {
      if (value !== undefined) result[name] = value;
    }
    return result;
  };
  if (resources.requests !== undefined) {
    const requests = compact(resources.requests);
    if (Object.keys(requests).length > 0) block.requests = requests;
  }
  if (resources.limits !== undefined) {
    const limits = compact(resources.limits);
    if (Object.keys(limits).length > 0) block.limits = limits;
  }
  return Object.keys(block).length > 0 ? block : undefined;
}

/**
 * Собрать Pod-манифест пула.
 *
 * Чистая функция: тесты проверяют спецификацию пода без Kubernetes-кластера.
 *
 * @param opts ключ/хеш/профиль/конфигурация и имя секрета
 * @returns манифест `v1/Pod`
 */
export function buildPoolPodManifest(opts: PoolPodManifestOptions): KubernetesManifest {
  const { kubernetes, profile, profileName } = opts;
  const port = kubernetes.executorPort > 0 ? kubernetes.executorPort : DEFAULT_EXECUTOR_PORT;
  const readOnlyRootFilesystem = profile.readOnlyRootFilesystem ?? true;
  const network = profile.network ?? 'full';
  // `null` — fsGroup в pod spec не выставляется (NFS, см. конфигурацию).
  const fsGroup = kubernetes.fsGroup === undefined ? CONTAINER_GID : kubernetes.fsGroup;

  // Mount path: подкаталог проекта монтируется **по тому же абсолютному
  // пути**, что видит control plane (`/var/synth/data/workspaces/<subPath>`),
  // иначе пути тулов (`…/workspaces/<project>`) в поде не существуют.
  const workspaceMountPath = opts.workspaceSubPath !== undefined
    ? `${kubernetes.workspaceMount.replace(/\/+$/, '')}/${opts.workspaceSubPath}`
    : kubernetes.workspaceMount;

  const env: ContainerEnv[] = [
    {
      name: 'SYNTH_EXECUTOR_TOKEN',
      valueFrom: { secretKeyRef: { name: opts.secretName, key: 'token' } },
    },
    { name: 'SYNTH_EXECUTOR_HOST', value: '0.0.0.0' },
    { name: 'SYNTH_EXECUTOR_PORT', value: String(port) },
    { name: 'SYNTH_EXECUTOR_WORKSPACE', value: workspaceMountPath },
  ];
  const profileEnv = profile.env ?? {};
  for (const name of Object.keys(profileEnv).sort()) {
    env.push({ name, value: profileEnv[name] ?? '' });
  }

  // PROP-135 слайз 5b-1: MCP-серверы профиля → env `SYNTH_EXECUTOR_MCP_SERVERS`
  // (JSON). Пустой список — переменная **не** выставляется: дефолт образа
  // (у flavor'ов с браузером — Playwright MCP) остаётся в силе.
  const mcpServers = profile.mcpServers ?? [];
  if (mcpServers.length > 0) {
    env.push({ name: 'SYNTH_EXECUTOR_MCP_SERVERS', value: buildMcpServersEnvValue(profile) });
  }

  // Внешний чекер команд (PROP-136b-2b): env — только при включённой политике;
  // токен — файлом из Secret пула (у исполнителя значение токена в env не
  // поддерживается, а Secret уже создаётся для токена пула).
  const policy = opts.commandPolicy;
  const policyEnabled = policy?.enabled === true;
  const policyToken = policyEnabled && policy.token !== undefined ? policy.token : undefined;
  if (policyEnabled) {
    env.push(
      { name: 'SYNTH_EXECUTOR_COMMAND_POLICY_PROVIDER', value: policy.provider },
      { name: 'SYNTH_EXECUTOR_COMMAND_POLICY_URL', value: policy.url ?? '' },
      { name: 'SYNTH_EXECUTOR_COMMAND_POLICY_FAIL_MODE', value: policy.failMode },
      { name: 'SYNTH_EXECUTOR_COMMAND_POLICY_TIMEOUT_MS', value: String(policy.timeoutMs) },
      { name: 'SYNTH_EXECUTOR_COMMAND_POLICY_CACHE_TTL_MS', value: String(policy.cacheTtlMs) },
      { name: 'SYNTH_EXECUTOR_COMMAND_POLICY_OPA_PATH', value: policy.opaPath },
    );
    if (policyToken !== undefined) {
      env.push({
        name: 'SYNTH_EXECUTOR_COMMAND_POLICY_TOKEN_FILE',
        value: `${COMMAND_POLICY_MOUNT_PATH}/${COMMAND_POLICY_TOKEN_FILE}`,
      });
    }
  }

  const volumeMounts: Array<Record<string, unknown>> = [
    {
      name: 'workspace',
      mountPath: workspaceMountPath,
      // `subPath` монтирует подкаталог тома: рабочее дерево проекта, не весь PVC.
      ...(opts.workspaceSubPath !== undefined ? { subPath: opts.workspaceSubPath } : {}),
    },
  ];
  const volumes: Array<Record<string, unknown>> = [
    { name: 'workspace', persistentVolumeClaim: { claimName: kubernetes.workspacePvc } },
  ];
  if (policyToken !== undefined) {
    // Файл токена чекера — из того же Secret, что и токен пула. `subPath`
    // монтирует один файл, остальные ключи секрета в под не попадают.
    volumeMounts.push({
      name: 'command-policy',
      mountPath: COMMAND_POLICY_MOUNT_PATH,
      readOnly: true,
    });
    volumes.push({
      name: 'command-policy',
      secret: {
        secretName: opts.secretName,
        defaultMode: COMMAND_POLICY_FILE_MODE,
        items: [{ key: COMMAND_POLICY_TOKEN_KEY, path: COMMAND_POLICY_TOKEN_FILE }],
      },
    });
  }
  if (readOnlyRootFilesystem) {
    // Корневая ФС только для чтения: исполнителю нужны записываемые /tmp
    // (журналы фоновых процессов) и HOME (`/home/synth` — кэши corepack/pnpm,
    // `PYTHONUSERBASE`). Оба — `emptyDir`: данные пула живут в PVC workspace,
    // а кэши пакетных менеджеров переживать под не обязаны.
    volumeMounts.push({ name: 'tmp', mountPath: '/tmp' });
    volumes.push({ name: 'tmp', emptyDir: {} });
    volumeMounts.push({ name: 'home', mountPath: HOME_MOUNT });
    volumes.push({ name: 'home', emptyDir: {} });
  }

  const resources = buildResources(profile);

  // Placement профиля: аннотации/метки пользователя **не перетирают**
  // служебные (`synth.io/*`, `app.kubernetes.io/*`) — служебные приоритетнее
  // (иначе под перестал бы усыновляться по label'у хеша ключа).
  const userLabels = profile.labels ?? {};
  const userAnnotations = profile.annotations ?? {};

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: poolObjectName(opts.hash),
      namespace: kubernetes.namespace,
      labels: {
        ...userLabels,
        [APP_NAME_LABEL]: 'synth-executor',
        [APP_MANAGED_BY_LABEL]: 'synth-provisioner',
        [POOL_HASH_LABEL]: opts.hash,
        [POOL_PROFILE_LABEL]: sanitizeLabelValue(profileName),
        [POOL_NETWORK_LABEL]: network,
      },
      annotations: {
        ...userAnnotations,
        [POOL_KEY_ANNOTATION]: opts.key,
        [COMMAND_POLICY_ANNOTATION]: commandPolicyFingerprint(policy),
        [MCP_SERVERS_ANNOTATION]: mcpServersFingerprint(profile),
      },
    },
    spec: {
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: kubernetes.terminationGraceSeconds,
      ...(kubernetes.serviceAccount !== undefined
        ? { serviceAccountName: kubernetes.serviceAccount }
        : {}),
      ...(kubernetes.imagePullSecrets.length > 0
        ? { imagePullSecrets: kubernetes.imagePullSecrets.map((name) => ({ name })) }
        : {}),
      ...(profile.runtimeClass !== undefined ? { runtimeClassName: profile.runtimeClass } : {}),
      // Отбор нод и toleration'ы профиля (размещение пода в кластере).
      ...(profile.nodeSelector !== undefined && Object.keys(profile.nodeSelector).length > 0
        ? { nodeSelector: { ...profile.nodeSelector } }
        : {}),
      ...(profile.tolerations !== undefined && profile.tolerations.length > 0
        ? { tolerations: profile.tolerations.map((toleration) => ({ ...toleration })) }
        : {}),
      ...(profile.affinity !== undefined && Object.keys(profile.affinity).length > 0
        ? { affinity: { ...profile.affinity } }
        : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: CONTAINER_UID,
        runAsGroup: CONTAINER_GID,
        // `fsGroup: null` (env `..._FS_GROUP=none`) — не выставлять: на NFS
        // kubelet иначе рекурсивно меняет владельца тома при старте пода
        // (VolumePermissionChangeInProgress). Изоляция не слабеет —
        // `runAsUser`/`runAsGroup` 1000 и `readOnlyRootFilesystem` остаются.
        ...(fsGroup !== null ? { fsGroup } : {}),
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'executor',
          // `image` уже проверен при разборе конфигурации; пустая строка здесь
          // недостижима (fail-closed) и лишь сохраняет тип манифеста строкой.
          image: profile.image ?? '',
          imagePullPolicy: 'IfNotPresent',
          ports: [{ name: 'http', containerPort: port, protocol: 'TCP' }],
          env,
          volumeMounts,
          ...(resources !== undefined ? { resources } : {}),
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem,
            capabilities: { drop: ['ALL'] },
          },
        },
      ],
      volumes,
    },
  };
}

/**
 * Собрать манифест DaemonSet'а прогрева образа.
 *
 * Чистая функция (тесты проверяют манифест без кластера): DaemonSet поднимает
 * по поду на каждой ноде, образ тянется (`imagePullPolicy: Always`), контейнер
 * спит минуту — этого хватает, чтобы образ оказался в реестре ноды. Дальше
 * DaemonSet удаляется (проба кончилась), образ остаётся в кэше ноды.
 *
 * @param image ссылка на образ
 * @param hash хеш ссылки (имя объекта и метки)
 * @param kubernetes конфигурация Kubernetes-провайдера (namespace, pull-secrets)
 */
export function buildImageWarmerManifest(
  image: string,
  hash: string,
  kubernetes: ProvisionerKubernetesConfig,
): KubernetesManifest {
  const selectorLabels = {
    [IMAGE_WARMER_COMPONENT_LABEL]: IMAGE_WARMER_COMPONENT,
    [IMAGE_WARMER_IMAGE_LABEL]: hash,
  };
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: imageWarmerName(hash),
      namespace: kubernetes.namespace,
      labels: {
        [APP_NAME_LABEL]: 'synth-image-warmer',
        [APP_MANAGED_BY_LABEL]: 'synth-provisioner',
        ...selectorLabels,
      },
      annotations: {
        [IMAGE_WARMER_IMAGE_ANNOTATION]: hash,
        [IMAGE_WARMER_IMAGE_REF_ANNOTATION]: image,
      },
    },
    spec: {
      // Селектор DaemonSet'а неизменяем — он задаётся по хешу образа, чтобы
      // два прогова разных образов не пересекались.
      selector: { matchLabels: { ...selectorLabels } },
      template: {
        metadata: { labels: { ...selectorLabels } },
        spec: {
          restartPolicy: 'Always',
          terminationGracePeriodSeconds: 0,
          ...(kubernetes.serviceAccount !== undefined
            ? { serviceAccountName: kubernetes.serviceAccount }
            : {}),
          ...(kubernetes.imagePullSecrets.length > 0
            ? { imagePullSecrets: kubernetes.imagePullSecrets.map((name) => ({ name })) }
            : {}),
          containers: [
            {
              name: 'warmer',
              image,
              // `Always` — прогрев именно этого образа (тег `latest` мог бы
              // указать на новую версию, а нужен тот, что запрошен).
              imagePullPolicy: 'Always',
              command: ['sh', '-c', 'sleep 60'],
              resources: {},
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
            },
          ],
        },
      },
    },
  };
}

/** Параметры Kubernetes-провайдера. */
export interface KubernetesPoolProvisionerOptions {
  /** Клиент API (в тестах — in-memory реализация). */
  client: KubernetesClient;
  /** Эффективная конфигурация (namespace, PVC, таймауты, порт). */
  kubernetes: ProvisionerKubernetesConfig;
  /** Каталог профилей (`image` обязателен). */
  profiles: ProvisionerProfiles;
  /** Внешний чекер команд пулов (выключен/не задан → прежний pod spec). */
  commandPolicy?: ProvisionerExecutorCommandPolicyConfig;
  /** Метрики (необязательны). */
  metrics?: ProvisionerMetrics;
  /** Инъектируемые часы (тесты не ждут реальные 120 с). */
  now?: () => number;
  /** Инъектируемая пауза между опросами. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Провайдер пулов `kubernetes`: под + секрет на ключ пула.
 *
 * `ensure` идемпотентен **на уровне кластера**: под ищется по label с хешем
 * ключа, поэтому повторный вызов (и рестарт provisioner'а) усыновляет уже
 * существующий ресурс, а не создаёт второй.
 *
 * Профиль пула — **спецификация из тела запроса** (`profileSpec`, её шлёт
 * control plane), если она есть; иначе — профиль каталога provisioner'а
 * (`SYNTH_PROVISIONER_PROFILES`). Спецификация важнее каталога: админ задаёт
 * профили в UI инстанса, не правя Helm values. `url` в спецификации
 * игнорируется (адрес пула — это адрес пода), `image` обязателен.
 */
export class KubernetesPoolProvisioner implements PoolProvisioner {
  private readonly _client: KubernetesClient;
  private readonly _config: ProvisionerKubernetesConfig;
  private readonly _profiles: ProvisionerProfiles;
  private readonly _commandPolicy: ProvisionerExecutorCommandPolicyConfig | undefined;
  private readonly _metrics: ProvisionerMetrics | undefined;
  private readonly _now: () => number;
  private readonly _sleep: (ms: number) => Promise<void>;

  constructor(opts: KubernetesPoolProvisionerOptions) {
    this._client = opts.client;
    this._config = opts.kubernetes;
    this._profiles = opts.profiles;
    this._commandPolicy = opts.commandPolicy;
    this._metrics = opts.metrics;
    this._now = opts.now ?? Date.now;
    this._sleep =
      opts.sleep ??
      ((ms) => new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  }

  /** Обеспечить пул: создать (или усыновить) под и вернуть адрес с токеном. */
  async ensure(req: EnsurePoolRequest): Promise<EnsurePoolResponse> {
    const startedAt = this._now();
    try {
      return await this._ensure(req);
    } finally {
      this._metrics?.ensureObserved(
        KUBERNETES_PROVIDER_NAME,
        Math.max(0, this._now() - startedAt) / 1000,
      );
    }
  }

  /** Слить пул: удалить под с grace-периодом, секрет оставить (для adopt). */
  async drain(key: string): Promise<void> {
    const name = poolObjectName(poolHash(key));
    await this._call('delete', () =>
      this._client.deletePod(name, this._config.terminationGraceSeconds),
    );
  }

  /** Удалить пул: под (grace 0) и секрет; 404 — no-op, повтор идемпотентен. */
  async release(key: string): Promise<void> {
    const hash = poolHash(key);
    const name = poolObjectName(hash);
    await this._call('delete', () => this._client.deletePod(name, 0));
    await this._call('delete', () => this._client.deleteSecret(name));
  }

  /** Диагностика: провайдер и профили. */
  async capabilities(): Promise<{ provider: string; profiles: string[] }> {
    return { provider: KUBERNETES_PROVIDER_NAME, profiles: Object.keys(this._profiles) };
  }

  /**
   * Метаданные профилей: образ/сеть/ресурсы/runtimeClass и **имена**
   * MCP-серверов. Env профиля и содержимое MCP-серверов (command/args/env) не
   * отдаются — это не метаданные, а конфигурация запуска (инвариант 13).
   */
  async profilesInfo(): Promise<ProvisionerProfileInfo[]> {
    return Object.entries(this._profiles).map(([name, profile]) =>
      profileInfoFromConfig(name, profile),
    );
  }

  /**
   * Прогреть образы на нодах кластера.
   *
   * Для каждого образа: создать DaemonSet (под на каждой ноде тянет образ),
   * дождаться `numberReady >= desiredNumberScheduled` (до `WARM_IMAGE_TIMEOUT_MS`),
   * удалить DaemonSet. Ошибка одного образа **не** прерывает прогон остальных —
   * итог по каждому образу отдельной записью.
   */
  async warmImages(images: string[]): Promise<WarmImageResult[]> {
    const results: WarmImageResult[] = [];
    for (const image of images) {
      results.push(await this._warmImage(image));
    }
    return results;
  }

  /** Прогрев одного образа (DaemonSet → ожидание → удаление). */
  private async _warmImage(image: string): Promise<WarmImageResult> {
    const hash = imageHash(image);
    const name = imageWarmerName(hash);
    try {
      const created = await this._call('create', () =>
        this._client.createDaemonSet(buildImageWarmerManifest(image, hash, this._config)),
      );
      if (!created) {
        // DaemonSet уже есть (тот же образ прогревали) — дожидаемся его
        // готовности: образ всё равно нужно дотянуть до всех нод.
      }
      const readiness = await this._waitForDaemonSet(name);
      if (!readiness.ok) {
        return {
          image,
          ok: false,
          nodes: readiness.nodes,
          ...(readiness.error !== undefined ? { error: readiness.error } : {}),
        };
      }
      return { image, ok: true, nodes: readiness.nodes };
    } catch (err) {
      return {
        image,
        ok: false,
        nodes: 0,
        error: err instanceof Error ? err.message : 'не удалось прогреть образ',
      };
    } finally {
      await this._deleteDaemonSetQuietly(name);
    }
  }

  /**
   * Дождаться готовности DaemonSet'а прогрева.
   *
   * Готов = `numberReady >= desiredNumberScheduled` (все ноды вытянули образ).
   * `desiredNumberScheduled === 0` — на кластере нет нод под DaemonSet: ждать
   * бессмысленно, сразу отказ.
   */
  private async _waitForDaemonSet(name: string): Promise<{
    ok: boolean;
    nodes: number;
    error?: string;
  }> {
    const deadline = this._now() + WARM_IMAGE_TIMEOUT_MS;
    for (;;) {
      const daemonSet = await this._call('lookup', () => this._client.getDaemonSet(name));
      if (daemonSet === null) {
        return { ok: false, nodes: 0, error: 'DaemonSet прогрева исчез до готовности' };
      }
      const status = daemonSet.status;
      const desired = status?.desiredNumberScheduled ?? 0;
      const ready = status?.numberReady ?? 0;
      if (desired === 0) {
        return {
          ok: false,
          nodes: 0,
          error: 'на кластере нет нод, подходящих под DaemonSet прогрева',
        };
      }
      if (ready >= desired) return { ok: true, nodes: ready };
      const remaining = deadline - this._now();
      if (remaining <= 0) {
        return {
          ok: false,
          nodes: ready,
          error: `образ не прогрет за ${WARM_IMAGE_TIMEOUT_MS} мс (готовых нод ${ready} из ${desired})`,
        };
      }
      await this._sleep(Math.min(this._config.pollIntervalMs, remaining));
    }
  }

  /** Удалить DaemonSet прогрева (чистка best-effort). */
  private async _deleteDaemonSetQuietly(name: string): Promise<void> {
    try {
      await this._client.deleteDaemonSet(name);
    } catch {
      // Чистка best-effort: основной исход (ошибка/успех) важнее.
    }
  }

  /** Внутренняя часть `ensure` (таймер метрики — снаружи). */
  private async _ensure(req: EnsurePoolRequest): Promise<EnsurePoolResponse> {
    const subPath = req.workspaceSubPath;
    if (subPath !== undefined && !isValidWorkspaceSubPath(subPath)) {
      throw new PoolProvisionerError(
        'invalid_request',
        `некорректный workspaceSubPath "${subPath}": ожидается относительный путь внутри PVC ` +
          'без «..», «.» и пустых сегментов',
      );
    }

    // Профиль пула: **спецификация из тела запроса** (backend присылает
    // эффективный профиль инстанса) важнее каталога provisioner'а — так админ
    // задаёт профили в UI, не правя Helm values. Каталог — запасной вариант
    // (provisioner без `profileSpec` работает как раньше).
    const spec = req.profileSpec;
    const profile = spec ?? this._profiles[req.profile];
    if (profile === undefined) {
      throw new PoolProvisionerError(
        'pool_not_found',
        `пул "${req.key}" не найден: профиль "${req.profile}" не описан ` +
          '(SYNTH_PROVISIONER_PROFILES / profileSpec в теле запроса)',
      );
    }
    const image = profile.image?.trim() ?? '';
    if (image === '') {
      if (spec !== undefined) {
        // Спецификация без образа — некорректный запрос (fail-closed): под не
        // из чего поднять. Каталог без образа — «профиль не описан» (404).
        throw new PoolProvisionerError(
          'invalid_request',
          `profileSpec пула "${req.key}" без image — образ обязателен (kubernetes)`,
        );
      }
      throw new PoolProvisionerError(
        'pool_not_found',
        `пул "${req.key}" не найден: профиль "${req.profile}" не описан или без image ` +
          '(SYNTH_PROVISIONER_PROFILES)',
      );
    }

    const hash = poolHash(req.key);
    const podName = poolObjectName(hash);
    const secretName = podName;

    // Adopt: под мог остаться от предыдущего процесса provisioner'а (или от
    // другой реплики) — источник истины о пуле это label, а не память.
    const existingPod = await this._call('lookup', () =>
      this._client.listPods(`${POOL_HASH_LABEL}=${hash}`),
    );
    const found = existingPod.find((pod) => pod.metadata?.name === podName) ?? existingPod[0];
    if (found?.metadata?.name !== undefined) {
      const foundName = found.metadata.name;
      const expectedProfile = sanitizeLabelValue(req.profile);
      const foundProfile = found.metadata.labels?.[POOL_PROFILE_LABEL];
      const expectedPolicy = commandPolicyFingerprint(this._commandPolicy);
      const foundPolicy = found.metadata.annotations?.[COMMAND_POLICY_ANNOTATION];
      // `off` совместим и с подом без аннотации (resource создан до появления
      // настройки): включение чекера меняет env пода, поэтому требует
      // пересоздания только при непустой политике.
      const policyCompatible =
        expectedPolicy === 'off'
          ? foundPolicy === undefined || foundPolicy === 'off'
          : foundPolicy === expectedPolicy;
      // PROP-135 слайз 5b-1: состав MCP-серверов — тоже env пода, поэтому
      // смена состава требует пересоздания (иначе под остался бы со старым
      // `SYNTH_EXECUTOR_MCP_SERVERS`).
      const expectedMcp = mcpServersFingerprint(profile);
      const foundMcp = found.metadata.annotations?.[MCP_SERVERS_ANNOTATION];
      const mcpCompatible =
        expectedMcp === 'off'
          ? foundMcp === undefined || foundMcp === 'off'
          : foundMcp === expectedMcp;
      if (
        !policyCompatible ||
        !mcpCompatible ||
        (foundProfile !== undefined && foundProfile !== expectedProfile)
      ) {
        // Под этого ключа поднят с другим профилем/политикой/MCP-составом
        // (переименование профиля, смена чекера, смена MCP-серверов или
        // коллизия хеша): ресурс не тот — снимаем пару и создаём заново.
        await this._deletePodQuietly(foundName, 0);
        await this._deleteSecretQuietly(secretName);
        await this._waitForPodGone(foundName);
      } else if (found.metadata.deletionTimestamp !== undefined) {
        // Под уже удаляется (например, после drain): ждём исчезновения, иначе
        // создание получило бы 409, а ожидание — «мёртвый» под.
        await this._waitForPodGone(foundName);
      } else {
        const secret = await this._call('lookup', () => this._client.getSecret(secretName));
        const token = secretToken(secret);
        // Токен чекера лежит в том же секрете: без ключа том пода не смонтируется.
        const policyTokenMissing =
          this._policyToken !== undefined && (secret?.data?.[COMMAND_POLICY_TOKEN_KEY] ?? '') === '';
        if (token !== null && !policyTokenMissing) {
          const pod = await this._waitForPod(foundName);
          if (pod !== null) return { url: this._executorUrl(pod), token };
          // Под не поднялся за отведённое время — снимаем пару, чтобы следующая
          // попытка не ждала те же «зависшие» объекты.
          await this._deletePodQuietly(foundName);
          await this._deleteSecretQuietly(secretName);
          throw this._error(
            'wait',
            `пул "${podName}" не вышел в Running/Ready за ${this._config.startTimeoutMs} мс ` +
              '(ресурсы удалены)',
          );
        }
        // Под без секрета (или без токена чекера) — осиротевшая пара: под
        // бесполезен. Удаляем немедленно (grace 0) и ждём исчезновения, иначе
        // создание получило бы 409 на том же имени.
        await this._deletePodQuietly(foundName, 0);
        if (policyTokenMissing) await this._deleteSecretQuietly(secretName);
        await this._waitForPodGone(foundName);
      }
    }

    // Токен и секрет: при 409 (секрет уже есть) используем значение из
    // кластера, иначе вернули бы токен, которого нет в секрете.
    let token = generatePoolToken();
    const secretCreated = await this._call('create', () =>
      this._client.createSecret(this._secretManifest(secretName, hash, req.key, token)),
    );
    if (!secretCreated) {
      const existing = await this._call('lookup', () => this._client.getSecret(secretName));
      const existingToken = secretToken(existing);
      if (existingToken === null) {
        throw this._error(
          'create',
          `секрет "${secretName}" уже существует, но не содержит токена — ` +
            'удалите его вручную либо вызовите release пула',
        );
      }
      // Секрет прошлого пула не содержит токена чекера (политику включили
      // позже): update прав у provisioner'а нет — пересоздаём секрет.
      if (
        this._policyToken !== undefined &&
        (existing?.data?.[COMMAND_POLICY_TOKEN_KEY] ?? '') === ''
      ) {
        await this._deleteSecretQuietly(secretName);
        const recreated = await this._call('create', () =>
          this._client.createSecret(this._secretManifest(secretName, hash, req.key, token)),
        );
        if (!recreated) {
          throw this._error(
            'create',
            `секрет "${secretName}" не удалось пересоздать с токеном чекера команд`,
          );
        }
      } else {
        token = existingToken;
      }
    }

    await this._call('create', () =>
      this._client.createPod(
        buildPoolPodManifest({
          key: req.key,
          hash,
          profileName: req.profile,
          profile,
          kubernetes: this._config,
          secretName,
          ...(subPath !== undefined ? { workspaceSubPath: subPath } : {}),
          ...(this._commandPolicy !== undefined
            ? { commandPolicy: this._commandPolicy }
            : {}),
        }),
      ),
    );

    const pod = await this._waitForPod(podName);
    if (pod === null) {
      await this._deletePodQuietly(podName);
      await this._deleteSecretQuietly(secretName);
      throw this._error(
        'wait',
        `пул "${podName}" не вышел в Running/Ready за ${this._config.startTimeoutMs} мс ` +
          '(ресурсы удалены)',
      );
    }
    return { url: this._executorUrl(pod), token };
  }

  /** Токен чекера команд (только при включённой политике). */
  private get _policyToken(): string | undefined {
    return this._commandPolicy?.enabled === true ? this._commandPolicy.token : undefined;
  }

  /** Манифест секрета с токеном пула (`data.token` — base64). */
  private _secretManifest(
    name: string,
    hash: string,
    key: string,
    token: string,
  ): KubernetesManifest {
    const policyToken = this._policyToken;
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name,
        namespace: this._config.namespace,
        labels: {
          [APP_MANAGED_BY_LABEL]: 'synth-provisioner',
          [POOL_HASH_LABEL]: hash,
        },
        annotations: { [POOL_KEY_ANNOTATION]: key },
      },
      data: {
        token: Buffer.from(token, 'utf8').toString('base64'),
        ...(policyToken !== undefined
          ? { [COMMAND_POLICY_TOKEN_KEY]: Buffer.from(policyToken, 'utf8').toString('base64') }
          : {}),
      },
    };
  }

  /** Адрес исполнителя в поде. */
  private _executorUrl(pod: KubernetesPod): string {
    const ip = (pod.status?.podIP ?? '').trim();
    if (ip === '') {
      // `isPodReady` уже проверил IP — сюда попасть можно только при гонке.
      throw this._error('wait', 'под пула не имеет podIP — адрес исполнителя неизвестен');
    }
    const host = ip.includes(':') ? `[${ip}]` : ip;
    return `http://${host}:${this._config.executorPort}`;
  }

  /**
   * Дождаться Running/Ready.
   *
   * @returns под либо `null` — таймаут `startTimeoutMs`
   */
  private async _waitForPod(name: string): Promise<KubernetesPod | null> {
    const deadline = this._now() + this._config.startTimeoutMs;
    for (;;) {
      const pod = await this._call('lookup', () => this._client.getPod(name));
      if (pod !== null && isPodReady(pod)) return pod;
      const remaining = deadline - this._now();
      if (remaining <= 0) return null;
      await this._sleep(Math.min(this._config.pollIntervalMs, remaining));
    }
  }

  /** Удалить под, не мешая основному исходу (чистка best-effort). */
  private async _deletePodQuietly(
    name: string,
    graceSeconds: number = this._config.terminationGraceSeconds,
  ): Promise<void> {
    try {
      await this._client.deletePod(name, graceSeconds);
    } catch {
      // Чистка best-effort: основной исход (ошибка/успех) важнее.
    }
  }

  /**
   * Дождаться исчезновения terminating-пода (bounded `startTimeoutMs`).
   *
   * Если под так и не исчез, дальше `createPod` вернёт «уже существует», а
   * ожидание готовности завершится таймаутом — понятной ошибкой, без цикла.
   */
  private async _waitForPodGone(name: string): Promise<void> {
    const deadline = this._now() + this._config.startTimeoutMs;
    for (;;) {
      const pod = await this._call('lookup', () => this._client.getPod(name));
      if (pod === null) return;
      const remaining = deadline - this._now();
      if (remaining <= 0) return;
      await this._sleep(Math.min(this._config.pollIntervalMs, remaining));
    }
  }

  /** Удалить секрет, не мешая основному исходу. */
  private async _deleteSecretQuietly(name: string): Promise<void> {
    try {
      await this._client.deleteSecret(name);
    } catch {
      // Чистка best-effort.
    }
  }

  /** Вызов клиента с учётом ошибки провайдера в метрике. */
  private async _call<T>(reason: ProviderErrorMetricReason, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this._metrics?.providerError(reason);
      throw err;
    }
  }

  /** Ошибка провайдера с учётом в метрике (текст без секретов). */
  private _error(reason: ProviderErrorMetricReason, message: string): PoolProvisionerError {
    this._metrics?.providerError(reason);
    return new PoolProvisionerError('provider_error', message);
  }
}
