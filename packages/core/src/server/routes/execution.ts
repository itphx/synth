/**
 * Исполнение: профили и пулы (PROP-135, слайс 6b-1).
 *
 * ## Зачем
 *
 * `execution.*` — параметр запуска (инвариант 24): профили и адреса
 * исполнителей известны только процессу. Администратору (и UI «Исполнение»)
 * нужно видеть, **что** настроено и **какие** динамические пулы сейчас живы, а
 * также уметь слить/удалить пул. Без HTTP-контура это можно было только
 * чтением `config.yaml` и метрик provisioner'а. Каталог профилей при этом нужен
 * и обычному пользователю — владелец проекта выбирает профиль в настройках
 * проекта (роль у него может быть `USER`).
 *
 * ## Контракт
 *
 * - `GET /api/v2/execution/profiles` — эффективные провайдер/пулинг/профили
 *   (**любой аутентифицированный**: каталог нужен владельцу проекта, чтобы
 *   выбрать профиль в настройках проекта); аддитивное `details` — метаданные
 *   профилей (образ/сеть/ресурсы/runtimeClass, имена MCP-серверов) из
 *   provisioner'а либо только имена из конфигурации;
 * - `GET /api/v2/execution/pools` — пулы: у `http` — `list()` провайдера, у
 *   `static` — профили как `configured`, у `inline` — пусто (ADMIN/LEAD);
 * - `POST /api/v2/execution/pools/:key/drain` — слить пул (`202`);
 * - `DELETE /api/v2/execution/pools/:key` — удалить пул (`202`, идемпотентно);
 * - `POST /api/v2/execution/images/warm` — прогреть образы на нодах кластера
 *   (`{images}` → `{results}`; `writeGuard` — ADMIN в managed).
 *
 * `:key` — канонический ключ пула (`poolKeyString`: `project:<id>:exec:<p>`,
 * `session:<id>:browser:<p>`, `instance:<class>:<p>`), в URL — URL-encoded.
 *
 * ## Секреты
 *
 * Наружу **не отдаются** ни адрес пула/исполнителя, ни его токен (инвариант
 * 13): DTO содержит только ключ, профиль, состояние и метки времени. Токен
 * provisioner'а читается внутри `HttpExecutionPoolProvider` и в ответы не
 * попадает.
 *
 * ## Гибрид/деградация
 *
 * Роут локальный (это состояние **этого** процесса): удалённый backend не
 * проксируется. `executionConfig` нет (`inline`) — профилей нет, пулов нет;
 * операции над пулами отвечают `503 EXECUTION_PROVIDER_UNAVAILABLE` (пулов с
 * жизненным циклом не существует).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import {
  resolveBrowserProfileNames,
  resolveExecutionProfileNames,
  type ResolvedExecutionConfig,
} from '@itphx/synth-shared';
import {
  EXECUTION_IMAGE_REF_MAX_LENGTH,
  EXECUTION_WARM_IMAGES_MAX,
  executionProfileMetadata,
  isValidImageRef,
  parsePoolKey,
  toExecutionProfileInfo,
  type ExecutionImageWarmResult,
  type ExecutionPoolProvider,
  type ExecutionProfileInfo,
  type PoolInfo,
} from '../../execution/pool-provider.js';
import type { ExecutionRouter } from '../../execution/router.js';
import type { ExecutionChangedHook } from '../../events/execution-events.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/**
 * Эффективный провайдер исполнения: `inline` — исполнение в процессе,
 * `static` — пулы/адреса из конфигурации, `http` — динамические пулы у
 * provisioner'а.
 */
export type ExecutionProviderKind = 'static' | 'http' | 'inline';

