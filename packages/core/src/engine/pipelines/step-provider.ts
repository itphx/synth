/**
 * ADR-101 §4 × `AgentDefinition`: провайдер **агентского** шага пайплайна.
 *
 * Шаг пайплайна исполняется агентом (`node.agent`), у которого в конфигурации
 * могут быть свои `provider`/`model`/`temperature`/`topP`/`topK` — ровно те же
 * поля, что у саб-агента (`task`, `engine/tools/task/tool.ts`). Раньше шаг
 * всегда шёл дефолтной парой инстанса: агент шага влиял на промпт и тулы, но
 * не на модель. Здесь — единая точка резолвинга (её используют обе точки
 * сборки: `server/app/deps.ts` ядра и `backend/app/deps.ts`).
 *
 * Приоритет:
 *  1. `agent.provider`/`agent.model` (пустая строка — «не задано»);
 *  2. дефолты инстанса (`resolveLlmDefaults`: runtime-пара → config);
 *  3. `defaultModel` конфига провайдера — только для модели.
 *
 * Модель чужого провайдера не наследуется: если агент переключил провайдера,
 * `defaults.model` (пара инстанса) относится к другому провайдеру и не
 * подставляется — берётся `defaultModel` самого провайдера.
 *
 * Sampling (`topP`/`topK`) и температура агента уходят **в создание**
 * провайдера (`ProviderFactory.create`), поэтому `applyStepTemperature` в
 * агентском шаге клон не делает: `provider.temperature` уже равен
 * `agent.temperature` (или `undefined` — поле в запрос не идёт).
 *
 * Провайдер не кэшируется: обёртка `GatewayProvider` подхватывает live-конфиг
 * LLM Gateway (ADR-036), поэтому возвращается **уже обёрнутый** провайдер.
 */
import type { AgentDefinition } from '@itphx/synth-shared';

import type { BaseProvider, ProviderConfig } from '../../providers/base.js';
import type { PipelineLlmDefaults, StepExecutionContext } from './types.js';

/** Конфиг провайдера инстанса — минимум, который нужен резолверу шага. */
export interface PipelineStepProviderConfigLike {
  /** Модель по умолчанию провайдера (fallback для модели шага). */
  defaultModel?: string;
}

/** Зависимости резолвера провайдера агентского шага (точка сборки). */
export interface PipelineStepProviderDeps<TSharedConfig extends PipelineStepProviderConfigLike> {
  /** Дефолтная пара инстанса (ADR-089): runtime-настройка → config. */
  resolveLlmDefaults: () =>
    | PipelineLlmDefaults
    | undefined
    | Promise<PipelineLlmDefaults | undefined>;
  /** Конфиг провайдера по имени (`null` — не настроен/не разрешён политикой). */
  loadProviderConfig: (name: string) => TSharedConfig | undefined | null;
  /** Конфиг инстанса → конфиг ядра (`toCoreProviderConfig`). */
  toProviderConfig: (shared: TSharedConfig, model: string) => ProviderConfig;
  /**
   * Создание провайдера. Температура и sampling агента — аргументами:
   * наблюдаемый контракт фабрики (`ProviderFactory.create`).
   */
  createProvider: (
    name: string,
    config: ProviderConfig,
    temperature?: number,
    topP?: number,
    topK?: number,
  ) => BaseProvider;
  /** Обёртка в `GatewayProvider` (ADR-036) — единственная точка LLM-вызова. */
  wrapProvider?: (provider: BaseProvider) => BaseProvider;
}

/** `AgentDefinition`-поля, влияющие на провайдера шага (структурный тип). */
export type PipelineStepAgentProviderFields = Pick<
  AgentDefinition,
  'provider' | 'model' | 'temperature' | 'topP' | 'topK'
>;

/**
 * Резолвинг провайдера агентского шага: агент → дефолты инстанса.
 *
 * Возвращает `null`, если провайдер не задан или не настроен — шаг падает с
 * `pipeline.provider_not_found` (поведение прежнее). Ошибка сборки провайдера
 * наружу не выходит: она тоже означает «провайдер не собран».
 */
export async function resolvePipelineStepProvider<TSharedConfig extends PipelineStepProviderConfigLike>(
  ctx: Pick<StepExecutionContext, 'step'>,
  deps: PipelineStepProviderDeps<TSharedConfig>,
): Promise<BaseProvider | null> {
  try {
    const agent = ctx.step?.agent as PipelineStepAgentProviderFields | undefined;
    const defaults = await deps.resolveLlmDefaults();

    // Пустая строка в конфиге агента — «не задано» (паритет с `task`).
    const agentProvider = agent?.provider?.trim() || undefined;
    const providerName = agentProvider ?? defaults?.provider?.trim();
    if (!providerName) return null;

    const sharedConfig = deps.loadProviderConfig(providerName);
    if (!sharedConfig) return null;

    // Модель: агент → дефолт инстанса (только для его же провайдера) → дефолт
    // провайдера.
    const defaultsProvider = defaults?.provider?.trim();
    const inheritDefaultsModel = !agentProvider || agentProvider === defaultsProvider;
    const model =
      agent?.model?.trim() ||
      (inheritDefaultsModel ? defaults?.model?.trim() : undefined) ||
      sharedConfig.defaultModel?.trim() ||
      '';

    // Sampling агента: `0`/отрицательное — «не задано» (как у `task`).
    const topP = agent?.topP && agent.topP > 0 ? agent.topP : undefined;
    const topK = agent?.topK && agent.topK > 0 ? agent.topK : undefined;

    const created = deps.createProvider(
      providerName,
      deps.toProviderConfig(sharedConfig, model),
      agent?.temperature,
      topP,
      topK,
    );
    return deps.wrapProvider ? deps.wrapProvider(created) : created;
  } catch {
    // Провайдер не собран — шаг упадёт с `pipeline.provider_not_found`.
    return null;
  }
}
