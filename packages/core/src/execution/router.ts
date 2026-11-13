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
 * **Браузер — всегда проектный пул** (PROP-135 слайз 5b-1, решение владельца):
 * `class: 'browser'` скоупится **проектом**, даже при `pooling: 'session'` —
 * изоляция cookies между проектами (между сессиями одного проекта браузер
 * общий). Идентификатор области — `projectId`, при его отсутствии `sessionId`
 * (сессия без проекта); дальше — фоллбэк `fallback` (`instance`/`fail`), как
 * у остальных классов. Профиль браузера — свой (`execution.remote.browserProfile`,
 * дефолт `browser`): образ с браузером/MCP-сервером, а не `defaultProfile`.
 *
 * ## Ссылка на пул (`poolRefFor`, PROP-135 слайз 5b-1)
 *
 * `poolRefFor(target)` — **адреса и токен** пула для цели: тот же пул, к
 * которому адресует `portFor`, но без порта (нужно MCP-хосту, который сам
 * говорит с исполнителем по HTTP). Провайдер `http` — `ensure` у
 * provisioner'а, `static` — профильный адрес + токен секции; результат
 * кэшируется на 60 с (Map по ключу пула): `ensure` идемпотентен, но MCP-вызов
 * идёт на каждый вызов.
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

import type {
  ResolvedExecutionConfig,
  ResolvedExecutionProfile,
  ResolvedExecutionRemoteConfig,
} from '@itphx/synth-shared';
import { resolveBrowserProfileNames, resolveExecutionProfileNames } from '@itphx/synth-shared';
import type { ExecutionProfileCatalog } from './profile-binding.js';
import { createExecutionPortForConfig, defaultPooledPortFactory } from './factory.js';
import {
  createExecutionPoolProvider,
  executionProfileMetadata,
  ExecutionPoolProviderError,
  poolKeyString,
  toExecutionProfileInfo,
  type ExecutionPoolClass,
  type ExecutionPoolKey,
  type ExecutionPoolProvider,
  type ExecutionProfileInfo,
} from './pool-provider.js';
import { createPooledExecutionPort } from './pooled-port.js';
import { readExecutorToken } from './remote.js';
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
   *
   * **`browser` — всегда проектный пул** (PROP-135 слайз 5b-1, решение
   * владельца): изоляция cookies между проектами, но не между сессиями
   * одного проекта. Поэтому `pooling: 'session'` **не** делает браузер
   * сессионным — область всегда `project` (идентификатор — `projectId`, при
   * его отсутствии `sessionId`).
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
 * Цель ссылки на пул исполнения (PROP-135 слайз 5b-1).
 *
 * Тот же контракт, что у `ExecutionPortTarget`, но без `workspaceSubPath`:
 * ссылка на пул — это адреса и токен, а монтирование workspace определяет
 * provisioner по телу `POST /v1/pools`.
 */
export interface ExecutionPoolRefTarget {
  /** Профиль исполнения (`session.settings.executorProfile`). */
  profile?: string;
  /** Идентификатор проекта — для ключа проектного пула. */
  projectId?: string;
  /** Идентификатор сессии — для ключа сессионного пула. */
  sessionId?: string;
  /** Класс пула (`exec` по умолчанию, `browser`, `sandbox`). */
  class?: 'exec' | 'browser' | 'sandbox';
}

/**
 * Ссылка на пул исполнения (PROP-135 слайз 5b-1): адреса и токен доступа.
 *
 * Токен — **значение** (не путь): его читает провайдер пулов в момент
 * обращения. Наружу (в API/логи) ссылка не отдаётся — это внутренний контракт
 * между роутером и MCP-хостом.
 */
