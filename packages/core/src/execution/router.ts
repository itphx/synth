/**
 * Роутер исполнения: порт по профилю (PROP-135, Ф4a) и по пулу (Ф4b-1).
 *
 * ## Зачем
 *
 * До Ф4a порт исполнения был **один на процесс** (`execution/factory.ts`):
 * inline-порт или удалённый порт на общий пул исполнителей. PROP-135 вводит
 * пулы (`instance`|`project`|`session`) и **профили** — именованные наборы
 * параметров исполнения (адреса, таймаут, лимит одновременных вызовов,
 * поведение при недоступности). Профиль выбирается сессией
 * (`session.settings.executorProfile`), поэтому порт должен выбираться **на
 * ход**, а порт создаётся **на старте** (инвариант 24: `execution.*` —
 * параметр запуска, не runtime-настройка).
 *
 * ## Что делает роутер
 *
 * - `pooling: instance` — **единственный** instance-порт на процесс: поведение
 *   как до Ф4a (профили игнорируются);
 * - `pooling: project`|`session` — **порт на профиль**: адреса/таймаут/лимит/
 *   failMode профиля, поверх общих параметров секции; порты создаются на
 *   старте, кэш — по имени профиля, поэтому `portFor` **синхронен**;
 * - профиль без адреса наследует `execution.remote.url`; если и там пусто —
 *   `fallback: instance` → instance-порт, `fallback: fail` → **fail-closed**
 *   (старт прерывается с понятной причиной).
 *
 * ## Провайдер пулов (Ф4b-1)
 *
 * `execution.remote.provider`:
 *
 * - `static` — пулы из конфигурации (адреса профиля): поведение Ф4a, порты
 *   создаются на старте;
 * - `http` — пулы запрашиваются у provisioner'а (`POST /v1/pools`): адрес и
 *   токен пула приходят **в момент обращения**, поэтому порт собирается
 *   **лениво** (`execution/pooled-port.ts`), а `portFor` остаётся
 *   синхронным — он отдаёт «прокси» порта, который разрешается при первом
 *   вызове. Кэш прокси — **по ключу пула** (`poolKeyString`): один порт на
 *   ключ (проект/сессия/профиль).
 *
 * При `provider: http` и `pooling: project`/`session` ключ пула строится по
 * `projectId`/`sessionId` цели. Идентификатора нет (сессия без проекта при
 * `pooling: project`) → `fallback: instance` (instance-порт) либо
 * `fallback: fail` (**fail-closed**).
 *
 * `workspaceSubPath` (PROP-135 Ф4b-2b-2a) — относительный путь рабочего
 * каталога внутри PVC: он уходит в `ensure` (per-project монтирование), но в
 * ключ пула не входит — кэш остаётся «один порт на ключ», поэтому смену
 * subPath у существующего пула порт не подхватывает (пул пересоздаётся на
 * стороне provisioner'а по своему idle-таймауту).
 *
 * `class` цели (PROP-135 слайс 5a) — `exec` (по умолчанию), `browser` либо
 * `sandbox`: при `provider: http` класс входит в ключ пула, поэтому
 * `sandbox_exec` обращается к отдельному пулу своего профиля. При
 * `provider: static` класс игнорируется (адрес — по профилю).
 *
 * `poolProvider()` (PROP-135 Ф6b-1) отдаёт провайдер пулов для admin-API
 * (`/api/v2/execution/pools*`): при `provider: http` — тот же экземпляр, что
 * у ленивых портов (список/`drain`/`release` видят один реестр пулов); при
 * `static`/`inline` — `undefined` (пулов с жизненным циклом нет).
 *
 * ## Чего роутер НЕ делает
 *
 * - не provisioner'ит поды (это следующий слайс Ф4 — сам сервис provisioner);
 * - не вычисляет binding профиля (`session → agentDefinition → project`):
 *   это делает `execution/profile-binding.ts` на стороне оркестратора, а
 *   роутер принимает уже вычисленный профиль (Ф6a);
 * - не меняет instance-level потребление порта (inline-shell, медиа-раннер,
 *   worktree/process/MCP, детект зависимостей) — там порт остаётся общим.
 */

