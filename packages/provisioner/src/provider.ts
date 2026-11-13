/**
 * Провайдеры пулов provisioner'а (PROP-135, Ф4b-2a/4b-2b).
 *
 * Контракт `PoolProvisioner` — то, что provisioner умеет делать с ресурсом
 * пула: обеспечить (`ensure`), подготовить к удалению (`drain`) и удалить
 * (`release`). Реализации:
 *
 * - `static` (4b-2a) — адрес пула известен заранее (точный ключ либо профиль),
 *   ресурсов не создаётся;
 * - `kubernetes` (4b-2b) — под исполнителя и секрет с токеном в своём
 *   namespace (`kubernetes-provider.ts`).
 *
 * `drain` отделён от `release` (сначала «попросить» исполнителя завершиться,
 * потом удалить ресурс), `capabilities` отдаёт профили.
 *
 * ## Токены пулов
 *
 * Токен возвращается **значением** (control plane передаёт его исполнителю);
 * provisioner его не логирует и не отдаёт в диагностике (`GET /v1/pools`).
 * В static-режиме токен никуда не сохраняется — он существует только для
 * контракта (реальный исполнитель проверяет свой токен сам).
 */

import type { ProvisionerConfig, ProvisionerProfiles } from './config.js';
import { PoolProvisionerError } from './errors.js';
import { HttpKubernetesClient, type KubernetesClient } from './kubernetes.js';
import { KubernetesPoolProvisioner } from './kubernetes-provider.js';
import type { ProvisionerMetrics } from './metrics.js';
import type {
  EnsurePoolRequest,
  EnsurePoolResponse,
  ProvisionerProfileInfo,
  WarmImageResult,
} from './protocol.js';
import { generatePoolToken } from './token.js';

export { PoolProvisionerError } from './errors.js';
export type { PoolProviderErrorReason } from './errors.js';
export { generatePoolToken } from './token.js';

/**
 * Источник пулов исполнения.
 *
 * `ensure` — идемпотентный по контракту (повторный запрос того же ключа
 * возвращает тот же ресурс; кэш держит `PoolService`, а Kubernetes-провайдер
 * дополнительно усыновляет под по label). `drain`/`release` — операции над
 * уже существующим ресурсом; неизвестный ключ — no-op.
 */
export interface PoolProvisioner {
  /** Обеспечить пул: адрес и токен исполнителя. */
  ensure(req: EnsurePoolRequest): Promise<EnsurePoolResponse>;
  /** Подготовить ресурс пула к удалению (освободить исполнителей). */
  drain(key: string): Promise<void>;
  /** Удалить ресурс пула. */
  release(key: string): Promise<void>;
  /** Диагностика: имя провайдера и известные профили. */
  capabilities(): Promise<{ provider: string; profiles: string[] }>;
  /**
   * Метаданные профилей (для админ-раздела «Исполнение»): образ, сеть,
   * ресурсы, runtimeClass и **имена** MCP-серверов. Без env, URL и токенов.
   */
  profilesInfo?(): Promise<ProvisionerProfileInfo[]>;
  /**
   * Прогреть образы на нодах кластера (PROP-135, Ф4b-2b).
   *
   * Не задан — провайдер прогрев не умеет (`static`: адреса пулов заданы
   * извне, подов кластера нет) — HTTP-контур ответит `400 invalid_request`.
   */
  warmImages?(images: string[]): Promise<WarmImageResult[]>;
}

/**
 * Провайдер пулов `static` (4b-2a): адреса известны заранее.
 *
 * Порядок поиска:
 * 1. **точный ключ** в `SYNTH_PROVISIONER_STATIC_POOLS` (тесты/дев: пул на
 *    конкретный проект/сессию);
 * 2. **профиль** запроса — `url` из `SYNTH_PROVISIONER_PROFILES` (общий пул
 *    профиля; изоляции пулов нет — это документированное ограничение static);
 * 3. иначе — `pool_not_found` (`404`).
 *
 * `profileSpec` (спецификация профиля из тела запроса) провайдер **игнорирует**:
 * адрес статического пула задаётся конфигурацией (`staticPools`/`profiles[].url`),
 * а не описанием профиля. Поведение прежнее.
 *
 * `ensure` возвращает **новый** токен на каждый вызов; идемпотентность
 * (тот же url/токен на повторный ключ) обеспечивает `PoolService`, который
 * кэширует запись.
 */