export interface ExecutionPoolRefInfo {
  /** Адреса пула (`http://…`). */
  urls: string[];
  /** Токен доступа к пулу (пустой — пул без токена). */
  token: string;
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
   * PROP-135 (браузерный контур): имена **браузерных** профилей
   * (`execution.remote.browserProfiles`; пусто → `[browserProfile]`). Отдельный
   * каталог: имена браузерных профилей не входят в exec-каталог `profiles()`.
   */
  browserProfiles?(): readonly string[];
  /** PROP-135 (браузерный контур): браузерный профиль по умолчанию. */
  browserDefaultProfile?(): string;
  /**
   * PROP-135 Ф6b-1: провайдер пулов исполнения — источник диагностики пулов
   * (`GET /api/v2/execution/pools`) и операций `drain`/`release`.
   *
   * Возвращает провайдер при `execution.remote.provider: http` (динамические
   * пулы у provisioner'а); `undefined` — пулов с жизненным циклом нет
   * (`static` — адресация по профилю, `inline` — исполнение в процессе).
   */
  poolProvider?(): ExecutionPoolProvider | undefined;
  /**
   * Метаданные профилей (образ/сеть/ресурсы/runtimeClass, имена MCP-серверов)
   * для admin-API/UI. `http` — `GET /v1/profiles` у provisioner'а; `static` —
   * только имена каталога конфигурации (образа/сети у адреса нет).
   *
   * Ошибка провайдера пробрасывается: вызывающий (роут) решает, показать
   * пустой список или только имена — список имён уже есть отдельно.
   */
  profilesInfo?(): Promise<ExecutionProfileInfo[]>;
  /**
   * PROP-135 слайз 5b-1: **ссылка на пул** для цели — адреса и токен пула,
   * к которому адресует `portFor` с той же целью.
   *
   * Нужна MCP-хосту (следующий слайс 5b-2): он говорит с исполнителем по
   * HTTP сам (discovery/call MCP-серверов), поэтому ему нужен адрес пула и
   * токен, а не порт исполнения.
   *
   * Провайдер `http` — адрес и токен приходят из `ensure` у provisioner'а;
   * `static` — профильный адрес и токен секции; `pooling: instance`/`inline` —
   * адреса секции (`undefined`, если адресов нет). Результат кэшируется на
   * 60 с по ключу пула.
   *
   * Ошибки **не глотаются**: `ExecutionProfileUnavailableError` (нет
   * пригодного профиля/адреса) либо `ExecutionPoolProviderError`
   * (provisioner недоступен или не выдал адрес).
   */
  poolRefFor?(target: ExecutionPoolRefTarget): Promise<ExecutionPoolRefInfo | undefined>;
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

/**
 * PROP-135 (браузерный контур): снимок каталога **браузерных** профилей.
 *
 * `undefined` — роутер не знает браузерного каталога (`inline`/instance-пул/
 * тестовая заглушка): binding не проверяет существование, поведение прежнее
 * (роутер возьмёт `execution.remote.browserProfile`).
 */
export function browserProfileCatalog(
  router: ExecutionRouter | undefined,
): ExecutionProfileCatalog | undefined {
  if (!router?.browserProfiles || !router?.browserDefaultProfile) return undefined;
  return {
    profiles: router.browserProfiles(),
    defaultProfile: router.browserDefaultProfile(),
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
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
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
      return {
        portFor: () => port,
        poolProvider: () => provider,
        profilesInfo: () => profilesInfoFromProviderOrNames(provider, config),
        poolRefFor: createPoolRefResolver(config, provider),
      };
    }
    return {
      portFor: () => port,
      poolRefFor: createPoolRefResolver(config, undefined),
      // `inline` — профилей нет (исполнение в процессе); иначе — каталог
      // конфигурации с метаданными профилей (`execution.remote.profiles`).
      ...(config && config.mode !== 'inline'
        ? { profilesInfo: async () => profilesInfoFromConfig(config) }
        : {}),
    };
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
    // Браузерный контур: имена браузерных профилей в exec-каталог не входят.
    profiles: () => resolveExecutionProfileNames(remote),
    defaultProfile: () => defaultName,
    // PROP-135 (браузерный контур): отдельный каталог для `class: 'browser'`.
    browserProfiles: () => resolveBrowserProfileNames(remote),
    browserDefaultProfile: () => remote.browserProfile,
    // PROP-135: метаданные профилей — из конфигурации (`static`).
    profilesInfo: async () =>
      [...plans.values()].map((plan) =>
        toExecutionProfileInfo(plan.name, executionProfileMetadata(plan.profile)),
      ),
    // PROP-135 слайз 5b-1: ссылка на пул (адреса + токен) для MCP-хоста.
    poolRefFor: createPoolRefResolver(config, undefined),
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
      const poolClass = resolvePoolClass(target);
      const profile = resolveProfileName(remote, target?.profile, poolClass);
      const resolved = resolvePoolTarget(remote, target);

      if (resolved === null) {
        // Идентификатора области нет — пул не адресуем. `fallback: instance` —
        // общий порт инстанса; `fallback: fail` — fail-closed.
        if (remote.fallback === 'fail') {
          throw new ExecutionProfileUnavailableError(
            `execution pool scope "${poolScopeLabel(remote, target)}" requires an id ` +
              `(${poolIdHint(remote, target)}) ` +
              `and execution.remote.fallback=fail`,
          );
        }
        return instancePort;
      }
      // PROP-135 Ф4b-2b-2a: subPath монтирования PVC — в ключ пула **не**
      // входит (кэш прокси по ключу: один порт на проект/сессию), его получает
      // первый `ensure` этого пула.
      //
      // PROP-135 слайз 5a: класс пула входит в ключ — `sandbox_exec` берёт
      // **отдельный** пул (свой образ/профиль), а не порт обычного пула
      // области. Неизвестное/пустое значение — `exec` (поведение прежнее).
      //
      // PROP-135 слайз 5b-1: `class: 'browser'` — **проектный** пул при любом
      // `pooling` (решение владельца: изоляция cookies между проектами).
      const key: ExecutionPoolKey = {
        scope: resolved.scope,
        id: resolved.id,
        class: resolved.class,
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
    // проверяется только имя, без обращения к нему. Браузерные профили — в
    // отдельном каталоге (exec-каталог их не содержит).
    profiles: () => resolveExecutionProfileNames(remote),
    defaultProfile: () => defaultName,
    // PROP-135 (браузерный контур): отдельный каталог для `class: 'browser'`.
    browserProfiles: () => resolveBrowserProfileNames(remote),
    browserDefaultProfile: () => remote.browserProfile,
    // PROP-135 Ф6b-1: админ-диагностика пулов у provisioner'а (`list`) и
    // операции `drain`/`release` — тот же провайдер, что у ленивых портов.
    poolProvider: () => provider,
    // Метаданные профилей — у provisioner'а (`GET /v1/profiles`); провайдер
    // без этой возможности (тестовая заглушка) отдаёт имена каталога.
    profilesInfo: () => profilesInfoFromProviderOrNames(provider, config),
    // PROP-135 слайз 5b-1: ссылка на пул (адреса + токен) для MCP-хоста.
    poolRefFor: createPoolRefResolver(config, provider),
  };
}

/** Имена известных профилей: каталог конфигурации + профиль по умолчанию. */
function knownProfiles(remote: ResolvedExecutionRemoteConfig): string[] {
  const names = new Set(Object.keys(remote.profiles));
  names.add(remote.defaultProfile);
  return [...names];
}

/**
 * Метаданные профилей эффективной секции `execution` (для `static`/`inline`-
 * роутера): имя + заданные поля `execution.remote.profiles`.
 */
function profilesInfoFromConfig(config: ResolvedExecutionConfig): ExecutionProfileInfo[] {
  return knownProfiles(config.remote).map((name) =>
    toExecutionProfileInfo(name, executionProfileMetadata(config.remote.profiles[name])),
  );
}

/**
 * Метаданные профилей: возможность провайдера, иначе — каталог конфигурации.
 *
 * Провайдер без `profilesInfo` (тестовая заглушка/старая реализация) не должен
 * ломать admin-API — профили (с метаданными) известны из конфигурации.
 */
function profilesInfoFromProviderOrNames(
  provider: ExecutionPoolProvider,
  config: ResolvedExecutionConfig,
): Promise<ExecutionProfileInfo[]> {
  if (typeof provider.profilesInfo === 'function') return provider.profilesInfo();
  return Promise.resolve(profilesInfoFromConfig(config));
}

/**
 * Имя профиля цели: неизвестный профиль → профиль по умолчанию (как в Ф4a).
 *
 * Для класса `browser` профиль по умолчанию — свой (`browserProfile`): браузер
 * живёт в образе с браузером/MCP-сервером, а не в образе обычных команд,
 * поэтому наследовать `defaultProfile` нельзя (PROP-135 слайс 5b-1).
 * Явно заданный профиль приоритетнее для любого класса.
 */
function resolveProfileName(
  remote: ResolvedExecutionRemoteConfig,
  requested: string | undefined,
  poolClass: ExecutionPoolClass = 'exec',
): string {
  const name = (requested ?? '').trim();
  if (poolClass === 'browser') {
    // PROP-135 (браузерный контур): известны только браузерный профиль по
    // умолчанию и явный каталог `browserProfiles`. Exec-профили браузеру не
    // адресуются — иначе `class: 'browser'` уходил бы в образ обычных команд.
    const fallback = remote.browserProfile;
    const known = name !== '' && resolveBrowserProfileNames(remote).includes(name);
    return known ? name : fallback;
  }
  const known =
    name !== '' &&
    (remote.profiles[name] !== undefined || name === remote.defaultProfile);
  return known ? name : remote.defaultProfile;
}

/**
 * Класс пула цели: неизвестное/пустое значение — `exec` (поведение прежнее).
 */
function resolvePoolClass(
  target: { class?: 'exec' | 'browser' | 'sandbox' } | undefined,
): ExecutionPoolClass {
  return target?.class === 'sandbox' || target?.class === 'browser' ? target.class : 'exec';
}

/**
 * Область пула и её идентификатор для цели (PROP-135 слайз 5b-1).
 *
 * - `browser` — **всегда проектный** пул (решение владельца): изоляция cookies
 *   между проектами, но не между сессиями одного проекта. Идентификатор —
 *   `projectId`, при его отсутствии `sessionId` (сессия без проекта);
 * - `exec`/`sandbox` — область как в `execution.remote.pooling`;
 * - `instance` — пул инстанса (один на процесс; класс цели область не меняет).
 *
 * `null` — идентификатора области нет: пул не адресуем (решает `fallback`).
 */
function resolvePoolTarget(
  remote: ResolvedExecutionRemoteConfig,
  target: ExecutionPortTarget | undefined,
): { scope: 'instance' | 'project' | 'session'; id?: string; class: ExecutionPoolClass } | null {
  if (remote.pooling === 'instance') {
    // Instance-пул: один на инстанс (тот же, что у instance-порта роутера).
    return { scope: 'instance', class: 'exec' };
  }
  const poolClass = resolvePoolClass(target);
  if (poolClass === 'browser') {
    const id = (target?.projectId ?? '').trim() || (target?.sessionId ?? '').trim();
    if (id === '') return null;
    return { scope: 'project', id, class: poolClass };
  }
  const scope = remote.pooling;
  const raw = scope === 'project' ? target?.projectId : target?.sessionId;
  const id = (raw ?? '').trim();
  if (id === '') return null;
  return { scope, id, class: poolClass };
}

/** Область пула для текста ошибки. */
function poolScopeLabel(
  remote: ResolvedExecutionRemoteConfig,
  target: ExecutionPortTarget | undefined,
): string {
  if (remote.pooling === 'instance') return 'instance';
  if (resolvePoolClass(target) === 'browser') return 'project';
  return remote.pooling;
}

/** Подсказка «какой идентификатор нужен» для текста ошибки. */
function poolIdHint(
  remote: ResolvedExecutionRemoteConfig,
  target: ExecutionPortTarget | undefined,
): string {
  if (resolvePoolClass(target) === 'browser') return 'projectId (или sessionId для браузера)';
  return remote.pooling === 'project' ? 'projectId' : 'sessionId';
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
  profile: ResolvedExecutionProfile;
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
      browserProfile: remote.browserProfile,
      browserProfiles: remote.browserProfiles,
      browserMcpServer: remote.browserMcpServer,
      profiles: remote.profiles,
      fallback: remote.fallback,
      provider: remote.provider,
      provisioner: remote.provisioner,
    },
  };
}