import type { ResolvedExecutionConfig, ResolvedExecutionRemoteConfig } from '@itphx/synth-shared';
import type { ExecutionProfileCatalog } from './profile-binding.js';
import { createExecutionPortForConfig, defaultPooledPortFactory } from './factory.js';
import {
  createExecutionPoolProvider,
  poolKeyString,
  type ExecutionPoolKey,
  type ExecutionPoolProvider,
} from './pool-provider.js';
import { createPooledExecutionPort } from './pooled-port.js';
import type { ExecutionMetricsSink, ExecutionPort } from './ports/index.js';

/**
 * Цель порта: профиль исполнения и — при пуле `project`/`session` —
 * идентификатор области, а также (PROP-135 Ф4b-2b-2a) относительный путь
 * рабочего каталога внутри PVC workspace.
 */
export interface ExecutionPortTarget {
  /** Профиль исполнения (`session.settings.executorProfile`). */
  profile?: string;
  /** Идентификатор проекта — для ключа проектного пула. */
  projectId?: string;
  /** Идентификатор сессии — для ключа сессионного пула. */
  sessionId?: string;
  /**
   * Класс пула (PROP-135 слайс 5a): `exec` (по умолчанию), `browser` либо
   * `sandbox`.
   *
   * Учитывается только при `provider: http` — класс входит в ключ пула
   * (`poolKeyString`), поэтому `sandbox_exec` обращается к **своему** пулу, а
   * не к обычному пулу области. При `provider: static` класс игнорируется:
   * статический провайдер адресует пул по профилю (isolations пулов нет).
   */
  class?: 'exec' | 'browser' | 'sandbox';
  /**
   * Относительный путь внутри PVC workspace (`proj-slug`,
   * `proj-slug/.worktrees/feature`): provisioner монтирует его в пул как
   * рабочее дерево (per-project `subPath`). В ключ пула **не** входит — кэш
   * портов остаётся «один порт на ключ», subPath получает первый `ensure`.
   * Не задан — монтируется корень тома.
   */
  workspaceSubPath?: string;
}

/**
 * Роутер портов исполнения.
 *
 * `portFor` **синхронен**: порты созданы на старте (инвариант 24), роутер
 * только выбирает нужный по имени профиля.
 */
export interface ExecutionRouter {
  /**
   * Порт для цели.
   *
   * @param target профиль цели (`session.settings.executorProfile`) и — при
   *               `provider: http` и пуле `project`/`session` — идентификатор
   *               области (`projectId`/`sessionId`) и относительный путь
   *               рабочего каталога внутри PVC (`workspaceSubPath`); не заданы
   *               или профиль неизвестен — берётся профиль по умолчанию
   *               (`execution.remote.defaultProfile`).
   */
  portFor(target?: ExecutionPortTarget): ExecutionPort;
  /**
   * PROP-135 Ф6a: имена известных профилей (`execution.remote.profiles` +
   * профиль по умолчанию). Не задан у вырожденных роутеров (`inline`/тестовые
   * заглушки) — каталог неизвестен, проверка существования профиля в роутах и
   * `task` пропускается.
   */
  profiles?(): readonly string[];
  /**
   * PROP-135 Ф6a: профиль по умолчанию (`execution.remote.defaultProfile`) —
   * точка отката binding'а. Не задан — фоллбэк дефолтом роутера при `portFor`.
   */
  defaultProfile?(): string;
  /**
   * PROP-135 Ф6b-1: провайдер пулов исполнения — источник диагностики пулов
   * (`GET /api/v2/execution/pools`) и операций `drain`/`release`.
   *
   * Возвращает провайдер при `execution.remote.provider: http` (динамические
   * пулы у provisioner'а); `undefined` — пулов с жизненным циклом нет
   * (`static` — адресация по профилю, `inline` — исполнение в процессе).
   */
  poolProvider?(): ExecutionPoolProvider | undefined;
}

/**
 * PROP-135 Ф6a: снимок каталога профилей из роутера.
 *
 * `undefined` — роутер не знает каталога (`inline`/instance-пул/тестовая
 * заглушка): потребители (binding, роуты, `task`) не проверяют существование
 * профиля, поведение прежнее.
 */