/** DTO `GET /api/v2/execution/profiles`. */
export interface ExecutionProfilesDto {
  /** Эффективный провайдер (`inline` — секция `execution` не задана). */
  provider: ExecutionProviderKind;
  /** Режим пула (`execution.remote.pooling`). */
  pooling: 'instance' | 'project' | 'session';
  /** Профиль по умолчанию. */
  defaultProfile: string;
  /**
   * Известные профили **exec**-контура (профиль по умолчанию входит всегда).
   * Имена браузерных профилей сюда **не** попадают — у них свой каталог.
   */
  profiles: string[];
  /**
   * PROP-135 (браузерный контур): каталог браузерных профилей
   * (`execution.remote.browserProfiles`; пусто → `[browserProfile]`). Аддитивно.
   */
  browserProfiles: string[];
  /** PROP-135 (браузерный контур): браузерный профиль по умолчанию. */
  browserDefaultProfile: string;
  /**
   * Метаданные профилей (аддитивно): образ/сеть/ресурсы/runtimeClass, класс
   * профиля, MCP-серверы (имя/команда/аргументы) и описание. Без env и
   * секретов (инвариант 13).
   *
   * `http` — из `GET /v1/profiles` provisioner'а; `static` — только имена
   * каталога конфигурации (образа/сети у статического адреса нет); `inline` —
   * пусто. Provisioner недоступен — `[]` (список имён уже есть в `profiles`).
   */
  details: ExecutionProfileInfo[];
  /**
   * Происхождение профилей (аддитивно, ADR-135 §11): `config` — профиль из
   * `config.yaml` (его можно отключить), `runtime` — создан в runtime-каталоге.
   */
  profileOrigins?: Record<string, 'config' | 'runtime'>;
}

/** DTO `GET /api/v2/execution/pools`. */
export interface ExecutionPoolsDto {
  provider: ExecutionProviderKind;
  /** Пул: без адреса и токена (инвариант 13). */
  pools: PoolInfo[];
}

/**
 * DTO `POST /api/v2/execution/images/warm`.
 *
 * Прогрев образов на нодах кластера: тянет образы в реестр нод, чтобы
 * первый пул с ними не ждал скачивания. Ответ — по образу: удалось ли и на
 * скольких нодах.
 */
export interface ExecutionImagesWarmDto {
  /** Итог по каждому образу (порядок — как в запросе). */
  results: ExecutionImageWarmResult[];
}

/**
 * Тело `POST /api/v2/execution/images/warm`: список образов.
 *
 * Fail-closed: пустой список, больше `EXECUTION_WARM_IMAGES_MAX` образов и
 * недопустимая ссылка на образ — `400 VALIDATION_ERROR`.
 */
const warmImagesBodySchema = z
  .object({
    images: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(EXECUTION_IMAGE_REF_MAX_LENGTH)
          .refine(isValidImageRef, { message: 'ожидается ссылка на образ (docker-ref)' }),
      )
      .min(1)
      .max(EXECUTION_WARM_IMAGES_MAX),
  })
  .strict();

export interface ExecutionRoutesDeps {
  /**
   * Эффективная секция `execution` (`resolveExecutionConfig`; инвариант 24).
   * Не задана — `inline`: профилей нет, пулов нет.
   */
  executionConfig?: ResolvedExecutionConfig;
  /** Роутер портов исполнения — источник провайдера пулов (PROP-135 Ф4b-1). */
  executionRouter?: ExecutionRouter;
}

export interface ExecutionRoutesMessages {
  /** Ключ пула не соответствует формату `poolKeyString`. */
  invalidKey: (c: Context) => string;
  /** Провайдер пулов недоступен/не настроен. */
  providerUnavailable: (c: Context) => string;
  /** Пул с таким ключом провайдеру неизвестен. */
  poolNotFound: (c: Context, key: string) => string;
  /** Тело запроса прогрева образов невалидно. */
  invalidImages: (c: Context) => string;
  /** Провайдер не умеет прогревать образы (нет подов кластера). */
  warmUnsupported: (c: Context) => string;
}

