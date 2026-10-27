/**
 * ADR-101 (Pipeline Engine): внутренние типы движка пайплайнов.
 *
 * Контракты (спецификация, узлы, результат шага, прогон, журнал) живут в
 * `@itphx/synth-shared` (`types/pipeline-engine.ts`) — здесь только то, что
 * нужно **движку**: контекст исполнения шага, контракт исполнителя, зависимости
 * и точки расширения (выходы пайплайна).
 *
 * Модуль не знает про HTTP/сессии/очередь — только про порты слоя хранения
 * (ADR-096) и исполнителей шагов (ADR-101 §1).
 */
import type {
  PipelineExit,
  PipelineMode,
  PipelineNode,
  PipelineNodeKind,
  PipelineRunTrigger,
  PipelineSpec,
  StepResult,
  PipelineArtifact,
} from '@itphx/synth-shared';
import type { AttachmentFamily, AttachmentModality } from '@itphx/synth-shared';
import type { EventType } from '@itphx/synth-shared';
import type { BaseProvider } from '../../providers/base.js';
import type { PipelineMetricsHooks } from '../../metrics/collectors/pipelines.js';
import type { AttachmentService } from '../attachments/service.js';
import type { PipelineArtifactStore } from './artifacts.js';
import type {
  PipelineRunRecord,
  PipelineRunRepository,
  ProjectPipelineRepository,
} from '../../storage/ports/index.js';
import type { SystemPromptComposer } from '../context/composer.js';
import type { PipelineStepContext, PipelineStepContextDeps } from './step-context.js';

/**
 * Машиночитаемые коды ошибок движка пайплайнов (латница, ADR-101).
 *
 * Обязательный набор (задан планом этапа Э3): `pipeline.not_found`,
 * `pipeline.not_published`, `pipeline.invalid_spec`, `pipeline.loop_limit`,
 * `pipeline.cancelled`, `pipeline.executor_missing`, `pipeline.gate_rejected`,
 * `pipeline.step_failed`. Дополнительно введены коды состояний, которых в
 * обязательном наборе не было, но которые невозможно честно закрыть одним из
 * существующих: `pipeline.run_not_found` (прогон не найден), `pipeline.invalid_state`
 * (возобновление прогона не в состоянии `awaiting_human`), `pipeline.gate_timeout`
 * (истекло время ожидания человека), `pipeline.step_timeout` (истёк таймаут шага).
 *
 * Э4.2 добавил коды исполнителей шагов: `pipeline.tool_not_found` (инструмента
 * нет в реестре), `pipeline.tool_failed` (тул вернул ошибку), `pipeline.script_failed`
 * (команда завершилась с ненулевым кодом) и `permission.denied` (отказ
 * permission-слоя — эскалация `ask` уходит в human-гейт, а `deny` валит шаг).
 *
 * Э4.3 (исполнитель вида `agent`) добавил: `pipeline.agent_unavailable`
 * (LLM-контур не настроен — нет сборщика системного промпта),
 * `pipeline.provider_not_found` (провайдер шага не собран), `pipeline.llm_failed`
 * (ошибка LLM-вызова, повтор возможен) и `pipeline.llm_unrecoverable`
 * (ошибка LLM-вызова, повтор не поможет — auth/model/context-length).
 *
 * Э4.3b (Tool-Use-цикл агентского шага) добавил: `pipeline.agent_iterations`
 * (исчерпан лимит итераций Tool-Use-цикла — модель не привела к ответу).
 *
 * Управление прогонами (`run-control.ts`) добавило: `pipeline.already_running`
 * (по пайплайну уже исполняется прогон — soft-lock: второй прогон не
 * запускается).
 */
export const PIPELINE_ERROR_CODES = [
  'pipeline.not_found',
  'pipeline.not_published',
  'pipeline.invalid_spec',
  'pipeline.loop_limit',
  'pipeline.cancelled',
  'pipeline.executor_missing',
  'pipeline.gate_rejected',
  'pipeline.gate_timeout',
  'pipeline.step_failed',
  'pipeline.step_timeout',
  'pipeline.run_not_found',
  'pipeline.invalid_state',
  'pipeline.tool_not_found',
  'pipeline.tool_failed',
  'pipeline.script_failed',
  'permission.denied',
  'pipeline.agent_unavailable',
  'pipeline.provider_not_found',
  'pipeline.llm_failed',
  'pipeline.llm_unrecoverable',
  'pipeline.agent_iterations',
  // Управление прогонами (ADR-101, run-control): по пайплайну уже исполняется
  // прогон — второй не запускается (soft-lock, анти-«запусти 50 прогонов»).
  'pipeline.already_running',
] as const;