export function executionProfileCatalog(
  router: ExecutionRouter | undefined,
): ExecutionProfileCatalog | undefined {
  if (!router?.profiles || !router.defaultProfile) return undefined;
  return {
    profiles: router.profiles(),
    defaultProfile: router.defaultProfile(),
  };
}

/** Структурная проверка: переданное значение — роутер исполнения. */
export function isExecutionRouter(value: unknown): value is ExecutionRouter {
  return (
    typeof (value as { portFor?: unknown } | null | undefined)?.portFor === 'function'
  );
}

/**
 * Ошибка непригодного профиля (fail-closed, `execution.remote.fallback=fail`).
 *
 * Отдельный класс — вызывающий отличает «профиль без адреса» от «исполнитель
 * недоступен» (ADR-077, как `RemoteExecutionUnavailableError`).
 */
export class ExecutionProfileUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionProfileUnavailableError';
  }
}

/** Опции сборки роутера. */
export interface ExecutionRouterOptions {
  /**
   * Эффективная секция `execution` (`resolveExecutionConfig`).
   *
   * Не задана — `inline` (прежнее поведение): роутер отдаёт instance-порт.
   */
  config: ResolvedExecutionConfig | undefined;
  /** Приёмник метрик исполнения (ADR-094) — тот же, что у порта секции. */
  metricsSink?: ExecutionMetricsSink;
  /**
   * Шов для тестов: сборка порта по эффективному конфигу профиля.
   *
   * По умолчанию — `createExecutionPortForConfig` (тот же путь, что у
   * instance-порта).
   */
  createPort?: (config: ResolvedExecutionConfig | undefined) => Promise<ExecutionPort>;
  /**
   * Готовый instance-порт.
   *
   * Переиспользуется, а не создаётся второй: в `inline`/`instance`-пуле это
   * **тот же** порт, что у процесса (иначе инстанс держал бы два клиента
   * удалённого пула).
   */
  instancePort?: ExecutionPort;
  /**
   * Провайдер пулов (PROP-135 Ф4b-1).
   *
   * Не задан — создаётся из секции `execution.remote` (`provider: static` →
   * пулы из конфигурации, `provider: http` → provisioner по HTTP). Шов для
   * тестов: подмена провайдера не требует сети.
   */
  poolProvider?: ExecutionPoolProvider;
}

/**
 * Собрать роутер портов исполнения (PROP-135 Ф4a + Ф4b-1).
 *
 * @param opts эффективная секция `execution` + приёмник метрик (+ швы для тестов)
 * @returns роутер: порт по профилю сессии
 */