export interface ExecutionRoutesOptions {
  /**
   * Guard на чтение каталога профилей; по умолчанию — `requireAuth`.
   * Managed — любой аутентифицированный: профиль выбирается в настройках
   * проекта, поэтому роль USER тоже должна видеть каталог.
   */
  profilesReadGuard?: Middleware;
  /** Guard на чтение списка пулов; по умолчанию — `requireAuth`. Managed — ADMIN/LEAD. */
  poolsReadGuard?: Middleware;
  /** Guard на `drain`/`release`; по умолчанию — `requireAuth`. Managed — ADMIN. */
  writeGuard?: Middleware;
  /** Локализуемые сообщения (backend — i18n, core — русские литералы). */
  messages?: Partial<ExecutionRoutesMessages>;
  /**
   * ADR-135: вызывается **после успешной** мутации пула (`drain`/`release`) —
   * `execution.updated` с `action: 'pool.delete'` (в обоих случаях пул уходит из
   * активного списка). Точка сборки ставит сюда `executionChangedPublisher(eventBus)`.
   * Каталог профилей публикует фабрика настроек (`PUT`/`DELETE
   * /settings/execution`) — здесь только пулы.
   *
   * Прогрев образов (`POST /images/warm`) событие не публикует: ни каталог
   * профилей, ни состав пулов он не меняет.
   */
  onExecutionChanged?: ExecutionChangedHook;
}

const DEFAULT_MESSAGES: ExecutionRoutesMessages = {
  invalidKey: () =>
    'ключ пула: ожидается `instance:<class>:<profile>` либо `<project|session>:<id>:<class>:<profile>`',
  providerUnavailable: () =>
    'провайдер пулов исполнения недоступен: динамические пулы требуют execution.remote.provider=http',
  poolNotFound: (_c, key) => `пул "${key}" не найден`,
  invalidImages: () =>
    'тело запроса: ожидается `{images: string[]}` — непустой список ссылок на образы (≤20)',
  warmUnsupported: () =>
    'прогрев образов недоступен: провайдер пулов не управляет подами кластера ' +
    '(нужен execution.remote.provider=http и provisioner с kubernetes-провайдером)',
};

/** Декодирование ключа из пути: Hono уже декодирует параметр, повтор — безопасен. */
function decodeKeyParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // Невалидная escape-последовательность (`%` в имени профиля) — как есть.
    return raw;
  }
}

/**
 * Роуты профилей и пулов исполнения (core + managed — одна реализация).
 *
 * Отличаются только guard'ами (managed — любой аутентифицированный на каталог
 * профилей, ADMIN/LEAD на пулы, ADMIN на мутации; core — `requireAuth`) и
 * текстами (backend — i18n).
 */