/** Код ошибки движка пайплайнов (см. `PIPELINE_ERROR_CODES`). */
export type PipelineErrorCode = (typeof PIPELINE_ERROR_CODES)[number];

/**
 * Ошибка движка пайплайнов — машинночитаемый код + локализуемое сообщение.
 *
 * Сообщение формируется через `t()` (ключ `shared/i18n`, ADR-041), поэтому
 * ошибки движка не содержат «сырых» строк вне словаря.
 */
export class PipelineEngineError extends Error {
  /** Машиночитаемый код ошибки. */
  readonly code: PipelineErrorCode;

  constructor(code: PipelineErrorCode, message: string) {
    super(message);
    this.name = 'PipelineEngineError';
    this.code = code;
  }
}

/**
 * Дефолтные `provider`/`model` инстанса для шага пайплайна (ADR-089).
 *
 * Тот же seam, что у funnel'а сессий (`deps.resolveLlmDefaults`): источник
 * задаёт потребитель — standalone core (`llm.defaultProvider`/`llm.defaultModel`),
 * managed backend — свой. Пустые поля трактуются как «не задано».
 */
export interface PipelineLlmDefaults {
  /** Имя провайдера инстанса. */
  provider?: string;
  /** Имя модели инстанса. */
  model?: string;
}

/**
 * LLM-контур шага (ADR-101 §4) — то, что нужно исполнителю вида `agent`.
 *
 * Прокидывается **движком** в `StepExecutionContext.llm` из
 * `PipelineEngineDeps`: шаг не знает, откуда взялся провайдер (конфиг,
 * роутер, реестр моделей) — это забота точки сборки. Единственная
 * разрешённая точка LLM-вызова — `GatewayProvider` (ADR-036), поэтому
 * резолвер обязан вернуть провайдер **уже обёрнутым** в gateway.
 */
export interface PipelineStepLlmRuntime {
  /** Сборщик системного промпта (ADR-070) — единственная точка сборки. */
  composer: SystemPromptComposer;
  /**
   * Провайдер шага (обёрнут в `GatewayProvider`, ADR-036).
   *
   * Резолвер получает контекст шага: режим, агент и вход могут влиять на
   * выбор модели. `null`/`undefined` — провайдер не настроен (шаг падает с
   * `pipeline.provider_not_found`).
   */
  resolveProvider: (
    ctx: StepExecutionContext,
  ) => Promise<BaseProvider | null> | BaseProvider | null;
  /**
   * Дефолтные `provider`/`model` инстанса (ADR-089) — диагностика шага и
   * сообщение об ошибке. Провайдер собирает `resolveProvider`.
   */
  resolveLlmDefaults?: () => PipelineLlmDefaults | Promise<PipelineLlmDefaults>;
}

/**
 * Обработчик вложения aux-моделью семейства (ADR-115) для шага пайплайна.
 *
 * Вызывается, когда модель шага **не принимает** модальность вложения: вместо
 * байтов в текст шага попадает результат обработки. Вызов LLM — только через
 * `GatewayProvider` (ADR-036), поэтому провайдер приходит из точки сборки.
 */
export type PipelineAttachmentDerive = (input: {
  /** Путь объекта в blob-хранилище. */
  blobPath: string;
  /** MIME-тип содержимого. */
  mime: string;
  /** Имя файла (если известно). */
  name?: string;
  /** Семейство вложения (`image`/`pdf`/`audio`/`video`). */
  family: AttachmentFamily;
  /** Язык шага (промпт обработки). */
  language?: 'ru' | 'en';
}) => Promise<string | null>;

/**
 * Инфраструктура вложений шага (ADR-115 × ADR-101).
 *
 * Собирается **движком** из `PipelineEngineDeps` и кладётся в контекст шага:
 * исполнитель вида `agent` читает объекты вложений/артефактов, а параметры
 * гидратации (модальности модели, derive, шаблон пометок) задаёт точка сборки.
 * Не задана — шаг работает без вложений (прежнее поведение).
 */