export class StaticPoolProvisioner implements PoolProvisioner {
  private readonly _staticPools: Record<string, string>;
  private readonly _profiles: ProvisionerProfiles;

  constructor(staticPools: Record<string, string>, profiles: ProvisionerProfiles) {
    this._staticPools = staticPools;
    this._profiles = profiles;
  }

  async ensure(req: EnsurePoolRequest): Promise<EnsurePoolResponse> {
    const exact = this._staticPools[req.key]?.trim() ?? '';
    if (exact !== '') {
      return { url: exact, token: generatePoolToken() };
    }
    const profile = this._profiles[req.profile];
    const url = profile?.url?.trim() ?? '';
    if (url === '') {
      throw new PoolProvisionerError(
        'pool_not_found',
        `пул "${req.key}" не найден: профиль "${req.profile}" не описан ` +
          '(SYNTH_PROVISIONER_PROFILES / SYNTH_PROVISIONER_STATIC_POOLS)',
      );
    }
    return { url, token: generatePoolToken() };
  }

  // Ресурсов нет: удалять/сливать нечего. Методы существуют, чтобы контракт
  // был одинаковым у всех провайдеров.
  async drain(_key: string): Promise<void> {
    // no-op
  }

  async release(_key: string): Promise<void> {
    // no-op
  }

  async capabilities(): Promise<{ provider: string; profiles: string[] }> {
    return { provider: 'static', profiles: Object.keys(this._profiles) };
  }

  /**
   * Метаданные профилей static-провайдера: известны только имя и описание
   * (образа/сети/ресурсов у статического адреса нет — пул задан извне).
   */
  async profilesInfo(): Promise<ProvisionerProfileInfo[]> {
    return Object.entries(this._profiles).map(([name, profile]) => ({
      name,
      ...(profile.description !== undefined ? { description: profile.description } : {}),
    }));
  }
}

/**
 * Собрать провайдера пулов по эффективной конфигурации.
 *
 * `kubernetes` требует секции `config.kubernetes` (её отсутствие — ошибка
 * конфигурации, а не молчаливый фоллбек на `static`); статические пулы
 * Kubernetes-провайдер не использует.
 *
 * @param config эффективная конфигурация
 * @param opts швы: метрики и клиент Kubernetes API (тесты/повторное использование)
 * @throws PoolProvisionerError если конфигурация не соответствует провайдеру
 */
export function createPoolProvisioner(
  config: ProvisionerConfig,
  opts: { metrics?: ProvisionerMetrics; client?: KubernetesClient } = {},
): PoolProvisioner {
  if (config.provider === 'static') {
    return new StaticPoolProvisioner(config.staticPools, config.profiles);
  }
  if (config.provider === 'kubernetes') {
    const kubernetes = config.kubernetes;
    if (kubernetes === undefined) {
      throw new PoolProvisionerError(
        'provider_error',
        'провайдер "kubernetes" выбран, но секция kubernetes не разобрана из env',
      );
    }
    return new KubernetesPoolProvisioner({
      client:
        opts.client ??
        new HttpKubernetesClient({
          apiServer: kubernetes.apiServer,
          namespace: kubernetes.namespace,
          tokenFile: kubernetes.tokenFile,
          caFile: kubernetes.caFile,
        }),
      kubernetes,
      profiles: config.profiles,
      commandPolicy: config.executorCommandPolicy,
      ...(opts.metrics !== undefined ? { metrics: opts.metrics } : {}),
    });
  }
  throw new PoolProvisionerError(
    'provider_error',
    `провайдер пулов "${String(config.provider)}" не реализован`,
  );
}