/**
 * TTL кэша ссылок на пулы (PROP-135 слайз 5b-1), мс.
 *
 * `ensure` у provisioner'а идемпотентен, но MCP-вызов идёт на каждый вызов —
 * без кэша каждый вызов ходил бы в provisioner. 60 с — как TTL инвентаря
 * возможностей исполнителя (ADR-077 шаг A): адрес пула меняется редко, а
 * устаревшая ссылка на 60 с не ломает работу (пул пересоздастся по
 * `ensure`).
 */
export const POOL_REF_TTL_MS = 60_000;

/**
 * Сборка резолвера ссылок на пулы (PROP-135 слайз 5b-1).
 *
 * ## Правила
 *
 * - `provider: http` — `ensure` у provisioner'а: адрес и токен приходят из
 *   ответа (тот же ключ пула, что у `portFor` — ссылка всегда указывает на
 *   **тот же** пул, что и порт);
 * - `provider: static` — профильный адрес (первый — как у
 *   `StaticExecutionPoolProvider.ensure`) и токен секции
 *   (`execution.remote.tokenSecret`);
 * - `pooling: instance`/`inline` — адреса секции (`undefined`, если адресов
 *   нет: пула вне инстанса нет).
 *
 * ## Ошибки
 *
 * Не глотаются: `ExecutionProfileUnavailableError` (профиль без адреса,
 * `fallback: fail`) либо `ExecutionPoolProviderError` (provisioner
 * недоступен/не выдал адрес). Значение токена в текст ошибки не попадает.
 */