export interface PipelineStepAttachments {
  /** Сервис вложений: чтение объектов `attachments/…` (ADR-115). */
  service?: AttachmentService;
  /** Хранилище артефактов прогона: чтение объектов `artifacts/…` (ADR-116). */
  artifacts?: PipelineArtifactStore;
  /**
   * Модальности модели шага из конфига модели инстанса. Не задано —
   * модальности неизвестны, фильтра нет (как у сессии: ошибку типа вернёт
   * провайдер).
   */
  resolveModalities?: (provider: string, model: string) => readonly AttachmentModality[] | undefined;
  /** Обработка вложения aux-моделью (text-only модель шага). */
  derive?: PipelineAttachmentDerive;
  /** Шаблон блока «вложения не доставлены» (`prompts/system/ATTACHMENTS_DROPPED`). */
  noticeTemplate?: (language: string) => string;
  /** Предел суммарного base64 на шаг (по умолчанию — как у сессии, 20 МиБ). */
  maxTotalBase64Bytes?: number;
}

/**
 * Контекст исполнения шага — всё, что нужно исполнителю (ADR-101 §1).
 *
 * Вход шага (`input`) — **результат маппинга**, а не «вся история»: пути
 * `node.input` плюс явно объявленные переменные (`spec.vars`).
 */
export interface StepExecutionContext {
  /** Идентификатор прогона. */
  runId: string;
  /** Идентификатор пайплайна. */
  pipelineId: string;
  /** Версия спецификации, по которой идёт прогон. */
  version: number;
  /** Исполняемый узел (спецификация целиком — в `spec`). */
  node: PipelineNode;
  /** Снимок спецификации прогона (прогон самодостаточен). */
  spec: PipelineSpec;
  /** Проект-владелец прогона (ADR-014), если задан. */
  projectId?: string;
  /** Триггер прогона (payload уже санитизирован). */
  trigger: PipelineRunTrigger;
  /** Маппинг входа шага (путь/имя → значение). */
  input: Record<string, unknown>;
  /** Разрешённые переменные спецификации (`spec.vars`). */
  vars: Record<string, unknown>;
  /** Результат предыдущего шага (источник `prev.output.*`). */
  prev?: StepResult;
  /** Сигнал отмены шага (отмена прогона + таймаут шага). */
  signal: AbortSignal;
  /** Номер попытки (нумерация с 1). */
  attempt: number;
  /** Режим пайплайна (`plan`/`act`/`yolo`) — применяет permission-слой. */
  mode: PipelineMode;
  /**
   * Контекст шага (ADR-101 §10): проект, рабочий каталог, режим, тулы,
   * MCP-скоуп, инструкции и скиллы. Собирается движком один раз на шаг и
   * кладётся в контекст — исполнители берут из него инструменты и окружение.
   */
  step?: PipelineStepContext;
  /**
   * LLM-контур шага (ADR-101 §4): сборщик системного промпта и резолвер
   * провайдера. Задаётся **движком** из `PipelineEngineDeps`; не задан —
   * исполнитель вида `agent` падает с `pipeline.agent_unavailable`.
   */
  llm?: PipelineStepLlmRuntime;
  /**
   * Вложения шага (ADR-115 × ADR-101): чтение объектов вложений прогона и
   * артефактов шагов, модальности модели шага и обработчик derive. Задаётся
   * **движком** из `PipelineEngineDeps`; не задан — вложений в шаге нет.
   */
  attachments?: PipelineStepAttachments;
  /**
   * Решение оператора по гейту (ADR-101 §6). Задаётся **только** при повторном
   * исполнении узла после `resume`: исполнитель не запрашивает гейт заново, а
   * применяет решение оператора (одобрение/отклонение).
   */
  gateDecision?: PipelineGateDecision;
  /**
   * Данные гейта, на котором прогон стоял (ADR-101 §6): восстанавливаются
   * движком из журнала прогона (`gate.awaiting`) при `resume`.
   *
   * Исполнитель использует их, чтобы применить решение оператора **к тому же**
   * вызову инструмента (имя + аргументы), а не к произвольному.
   */
  gate?: PipelineGate;
  /**
   * Обработчик активного таймаута гейта (ADR-101 §6): исполнитель, у которого
   * гейт имеет `timeoutSec`, по истечении времени вызывает колбэк с готовым
   * результатом шага (`pipeline.gate_timeout`). Движок продолжает прогон по
   * условиям перехода или завершает его.
   */
  onGateTimeout?: (gate: PipelineGate, result: StepResult) => void;
}