export async function createExecutionRouter(
  opts: ExecutionRouterOptions,
): Promise<ExecutionRouter> {
  const config = opts.config;
  const createPort =
    opts.createPort
    ?? ((cfg: ResolvedExecutionConfig | undefined): Promise<ExecutionPort> =>
      createExecutionPortForConfig(
        cfg,
        opts.metricsSink ? { metricsSink: opts.metricsSink } : undefined,
      ));

  // `inline` и instance-пул: единственный порт на процесс. Профили
  // игнорируются — поведение как до Ф4a.
  if (!config || config.mode === 'inline' || config.remote.pooling === 'instance') {
    const port = opts.instancePort ?? (await createPort(config));
    // PROP-135 Ф6b-1: при `provider: http` провайдер пулов есть и при
    // instance-пуле (единственный пул инстанса) — admin-API показывает его
    // пулы. `static`/`inline` пулов с жизненным циклом не имеют.
    if (config && config.mode !== 'inline' && config.remote.provider === 'http') {
      const provider = opts.poolProvider ?? createExecutionPoolProvider(config.remote);
      return { portFor: () => port, poolProvider: () => provider };
    }
    return { portFor: () => port };
  }
  const remote = config.remote;

  // Провайдер пулов `http`: адрес пула приходит от provisioner'а, порт
  // собирается лениво. Профильные порты на старте **не** создаются (статических
  // адресов может не быть вовсе).
  if (remote.provider === 'http') {
    return createHttpProviderRouter(config, opts);
  }

  // Проектный/сессионный пул: порт на профиль.
  const defaultName = remote.defaultProfile;
  const plans = new Map<string, ResolvedExecutionProfilePlan>();
  for (const [name, profile] of Object.entries(remote.profiles)) {
    plans.set(name, { name, profile });
  }
  // Профиль по умолчанию существует всегда: из каталога либо «общие
  // параметры секции» (то есть профиль без адресов непригоден — решает
  // `fallback`).
  if (!plans.has(defaultName)) {
    plans.set(defaultName, {
      name: defaultName,
      profile: {
        url: [...remote.url],
        timeoutMs: remote.timeoutMs,
        concurrency: remote.concurrency,
        failMode: remote.failMode,
      },
    });
  }

  // Кэш портов по имени профиля: `portFor` синхронен, порты созданы заранее.
  const ports = new Map<string, ExecutionPort>();
  let instancePort = opts.instancePort;

  for (const plan of plans.values()) {
    if (plan.profile.url.length === 0) {
      // Профиль без адреса: наследовать общий нечего.
      if (remote.fallback === 'fail') {
        throw new ExecutionProfileUnavailableError(
          `execution profile "${plan.name}" has no executor address ` +
            `(execution.remote.profiles.${plan.name}.url / execution.remote.url) ` +
            `and execution.remote.fallback=fail`,
        );
      }
      // `fallback: instance` — откат на общий порт инстанса.
      if (!instancePort) instancePort = await createPort(config);
      ports.set(plan.name, instancePort);
      continue;
    }
    ports.set(plan.name, await createPort(profileConfig(config, plan.profile)));
  }

  return {
    portFor(target?: ExecutionPortTarget): ExecutionPort {
      const requested = (target?.profile ?? '').trim();
      // Неизвестный профиль → профиль по умолчанию (полный binding — Ф6).
      const name = requested !== '' && plans.has(requested) ? requested : defaultName;
      const port = ports.get(name) ?? ports.get(defaultName);
      if (!port) {
        // Порт по умолчанию существует всегда — сюда попасть нельзя.
        throw new ExecutionProfileUnavailableError(
          `execution profile "${name}" has no execution port (execution.remote.fallback=${remote.fallback})`,
        );
      }
      return port;
    },
    // PROP-135 Ф6a: каталог профилей — для binding'а (`resolveExecutionProfile`)
    // и проверки `executor.profile`/`executor_profile` в роутах и `task`.
    profiles: () => [...plans.keys()],
    defaultProfile: () => defaultName,
  };
}

/**
 * Роутер для провайдера пулов `http` (PROP-135 Ф4b-1).
 *
 * Порты **ленивые**: `portFor` отдаёт прокси порта, который разрешается при
 * первом обращении (`ensure` у provisioner'а → сборка порта по адресу).
 * Кэш — по ключу пула (`poolKeyString`): один порт на ключ.
 */