function createPoolRefResolver(
  config: ResolvedExecutionConfig | undefined,
  provider: ExecutionPoolProvider | undefined,
): (target: ExecutionPoolRefTarget) => Promise<ExecutionPoolRefInfo | undefined> {
  const remote = config?.remote;
  // `inline` — исполнение в процессе: удалённого пула нет, адресовать некого.
  if (!remote || config?.mode === 'inline') return async () => undefined;

  /** Кэш ссылок по ключу пула (TTL — `POOL_REF_TTL_MS`). */
  const cache = new Map<string, { info: ExecutionPoolRefInfo; at: number }>();

  /** Ссылка на пул инстанса (адреса секции или instance-пул у provisioner'а). */
  const instanceRef = async (): Promise<ExecutionPoolRefInfo | undefined> => {
    if (remote.provider === 'http') {
      // Instance-пул у provisioner'а — тот же, что у instance-порта роутера
      // (ключ `instance:exec:<профиль по умолчанию>`).
      const ref = await ensurePool(provider, {
        scope: 'instance',
        class: 'exec',
        profile: remote.defaultProfile,
      });
      return { urls: [ref.url], token: ref.token };
    }
    const url = remote.url.map((item) => item.trim()).find((item) => item !== '');
    if (url === undefined) return undefined;
    return { urls: [url], token: await readPoolToken(remote.tokenSecret) };
  };

  return async (target: ExecutionPoolRefTarget): Promise<ExecutionPoolRefInfo | undefined> => {
    const poolClass = resolvePoolClass(target);
    const profile = resolveProfileName(remote, target.profile, poolClass);
    const resolved = resolvePoolTarget(remote, target);
    if (resolved === null) {
      // Идентификатора области нет — как в `portFor`: `fallback: fail` —
      // fail-closed, иначе — ссылка на пул инстанса.
      if (remote.fallback === 'fail') {
        throw new ExecutionProfileUnavailableError(
          `execution pool scope "${poolScopeLabel(remote, target)}" requires an id ` +
            `(${poolIdHint(remote, target)}) ` +
            `and execution.remote.fallback=fail`,
        );
      }
      return instanceRef();
    }
    if (resolved.scope === 'instance') return instanceRef();

    const key: ExecutionPoolKey = {
      scope: resolved.scope,
      id: resolved.id,
      class: resolved.class,
      profile,
    };
    const keyString = poolKeyString(key);
    const cached = cache.get(keyString);
    if (cached !== undefined && Date.now() - cached.at < POOL_REF_TTL_MS) {
      return cached.info;
    }

    let info: ExecutionPoolRefInfo;
    if (remote.provider === 'http') {
      const ref = await ensurePool(provider, key);
      info = { urls: [ref.url], token: ref.token };
    } else {
      // Статический провайдер: адрес профиля (первый — как у `ensure`) и токен
      // секции (`execution.remote.tokenSecret`).
      const url = resolveProfileParams(remote, profile)
        .url.map((item) => item.trim())
        .find((item) => item !== '');
      if (url === undefined) {
        throw new ExecutionProfileUnavailableError(
          `execution profile "${profile}" has no executor address ` +
            `(execution.remote.profiles.${profile}.url / execution.remote.url)`,
        );
      }
      info = { urls: [url], token: await readPoolToken(remote.tokenSecret) };
    }
    cache.set(keyString, { info, at: Date.now() });
    return info;
  };
}