/**
 * Вид гейта пайплайна (ADR-101 §6):
 * - `tool_approval` — эскалация `ask`-политики permission-слоя: нужно одобрение
 *   инструмента оператором (наблюдателя-сессии у пайплайна нет);
 * - `human` — вопрос human-шага (HITL).
 */
export type PipelineGateKind = 'tool_approval' | 'human';

/**
 * Данные гейта — что оператору нужно для решения (ADR-101 §6).
 *
 * Гейт **не меняет** контракт `StepResult` из `@itphx/synth-shared`: это
 * расширение уровня ядра (движок умеет остановиться на произвольном узле и
 * продолжить прогон с него).
 */
export interface PipelineGate {
  /** Вид гейта. */
  kind: PipelineGateKind;
  /** Узел, на котором прогон встал на паузу. */
  nodeId: string;
  /** Инструмент (для `tool_approval`). */
  toolName?: string;
  /** Аргументы инструмента (для `tool_approval`). */
  args?: Record<string, unknown>;
  /** Вопрос оператору (для `human`). */
  question?: string;
  /** Заголовок узла (для `human`). */
  title?: string;
  /** Таймаут ожидания оператора (секунды). */
  timeoutSec?: number;
  /** Причина эскалации (решение permission-слоя). */
  reason?: string;
}

/**
 * Исход шага-паузы: исполнитель просит решения человека.
 *
 * Отличается от `StepResult` наличием поля `gate` — по нему движок узнаёт, что
 * прогон надо поставить на паузу (`awaiting_human`), а не считать шаг
 * завершённым.
 */
export interface StepGateOutcome {
  /** Маркер исхода-паузы. */
  kind: 'gate';
  /** Данные гейта. */
  gate: PipelineGate;
}

/**
 * Исход шага: либо результат (`StepResult`), либо запрос решения человека.
 *
 * Расширение `StepResult` держится в ядре (ADR-101 §3 — контракт `shared`
 * зафиксирован и не меняется).
 */
export type StepOutcome = StepResult | StepGateOutcome;

/** Проверка: исход шага — запрос паузы (а не результат). */
export function isStepGateOutcome(outcome: StepOutcome | undefined): outcome is StepGateOutcome {
  return !!outcome && typeof outcome === 'object' && 'gate' in outcome;
}

/**
 * Исполнитель шага — контракт исполнения узла пайплайна (ADR-101 §4).
 *
 * Исполнитель выбирается по виду узла (`kind`): `agent`/`script`/`tool`
 * реализуются в Э4, `human` обрабатывается движком как HITL-гейт (Э3/Э4).
 * Движок **не** знает, как именно исполняется шаг: он строит контекст, отдаёт
 * его исполнителю и получает исход — результат либо запрос паузы (гейт).
 */
export interface StepExecutor {
  /** Вид узла, который исполняет исполнитель. */
  kind: PipelineNodeKind;
  /**
   * Исполнение шага; бросок исключения — ошибка шага (`pipeline.step_failed`).
   * Исход-пауза (`StepGateOutcome`) — прогон встаёт на ожидание решения.
   */
  execute(ctx: StepExecutionContext): Promise<StepOutcome>;
}

/**
 * Контекст обработчика выхода пайплайна (ADR-101 §9).
 *
 * В Э3 выходы **не исполняются**: движок только фиксирует, какие выходы
 * сработали, и отдаёт контекст обработчикам. Реальные действия (создание
 * сессии, запись файла, публикация в шлюз) подключаются в Э5.
 */
export interface PipelineExitContext {
  /** Идентификатор прогона. */
  runId: string;
  /** Идентификатор пайплайна. */
  pipelineId: string;
  /** Версия спецификации. */
  version: number;
  /** Проект-владелец прогона (если задан). */
  projectId?: string;
  /** Выход из спецификации (`spec.exits[i]`). */
  exit: PipelineExit;
  /** Снимок спецификации прогона. */
  spec: PipelineSpec;
  /** Триггер прогона. */
  trigger: PipelineRunTrigger;
  /** Выход последнего шага (`prev.output`). */
  output: Record<string, unknown>;
  /** Разрешённые переменные спецификации. */
  vars: Record<string, unknown>;
}