export function createExecutionRoutes(
  auth: { requireAuth: Middleware },
  deps: ExecutionRoutesDeps,
  opts: ExecutionRoutesOptions = {},
): Hono {
  const app = new Hono();
  const profilesReadGuard = opts.profilesReadGuard ?? auth.requireAuth;
  const poolsReadGuard = opts.poolsReadGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const messages: ExecutionRoutesMessages = { ...DEFAULT_MESSAGES, ...opts.messages };

  /** Эффективный провайдер: секции нет — `inline` (прежнее поведение). */
  const providerKind = (): ExecutionProviderKind => {
    const config = deps.executionConfig;
    if (!config || config.mode === 'inline') return 'inline';
    return config.remote.provider;
  };

  /** Каталог профилей: роутер знает его точнее (включает профиль по умолчанию). */
  const profileNames = (): string[] => {
    const config = deps.executionConfig;
    // `inline` — профилей нет (исполнение в процессе, профили игнорируются).
    if (!config || config.mode === 'inline') return [];
    const fromRouter = deps.executionRouter?.profiles?.();
    if (fromRouter && fromRouter.length > 0) return [...fromRouter];
    // Fallback без роутера: каталог конфигурации **без** браузерных имён.
    return resolveExecutionProfileNames(config.remote);
  };

  /** Каталог браузерных профилей (отдельный контур; exec-имена не входят). */
  const browserProfileNames = (): string[] => {
    const config = deps.executionConfig;
    if (!config || config.mode === 'inline') return [];
    const fromRouter = deps.executionRouter?.browserProfiles?.();
    if (fromRouter && fromRouter.length > 0) return [...fromRouter];
    return resolveBrowserProfileNames(config.remote);
  };

  const browserDefaultProfile = (): string =>
    deps.executionRouter?.browserDefaultProfile?.()
    ?? deps.executionConfig?.remote.browserProfile
    ?? '';

  const defaultProfileName = (): string =>
    deps.executionRouter?.defaultProfile?.()
    ?? deps.executionConfig?.remote.defaultProfile
    ?? 'default';

  const poolProvider = (): ExecutionPoolProvider | undefined =>
    deps.executionRouter?.poolProvider?.();

  /**
   * Метаданные профилей (аддитивное поле `details`).
   *
   * Источник — роутер (`profilesInfo`), провайдер пулов либо имена каталога.
   * Сбой provisioner'а **не** превращает каталог в `503`: имена профилей уже
   * есть в `profiles`, а детали — необязательная диагностика.
   */
  const profileDetails = async (): Promise<ExecutionProfileInfo[]> => {
    if (providerKind() === 'inline') return [];
    const fromRouter = deps.executionRouter?.profilesInfo;
    if (fromRouter) {
      try {
        return await fromRouter.call(deps.executionRouter);
      } catch {
        return [];
      }
    }
    const provider = poolProvider();
    if (provider && typeof provider.profilesInfo === 'function') {
      try {
        return await provider.profilesInfo();
      } catch {
        return [];
      }
    }
    // Фоллбек без роутера/провайдера: имена каталога + метаданные
    // `execution.remote.profiles` (если заданы).
    const config = deps.executionConfig;
    return profileNames().map((name) =>
      toExecutionProfileInfo(name, executionProfileMetadata(config?.remote.profiles[name])),
    );
  };

  const providerUnavailable = (c: Context): Response =>
    c.json(
      { error: { code: 'EXECUTION_PROVIDER_UNAVAILABLE', message: messages.providerUnavailable(c) } },
      503,
    );

  /**
   * Прогрев не поддерживается провайдером: `501` (в отличие от `503`
   * «провайдер недоступен» — здесь провайдер есть, но операции не умеет).
   */
  const warmUnsupported = (c: Context): Response =>
    c.json(
      { error: { code: 'EXECUTION_PROVIDER_UNAVAILABLE', message: messages.warmUnsupported(c) } },
      501,
    );

  // Эффективная конфигурация исполнения (профили/пулинг) — только чтение.
  // Каталог профилей — любому аутентифицированному: профиль выбирается в
  // настройках проекта (владелец проекта может быть с ролью USER).
  app.get('/profiles', profilesReadGuard, async (c) => {
    const dto: ExecutionProfilesDto = {
      provider: providerKind(),
      pooling: deps.executionConfig?.remote.pooling ?? 'instance',
      defaultProfile: defaultProfileName(),
      profiles: profileNames(),
      // PROP-135 (браузерный контур): отдельный каталог браузерных профилей.
      browserProfiles: browserProfileNames(),
      browserDefaultProfile: browserDefaultProfile(),
      details: await profileDetails(),
      // ADR-135 §11: происхождение профилей (config/runtime) — для UI.
      ...(deps.executionConfig?.remote.profileOrigins
        ? { profileOrigins: { ...deps.executionConfig.remote.profileOrigins } }
        : {}),
    };
    return c.json(dto);
  });

  // Пулы: http — реестр provisioner'а, static — профили как `configured`,
  // inline — пулов нет (исполнение в процессе).
  app.get('/pools', poolsReadGuard, async (c) => {
    const kind = providerKind();
    if (kind === 'static') {
      const dto: ExecutionPoolsDto = {
        provider: kind,
        pools: profileNames().map((profile) => ({ profile, state: 'configured' })),
      };
      return c.json(dto);
    }
    if (kind === 'inline') {
      const dto: ExecutionPoolsDto = { provider: kind, pools: [] };
      return c.json(dto);
    }
    const provider = poolProvider();
    if (!provider || typeof provider.list !== 'function') return providerUnavailable(c);
    try {
      const pools = await provider.list();
      const dto: ExecutionPoolsDto = { provider: kind, pools };
      return c.json(dto);
    } catch {
      // Причина в ответ не идёт: текст ошибки провайдера может содержать
      // технические детали provisioner'а (но не токен — его там нет).
      return providerUnavailable(c);
    }
  });

  // Слить пул: `202` — запрос принят, фактическое снятие идёт у provisioner'а
  // (`drain` провайдера best-effort). Неизвестный ключ реестра — `404`.
  app.post('/pools/:key/drain', writeGuard, async (c) => {
    const key = decodeKeyParam(c.req.param('key'));
    const parsed = parseKeyOrNull(key);
    if (!parsed) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidKey(c) } }, 400);
    }
    const provider = poolProvider();
    if (!provider) return providerUnavailable(c);

    const known = await knownPoolKeys(provider);
    if (known && !known.has(key)) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.poolNotFound(c, key) } }, 404);
    }
    try {
      if (provider.drain) await provider.drain(parsed);
    } catch {
      return providerUnavailable(c);
    }
    // Пул слит: состав активных пулов изменился → `execution.updated`
    // (`pool.delete` — у контракта нет отдельного «drain», пул в обоих случаях
    // уходит из активного списка).
    opts.onExecutionChanged?.({ action: 'pool.delete', poolName: key });
    return c.json({ ok: true }, 202);
  });

  // Удалить пул: идемпотентно — повторный `DELETE` тоже `202` (пул уже мог быть
  // удалён по idle-таймауту на стороне provisioner'а).
  app.delete('/pools/:key', writeGuard, async (c) => {
    const key = decodeKeyParam(c.req.param('key'));
    const parsed = parseKeyOrNull(key);
    if (!parsed) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidKey(c) } }, 400);
    }
    const provider = poolProvider();
    if (!provider || typeof provider.release !== 'function') return providerUnavailable(c);
    try {
      await provider.release(parsed);
    } catch {
      return providerUnavailable(c);
    }
    // Пул удалён (идемпотентно) → `execution.updated`.
    opts.onExecutionChanged?.({ action: 'pool.delete', poolName: key });
    return c.json({ ok: true }, 202);
  });

  // Прогрев образов на нодах кластера: тянет образы в реестр нод, чтобы
  // первый пул с ними не ждал скачивания. Guard — `writeGuard` (managed:
  // ADMIN). Провайдер без `warmImages` (static/нет провайдера) — `501`.
  app.post('/images/warm', writeGuard, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidImages(c) } }, 400);
    }
    const parsed = warmImagesBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidImages(c) } }, 400);
    }
    const provider = poolProvider();
    if (!provider || typeof provider.warmImages !== 'function') return warmUnsupported(c);
    try {
      const results = await provider.warmImages(parsed.data.images);
      const dto: ExecutionImagesWarmDto = { results };
      return c.json(dto, 200);
    } catch {
      // Причина в ответ не идёт: текст ошибки провайдера может содержать
      // технические детали provisioner'а (но не токен — его там нет).
      return providerUnavailable(c);
    }
  });

  return app;
}

/** Разбор ключа пула; невалидный формат — `null` (роут отвечает 400). */
function parseKeyOrNull(key: string) {
  try {
    return parsePoolKey(key);
  } catch {
    return null;
  }
}

/**
 * Ключи известных провайдеру пулов — для `drain` (`404`, если ключа нет).
 *
 * `null` — реестр неизвестен (провайдер не умеет `list`, список пуст или
 * запрос к provisioner'у не удался): проверка пропускается, `drain` остаётся
 * best-effort и не превращается в ложный `404`.
 */
async function knownPoolKeys(provider: ExecutionPoolProvider): Promise<Set<string> | null> {
  if (typeof provider.list !== 'function') return null;
  try {
    const pools = await provider.list();
    const keys = new Set<string>();
    for (const pool of pools) {
      if (typeof pool.key === 'string' && pool.key !== '') keys.add(pool.key);
    }
    return keys.size > 0 ? keys : null;
  } catch {
    return null;
  }
}