function createHttpProviderRouter(
  config: ResolvedExecutionConfig,
  opts: ExecutionRouterOptions,
): ExecutionRouter {
  const remote = config.remote;
  const defaultName = remote.defaultProfile;
  const provider = opts.poolProvider ?? createExecutionPoolProvider(remote);

  /** Кэш ленивых портов по ключу пула. */
  const pooled = new Map<string, ExecutionPort>();

  /** Instance-порт: готовый (из сборки приложения) либо ленивый на instance-пул. */
  const instancePort: ExecutionPort =
    opts.instancePort
    ?? createPooledExecutionPort({
      key: { scope: 'instance', class: 'exec', profile: defaultName },
      provider,
      createPort: defaultPooledPortFactory(config, opts.metricsSink),
    });

  return {
    portFor(target?: ExecutionPortTarget): ExecutionPort {
      const requested = (target?.profile ?? '').trim();
      // Неизвестный профиль → профиль по умолчанию (как в статическом пути).
      const known =
        requested !== '' && (remote.profiles[requested] !== undefined || requested === defaultName);
      const profile = known ? requested : defaultName;
      const scope = remote.pooling;
      const id = scope === 'project' ? target?.projectId : target?.sessionId;

      if (!id || id.trim() === '') {
        // Идентификатора области нет — пул не адресуем. `fallback: instance` —
        // общий порт инстанса; `fallback: fail` — fail-closed.
        if (remote.fallback === 'fail') {
          throw new ExecutionProfileUnavailableError(
            `execution pool scope "${scope}" requires an id ` +
              `(${scope === 'project' ? 'projectId' : 'sessionId'}) ` +
              `and execution.remote.fallback=fail`,
          );
        }
        return instancePort;
      }
      // PROP-135 Ф4b-2b-2a: subPath монтирования PVC — в ключ пула **не**
      // входит (кэш прокси по ключу: один порт на проект/сессию), его получает
      // первый `ensure` этого пула.
      //
      // PROP-135 слайс 5a: класс пула входит в ключ — `sandbox_exec` берёт
      // **отдельный** пул (свой образ/профиль), а не порт обычного пула
      // области. Неизвестное/пустое значение — `exec` (поведение прежнее).
      const poolClass = target?.class === 'sandbox' || target?.class === 'browser'
        ? target.class
        : 'exec';
      const key: ExecutionPoolKey = {
        scope,
        id: id.trim(),
        class: poolClass,
        profile,
        ...(target?.workspaceSubPath ? { workspaceSubPath: target.workspaceSubPath } : {}),
      };
      const keyString = poolKeyString(key);
      const existing = pooled.get(keyString);
      if (existing) return existing;

      const port = createPooledExecutionPort({
        key,
        provider,
        createPort: defaultPooledPortFactory(
          profileConfig(config, resolveProfileParams(remote, profile)),
          opts.metricsSink,
        ),
      });
      pooled.set(keyString, port);
      return port;
    },
    // PROP-135 Ф6a: каталог известных профилей (профиль по умолчанию входит
    // всегда). `provider: http` адреса профилей получает от provisioner'а —
    // проверяется только имя, без обращения к нему.
    profiles: () => [...knownProfiles(remote)],
    defaultProfile: () => defaultName,
    // PROP-135 Ф6b-1: админ-диагностика пулов у provisioner'а (`list`) и
    // операции `drain`/`release` — тот же провайдер, что у ленивых портов.
    poolProvider: () => provider,
  };
}

/** Имена известных профилей: каталог конфигурации + профиль по умолчанию. */
function knownProfiles(remote: ResolvedExecutionRemoteConfig): string[] {
  const names = new Set(Object.keys(remote.profiles));
  names.add(remote.defaultProfile);
  return [...names];
}

/**
 * Эффективные параметры профиля (PROP-135 Ф4a).
 *
 * Профиль из каталога уже «поверх» общих параметров (резолвер конфигурации
 * проставляет наследование); профиля в каталоге нет — берутся общие
 * параметры секции.
 */
function resolveProfileParams(
  remote: ResolvedExecutionRemoteConfig,
  name: string,
): ResolvedExecutionProfilePlan['profile'] {
  const profile = remote.profiles[name];
  if (!profile) {
    return {
      url: [...remote.url],
      timeoutMs: remote.timeoutMs,
      concurrency: remote.concurrency,
      failMode: remote.failMode,
    };
  }
  return {
    url: [...profile.url],
    timeoutMs: profile.timeoutMs,
    concurrency: profile.concurrency,
    failMode: profile.failMode,
  };
}

/** План профиля: имя + эффективные параметры. */
interface ResolvedExecutionProfilePlan {
  name: string;
  profile: {
    url: string[];
    timeoutMs: number;
    concurrency: number;
    failMode: ResolvedExecutionRemoteConfig['failMode'];
  };
}

/**
 * Эффективная секция `execution` для порта конкретного профиля.
 *
 * Остальные поля (пул, профиль по умолчанию, каталог профилей, фоллбэк)
 * переносятся как есть — фабрика порта их не читает, но тип требует полного
 * набора.
 */
function profileConfig(
  config: ResolvedExecutionConfig,
  profile: ResolvedExecutionProfilePlan['profile'],
): ResolvedExecutionConfig {
  const remote = config.remote;
  return {
    mode: config.mode,
    remote: {
      url: [...profile.url],
      timeoutMs: profile.timeoutMs,
      concurrency: profile.concurrency,
      failMode: profile.failMode,
      tokenSecret: remote.tokenSecret,
      pooling: remote.pooling,
      defaultProfile: remote.defaultProfile,
      profiles: remote.profiles,
      fallback: remote.fallback,
      provider: remote.provider,
      provisioner: remote.provisioner,
    },
  };
}