/**
 * Публикатор **инстансных** событий (ADR-101 §2.12) — минимальный контракт
 * шины, который нужен движку.
 *
 * Прогон пайплайна — не сессия (ADR-101 §1), поэтому его события публикуются
 * в отдельный инстансный канал существующей шины (`EventBus.publishInstance`):
 * их видят глобальные подписчики (SSE-хаб `GET /api/v2/events`, watch-all
 * клиенты managed-хаба, движок webhooks), а per-session подписки — нет.
 * Новый транспортный канал не заводится (ADR-024/ADR-089).
 */
export interface PipelineEventPublisher {
  /** Публикация инстансного события (тип — из контракта `EventType`). */
  publishInstance(type: EventType, data?: Record<string, unknown>): void;
}

/**
 * Результат обработки выхода пайплайна (ADR-101 §9, ADR-116).
 *
 * Обработчик может вернуть артефакты, произведённые выходом (выход `file`
 * кладёт байты в blob-порт и возвращает `kind: 'blob'`). Движок складывает их
 * в результат выхода в журнале прогона и в событие `pipeline.run.finished` —
 * UI и агент видят ссылки, не читая workspace.
 */
export interface PipelineExitResult {
  /** Артефакты, произведённые выходом (необязательно). */
  artifacts?: PipelineArtifact[];
}

/**
 * Обработчик выхода пайплайна — **точка расширения** движка (ADR-101 §9).
 *
 * В Э3 используется no-op реализация: выходы фиксируются в журнале прогона,
 * но не исполняются. Э5 подключает реальные обработчики, не меняя движок.
 */
export interface PipelineExitHandler {
  /**
   * Обработка выхода пайплайна.
   *
   * Возврат `void` — прежнее поведение (артефактов нет); `PipelineExitResult`
   * — выход сообщает, что произвёл (ADR-116: артефакты прогона).
   */
  handle(ctx: PipelineExitContext): Promise<PipelineExitResult | void> | PipelineExitResult | void;
}

/** No-op обработчик выхода (значение по умолчанию в Э3). */
export class NoopPipelineExitHandler implements PipelineExitHandler {
  handle(_ctx: PipelineExitContext): void {
    // Выходы в Э3 не исполняются (Э5 подключит реальные обработчики).
  }
}

/** Логгер движка (совместим с `logger.ts` ядра; по умолчанию — он же). */
export interface PipelineEngineLogger {
  /** Информационное сообщение. */
  info(group: string, message: string): void;
  /** Предупреждение. */
  warning(group: string, message: string): void;
  /** Ошибка. */
  error(group: string, message: string): void;
}

/**
 * Зависимости движка пайплайнов (ADR-101).
 *
 * Порты и исполнители — обязательны; остальное — опционально (движок работает
 * и без проектного окружения). Зависимости контекста шага (проекты, реестр
 * инструментов, MCP, резолвер инструкций, реестр агентов, каталог скиллов) —
 * те же объекты, что собираются в `server/app/deps.ts`.
 */