/**
 * `ensure` у провайдера пулов с проверкой ответа (PROP-135 слайз 5b-1).
 *
 * Провайдер не задан (тестовая заглушка/вырожденный роутер) или не выдал
 * адрес — `ExecutionPoolProviderError` (ошибку **не глотаем**: вызывающий
 * решает, что делать — MCP-вызов без пула бессмыслен).
 */
async function ensurePool(
  provider: ExecutionPoolProvider | undefined,
  key: ExecutionPoolKey,
): Promise<{ url: string; token: string }> {
  if (provider === undefined) {
    throw new ExecutionPoolProviderError(
      'execution pool provider is not available (execution.remote.provider=http)',
    );
  }
  const ref = await provider.ensure(key);
  const url = (ref.url ?? '').trim();
  if (url === '') {
    throw new ExecutionPoolProviderError(
      `execution pool provider returned no pool address for key "${poolKeyString(key)}"`,
    );
  }
  return { url, token: (ref.token ?? '').trim() };
}

/**
 * Значение токена исполнителя (`execution.remote.tokenSecret`) для ссылки на
 * пул (PROP-135 слайз 5b-1).
 *
 * `tokenSecret` — **путь** (инвариант 13): значение читается из файла в
 * момент обращения и в текст ошибки не попадает (в текст идёт только путь).
 */
async function readPoolToken(tokenSecret: string): Promise<string> {
  try {
    return await readExecutorToken(tokenSecret);
  } catch (err) {
    throw new ExecutionProfileUnavailableError(
      'execution pool reference could not read the executor token ' +
        '(execution.remote.tokenSecret)',
      { cause: err },
    );
  }
}