export interface PipelineEngineDeps extends PipelineStepContextDeps {
  /** Порт спецификаций пайплайнов (черновик + опубликованные версии). */
  pipelines: ProjectPipelineRepository;
  /** Порт прогонов и журнала выполнения. */
  runs: PipelineRunRepository;
  /** Исполнители шагов (по виду узла). */
  executors: StepExecutor[];
  /** Обработчики выходов пайплайна (Э3 — no-op). */
  exits?: PipelineExitHandler[];
  /** Логгер (по умолчанию — логгер ядра). */
  logger?: PipelineEngineLogger;
  /** Пауза между попытками ретрая (в тестах — мгновенная). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Сборщик системного промпта шага (ADR-070) — для исполнителя вида
   * `agent`. Не задан — agent-шаги падают с `pipeline.agent_unavailable`.
   */
  composer?: SystemPromptComposer | null;
  /**
   * Провайдер LLM-вызова шага (ADR-036) — **обёрнутый в `GatewayProvider`**.
   *
   * Резолвер получает контекст шага (режим/агент/вход): модель может
   * зависеть от узла. `null` — провайдер не настроен.
   */
  resolveProvider?: (
    ctx: StepExecutionContext,
  ) => Promise<BaseProvider | null> | BaseProvider | null;
  /**
   * Дефолтные `provider`/`model` инстанса (ADR-089) — тот же seam, что у
   * funnel'а сессий.
   */
  resolveLlmDefaults?: () => PipelineLlmDefaults | Promise<PipelineLlmDefaults>;
  /**
   * ADR-115 × ADR-101: сервис вложений — чтение объектов вложений прогона
   * (`attachments/…`) исполнителем вида `agent` и источник лимитов.
   *
   * Не задан — вложения шагу не доставляются (шаг работает как раньше), а
   * ссылки на вложения в тексте шага помечаются как не доставленные.
   */
  attachments?: AttachmentService | null;
  /**
   * ADR-116 × ADR-101: хранилище артефактов прогона — blob-объекты предыдущих
   * шагов (`StepResult.artifacts` с `kind: 'blob'`) как вложения шага.
   */
  artifacts?: PipelineArtifactStore | null;
  /**
   * ADR-115: модальности модели шага — из конфига модели инстанса. Не задано —
   * модальности неизвестны, гидратация их не фильтрует.
   */
  resolveModalities?: (provider: string, model: string) => readonly AttachmentModality[] | undefined;
  /**
   * ADR-115 × ADR-101: обработка вложения aux-моделью (text-only модель шага).
   * Не задано — вложение не доставляется, модель видит пометку.
   */
  deriveAttachment?: PipelineAttachmentDerive | null;
  /**
   * ADR-115: шаблон блока «вложения не доставлены» для языка шага
   * (`prompts/system/ATTACHMENTS_DROPPED.{lang}.md`). Не задан — техническая
   * строка на английском (канал LLM, ADR-041).
   */
  attachmentsNoticeTemplate?: (language: string) => string;
  /**
   * Шина инстансных событий (ADR-101 §2.12) — движок публикует в неё
   * `pipeline.run.*` (старт/финиш прогона, шаг, ожидание человека, ошибка).
   *
   * Не задана — события не публикуются (движок работает и без шины).
   */
  eventBus?: PipelineEventPublisher | null;
  /**
   * Метрики прогонов (ADR-094, `synth_pipeline_*`) — колбэки движка.
   *
   * Не заданы — метрики не пишутся (реестр пуст, `/metrics` → 404).
   */
  metrics?: PipelineMetricsHooks | null;
}

/** Опции запуска прогона. */
export interface PipelineRunOptions {
  /** Идентификатор пайплайна. */
  pipelineId: string;
  /** Версия спецификации (по умолчанию — последняя опубликованная). */
  version?: number;
  /** Триггер прогона. */
  trigger: PipelineRunTrigger;
  /** Проект-владелец прогона. */
  projectId?: string;
  /** Сигнал отмены прогона. */
  signal?: AbortSignal;
  /**
   * ADR-101: колбэк «прогон стартовал» — вызывается сразу после сохранения
   * записи прогона и **до** исполнения узлов. Нужен вызывающему, чтобы узнать
   * id прогона, не дожидаясь конца (шедулер запускает прогон в фоне).
   */
  onStarted?: (run: PipelineRunRecord) => void;
}

/** Решение человека по HITL-гейту (возобновление прогона). */
export interface PipelineGateDecision {
  /** Одобрение (`true`) или отклонение (`false`). */
  approved: boolean;
  /** Данные, переданные шагом дальше (выход гейта). */
  output?: Record<string, unknown>;
  /** Комментарий человека (пишется в журнал прогона). */
  comment?: string;
}

/**
 * Контекст разрешения путей прогона — данные, доступные условиям и маппингу.
 *
 * Поддерживаемые корни (см. `paths.ts`): `prev.output.*`, `prev.status`,
 * `prev.error.code`, `trigger.payload.*`, `trigger.kind|source|type`, `vars.*`.
 */
export interface PipelinePathContext {
  /** Результат предыдущего (или текущего) шага. */
  prev?: StepResult;
  /** Триггер прогона. */
  trigger: PipelineRunTrigger;
  /** Разрешённые переменные спецификации (`spec.vars`). */
  vars: Record<string, unknown>;
}

/**
 * Контекст вычисления условия — тот же набор данных, что и для маппинга
 * (условия и маппинг читают одни и те же пути прогона).
 */
export type ConditionContext = PipelinePathContext;
