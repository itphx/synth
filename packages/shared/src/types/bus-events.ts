// --- Event types ---
import type { WorktreeUpdateAction } from './worktree.js';
import type {
  MessageAcceptedPayload,
  QueueStatePayload,
  MessageDeliveredPayload,
  MessageEnqueuedPayload,
  TurnStartedPayload,
  TurnFinishedPayload,
  StepStartedPayload,
  StepFinishedPayload,
  StepToolsPayload,
  PartDeltaPayload,
  PartUpdatedPayload,
} from './message-stream.js';

export type EventType =
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'session.renamed'
  | 'session.forked'
  | 'session.fork.created'
  | 'session.reference.added'
  | 'session.reference.removed'
  | 'session.messages.merged'
  // История сессии очищена (`POST /sessions/:id/clear`): остались только
  // закреплённые сообщения, очередь и счётчики сброшены. Канал сессии.
  | 'session.messages.cleared'
  | 'session.moved'
  | 'project.updated'
  // Проект удалён (`DELETE /projects/:id`): публикуется в каналы его сессий
  // **до** удаления, пока состав сессий ещё перечисляется.
  | 'project.deleted'
  // ADR-114: инвентарь git-worktree проекта изменился (создан/удалён/
  // привязан/отвязан). Событие — в существующей шине (ADR-024), новых
  // транспортных каналов нет.
  | 'worktree.updated'
  | 'fs.changed'
  | 'message.added'
  | 'message.updated'
  // ADR-118 §4: события модели «ход как последовательность шагов».
  // `message.accepted` — адресное (по `BusEvent.recipient`), `queue.state` —
  // счётчики очереди без текста и автора, `message.delivered` — материализация
  // сообщения в истории, `turn.*`/`step.*`/`part.*` — состояние работы агента
  // (канал сессии). Удалённые без dual-emit события v1 (`stream.chunk`,
  // `stream.usage`, `stream.done`, `stream.interrupted`, `message.injected`,
  // `message.queued`) заменены этими — см. таблицу ADR-118 §«Удаляемые
  // события и их замена».
  | 'message.accepted'
  | 'queue.state'
  | 'message.delivered'
  // ADR-118 §4 (аддитивно): сообщение поставлено в очередь/очередь
  // вмешательств и ждёт материализации. Адресное событие со **снимком**
  // сообщения — чтобы лента показала реплику сразу, не дожидаясь
  // `message.delivered` (материализации в истории). `ord` у снимка нет:
  // он выдаётся только при записи в историю.
  | 'message.enqueued'
  // ADR-118 §4/§7: сообщение удалено из истории (`DELETE /messages/:sessionId/:messageId`
  // и batch `action: 'delete'`). Событие — в канале сессии, адресация по `id`
  // (мутации адресуются по id, §7); клиенты убирают сообщение из ленты.
  | 'message.deleted'
  // ADR-126 §2: сообщение адресовано пользователю (`@user`) — уведомление
  // и бейдж. Событие **не** создаёт ход; payload — id сообщения, список
  // упомянутых пользователей и id сессии.
  | 'message.mentioned'
  | 'turn.started'
  | 'turn.finished'
  | 'step.started'
  | 'step.finished'
  // ADR-118 §4 (аддитивно): исполнение инструментов шага. `step.finished` —
  // «вызов LLM завершён», `step.tools.*` — «выполняются вызовы этого шага».
  | 'step.tools.started'
  | 'step.tools.finished'
  | 'part.delta'
  | 'part.updated'
  // ADR-104: форсированная отправка сообщения во время хода (steering).
  // `steer.dropped` — сообщение отброшено (лимит инъекций на ход).
  | 'steer.dropped'
  | 'child.message.added'
  | 'child.session.updated'
  | 'stream.start'
  | 'stream.ended'
  | 'stream.cancelled'
  | 'stream.error'
  | 'stream.retry'
  | 'queue.stalled'
  | 'permission.asked'
  | 'permission.replied'
  | 'permission.hold'
  | 'question.asked'
  | 'question.replied'
  | 'context.summarization_pending'
  | 'context.summarization_applied'
  // Провал сжатия контекста (ADR-128): сжатие не состоялось — ответ модели
  // не прошёл валидацию, сжатия было нечего делать или вызов упал. Payload:
  // `reason` (`validation`|`error`|`no_coverage`|`overflow`), `message`
  // (локализованный текст ошибки), `mode`, `phase?` (`mid_turn`|`overflow`).
  | 'context.summarization_failed'
  | 'context.summarized'
  | 'context.sliding_window_applied'
  | 'context.limit_warning'
  | 'context.sticky_note_added'
  | 'context.sticky_note_updated'
  | 'context.sticky_note_deleted'
  | 'context.instructions_loaded'
  | 'tool_call.started'
  | 'tool_call.result'
  | 'tool_call.loop'
  | 'subagent.progress'
  | 'subagent.retry'
  | 'subagent.resume.started'
  | 'subagent.resume.finished'
  | 'permission.asked'
  | 'permission.replied'
  | 'permission.denied'
  | 'message.quality_check'
  | 'session.routing_category'
  | 'plan.approved'
  // ADR-039/ADR-118 §4: план проекта изменён (`plan_write`) — клиенты
  // перечитывают сессию (полный refresh). Канал сессии.
  | 'plan.updated'
  | 'todos.updated'
  | 'skill.invoked'
  | 'command.invoked'
  | 'command.inline_shell'
  | 'event.received'
  | 'event.routed'
  | 'binding.changed'
  // ADR-101 (Pipeline Engine): прогон пайплайна — инстансное собыдение
  // (не сессионное), публикуется в существующей шине; новых каналов нет.
  | 'pipeline.run.started'
  | 'pipeline.run.node_started'
  | 'pipeline.run.node_finished'
  | 'pipeline.run.awaiting_human'
  | 'pipeline.run.finished'
  | 'pipeline.run.failed'
  // ADR-101: выход пайплайна вида `gateway` — публикация наружу (ADR-052/ADR-087).
  | 'pipeline.completed'
  // ADR-101 (авторство) × ADR-118 (инвариант 27): **сущность** пайплайна
  // проекта изменилась — создан/сохранён черновик, опубликована версия,
  // пайплайн удалён или инстанцирован из шаблона. Пайплайн — ресурс
  // **проекта**, поэтому событие идёт в каналы **сессий проекта** (тем же
  // путём, что `worktree.updated`/`project.updated`), а не в инстансный канал:
  // инстансный в managed не доходит до обычного USER (он видит только каналы
  // своих сессий). Прогоны — отдельные события `pipeline.run.*` (инстансный
  // канал). Payload минимальный — только id и вид мутации: спецификация
  // (черновик, `vars`) тяжёлая и в событие не попадает.
  | 'pipeline.updated'
  // Реестр агентов инстанса изменился (создан/обновлён/удалён/включён-выключен;
  // HTTP-роуты и тулы `synth_agent_*`). Инстансный канал шины (ADR-118);
  // реагируют админ-панель «Агенты» и селекты агента (чат/настройки/аналитика):
  // перечитывают состав без перезагрузки страницы. Payload — только id и вид
  // мутации: текст роли и capabilities тяжёлые, в событие не попадают.
  | 'agents.updated'
  // Реестр MCP-серверов инстанса изменился (добавлен/обновлён/удалён/включён-
  // выключен; HTTP-роуты `/mcp/*` и тулы `synth_mcp_*` из чата). Инстансный
  // канал шины (ADR-118); реагируют панели MCP (админская/пользовательская,
  // «Внешние доступы») и селекторы MCP-серверов: перечитывают состав без
  // перезагрузки страницы. Payload — только имя, вид мутации и (для уровневой
  // операции) её область: в конфиге MCP бывают секреты (`env`/`headers`),
  // поэтому конфиг в событие не попадает никогда.
  | 'mcp.updated'
  // Реестр скиллов (и бандлов скиллов) инстанса изменился: создан/обновлён/
  // удалён скилл или его supporting-файл, выполнен `reload`, изменены
  // instance-wide гейты/политика либо скоуп проекта/сессии. Инстансный канал
  // шины (ADR-118); реагируют панели скиллов и `$`-пикер в композере:
  // перечитывают состав без перезагрузки страницы. Payload — только имя, вид
  // мутации и (для уровневой операции) её область: тело `SKILL.md`, metadata и
  // supporting-файлы в событие не попадают.
  | 'skills.updated'
  // Каталог провайдеров/моделей инстанса изменился (провайдер создан/изменён/
  // удалён, модель сохранена/удалена/назначена по умолчанию, каталог
  // синхронизирован с провайдером). Каталог — ресурс **инстанса**, поэтому
  // событие идёт в инстансный канал шины (ADR-118; новых транспортных каналов
  // не заводим, инвариант 6 `AGENTS.md`). Реагируют селект модели в чате,
  // админ-панели моделей/провайдеров: перечитывают каталог без перезагрузки
  // страницы. Payload — только провайдер, id модели и вид мутации:
  // **ключи/URL провайдеров в событие не попадают никогда** — в них бывают
  // секреты (инвариант 13 `AGENTS.md`).
  | 'models.updated'
  // Каталог профилей исполнения (ADR-135) изменился: профиль сохранён/удалён,
  // runtime-каталог сброшен к config-уровню, пул слит/удалён. Каталог профилей —
  // ресурс **инстанса**, поэтому событие идёт в инстансный канал шины (ADR-118;
  // новых транспортных каналов не заводим, инвариант 6 `AGENTS.md`). Реагируют
  // селекторы профиля (агент в админке, проект, сессия) и раздел «Исполнение»:
  // перечитывают каталог без перезагрузки страницы. Payload — только id
  // профиля/имя пула и вид мутации: адреса исполнителей, токены provisioner'а и
  // прочий конфиг в событие не попадают никогда (инвариант 13 `AGENTS.md`).
  | 'execution.updated'
  // Внешние доступы инстанса изменились (ADR-105): доступ выдан/отозван,
  // обновлён токен, изменена привязка к MCP-коннектору. Доступ — ресурс
  // **инстанса** (владелец — пользователь или инстанс), поэтому событие идёт в
  // инстансный канал шины (ADR-118; новых транспортных каналов не заводим,
  // инвариант 6 `AGENTS.md`). Реагирует раздел «Внешние доступы»
  // (`CredentialsSettings`): список и статусы перечитываются без перезагрузки
  // страницы. Payload — только id/провайдер и вид мутации: **токены в событие
  // не попадают никогда** (инвариант 13 `AGENTS.md`), это свойство типа
  // payload'а, а не соглашение вызывающих.
  | 'credentials.updated'
  // Этап 1 roadmap 0.13 (блок 1.3): «вопрос пользователю». Префикс
  // `user_question.*` — намеренно НЕ `question.*`: `question.asked` уже занят
  // смыслом «очередь зависла» (см. выше).
  | 'user_question.asked'
  | 'user_question.answered'
  | 'user_question.cancelled'
  // Этап 1 roadmap 0.13 (блок 1.2): фоновые шелл-процессы (PROP-097).
  | 'process.started'
  | 'process.exited'
  | 'process.stopped'
  // ADR-111 §detach: идущий блокирующий прогон переведён в фон
  // (`POST /sessions/:id/background`). `process.started` публикуется с
  // аддитивным признаком `detached: true` (прогон уже шёл); дедуп тоста
  // «запущен» — на клиенте.
  | 'process.detached'
  // ADR-111 §detach: блокирующие прогоны переведены в фон **автоматически** —
  // пользователь шлёт steer в занятую сессию (`POST /sessions/:id/prompt`).
  // Публикуется только при непустом наборе переведённых прогонов.
  | 'background.auto_detached'
  // Этап 1 roadmap 0.13 (блок 1.2): фоновые дочерние сессии саб-агентов
  // (PROP-096).
  | 'child.started'
  | 'child.completed'
  | 'child.failed'
  | 'child.cancelled'
  // PROP-132 (план терминалов): **метаданные** терминала. Поток вывода
  // терминала по шине НЕ идёт (волатильный класс, отдельный NDJSON-поток
  // `GET /api/v2/terminals/:id/stream`), здесь — только состояние записи.
  // Канал — сессия терминала (у терминала без привязки событий нет: в шине
  // нет канала проекта, а инстансный канал — broadcast всем).
  | 'terminal.created'
  | 'terminal.updated'
  | 'terminal.exited'
  | 'terminal.deleted'
  // PROP-141 (Часть B): таймеры и будильники. События публикуются в **канал
  // сессии** (ADR-009/ADR-024, новых транспортных каналов нет) — по ним
  // второй клиент узнаёт о создании/правке/срабатывании/отмене автоматизации
  // без опроса (панель «Автоматизация» — этап 7).
  | 'timer.created'
  | 'timer.updated'
  | 'timer.fired'
  | 'timer.cancelled'
  | 'timer.deleted'
  | 'error';

export interface BusEvent {
  type: EventType;
  sessionId: string;
  data: Record<string, unknown>;
  timestamp: string;
  /**
   * ADR-118 §4/§«Гибрид и многопользовательский режим»: идентификатор
   * пользователя-получателя (адресная доставка). Поле отсутствует → broadcast
   * в канал сессии; `message.accepted` — адресное событие.
   */
  recipient?: string;
  /**
   * ADR-118 §«Событийная нумерация»: монотонный номер события **в пределах
   * инстанса** (сквозной по всем сессионным каналам) — по нему работает догон
   * (`Last-Event-ID` / `?since`). Инстансный канал (`pipeline.run.*`) номера
   * не получает.
   */
  eventSeq?: number;
}

/**
 * Payload события `worktree.updated` (ADR-114 §6) — инвентарь worktree
 * проекта изменился.
 *
 * Событие идёт в **каналы сессий проекта** (инвентарь — ресурс проекта, а не
 * одной сессии), поэтому подписчики соседних сессий тоже видят изменение.
 * `action` позволяет отличить создание от удаления/привязки без чтения
 * инвентаря; `worktree_id` — конкретная запись (нет — для prune/sweep).
 *
 * Объявлен **type-алиасом** (не интерфейсом): алиас получает неявную
 * index-signature и потомуassignable к `Record<string, unknown>` — payload
 * шины (`EventBus.publish`) именно такой тип.
 */
export type WorktreeUpdatedPayload = {
  /** Проект-владелец инвентаря. */
  project_id: string;
  /** Id записи worktree (не задан — изменение по проекту целиком). */
  worktree_id?: string;
  /** Что произошло (ADR-114 §6). */
  action: WorktreeUpdateAction;
};

// --- ADR-118: payload'ы новых событий модели «ход как последовательность шагов ---
//
// Алиасы (не интерфейсы): алиас объекта получает неявную index-signature и
// потому assignable к `Record<string, unknown>` — payload шины
// (`EventBus.publish`) именно такой тип. Определения — в
// `./message-stream.js` (browser-safe модуль контракта ADR-118).

/** Payload события `message.accepted` (ADR-118 §4) — адресное событие. */
export type MessageAcceptedEventData = MessageAcceptedPayload;

/** Payload события `queue.state` (ADR-118 §4) — только счётчики. */
export type QueueStateEventData = QueueStatePayload;

/** Payload события `message.delivered` (ADR-118 §4) — материализация в истории. */
export type MessageDeliveredEventData = MessageDeliveredPayload;

/** Payload события `message.enqueued` (ADR-118 §4) — адресное, со снимком сообщения. */
export type MessageEnqueuedEventData = MessageEnqueuedPayload;

/** Payload события `turn.started` (ADR-118 §4) — ход начался. */
export type TurnStartedEventData = TurnStartedPayload;

/** Payload события `turn.finished` (ADR-118 §4) — ход завершён. */
export type TurnFinishedEventData = TurnFinishedPayload;

/** Payload события `step.started` (ADR-118 §4) — шаг начался. */
export type StepStartedEventData = StepStartedPayload;

/** Payload события `step.finished` (ADR-118 §4/§5) — шаг завершён. */
export type StepFinishedEventData = StepFinishedPayload;

/** Payload событий `step.tools.started`/`step.tools.finished` (ADR-118 §4). */
export type StepToolsEventData = StepToolsPayload;

/** Payload события `part.delta` (ADR-118 §4) — дельта части (upsert). */
export type PartDeltaEventData = PartDeltaPayload;

/** Payload события `part.updated` (ADR-118 §4) — часть обновлена (upsert). */
export type PartUpdatedEventData = PartUpdatedPayload;

/** Payload события `message.deleted` (ADR-118 §4/§7) — удалённое сообщение. */
export type MessageDeletedEventData = {
  /** id удалённого сообщения (мутации адресуются по id, ADR-118 §7). */
  message_id: string;
};

/** Payload события `message.updated` (ADR-118 §4) — состояние сообщения изменилось. */
export type MessageUpdatedEventData = {
  /** id изменённого сообщения. */
  message_id: string;
  /** Новое значение `pinned` (событие приходит от pin/batch pin). */
  pinned?: boolean;
  /** Новое значение `disabled` (toggle/batch toggle/retry). */
  disabled?: boolean;
};

/**
 * Payload события `message.mentioned` (ADR-126 §2) — сообщение адресовано
 * пользователю.
 *
 * `user_ids` — участники, которых нужно уведомить: отправитель исключён
 * (self-mention допускается, но уведомление себе не отправляется).
 */
export type MessageMentionedEventData = {
  /** id сообщения, в котором упомянут пользователь. */
  message_id: string;
  /** id упомянутых пользователей (получателей уведомления). */
  user_ids: string[];
  /** id сессии (канал события). */
  session_id: string;
};

/**
 * Вид мутации реестра агентов инстанса — поле `action` события
 * `agents.updated`.
 *
 * - `save` — создание/обновление агента (`POST /agents`, `synth_agent_save`);
 * - `import` — импорт из opencode-подобного markdown (`synth_agent_import`);
 * - `delete` — удалён custom-агент (`DELETE /agents/:id`, `synth_agent_delete`);
 * - `reset` — снят override встроенного агента (builtin восстановлен);
 * - `enable` — переключён признак `enabled` (`PATCH /agents/:id/enabled`,
 *   `synth_agent_enable`).
 */
export type AgentChangeAction = 'save' | 'delete' | 'enable' | 'import' | 'reset';

/**
 * Payload события `agents.updated` — реестр агентов инстанса изменился.
 *
 * Минимальный по построению: id агента и вид мутации. Определение агента
 * (capabilities, роль, модель) в событие не кладётся — клиент перечитывает
 * список своим обычным запросом (`GET /agents`, `GET /agents/all`).
 */
export type AgentsUpdatedEventData = {
  /** Агент, которого коснулась мутация (не задан — изменение реестра целиком). */
  id?: string;
  /** Что произошло. */
  action: AgentChangeAction;
};

/**
 * Вид мутации реестра MCP-серверов инстанса — поле `action` события
 * `mcp.updated`.
 *
 * - `add` — запись добавлена (`POST /mcp/registry`, `synth_mcp_add`);
 * - `update` — запись изменена (`PUT /mcp/registry/:id`, `synth_mcp_update`),
 *   а также смена MCP-скоупа проекта/сессии (`PUT /projects/:id/mcp`,
 *   `PUT /mcp/session/:sessionId`);
 * - `remove` — запись удалена (`DELETE /mcp/registry/:id`, `synth_mcp_remove`);
 * - `enable` — переключён признак `enabled` (уровень инстанса:
 *   `synth_mcp_enable` с `level: 'instance'`);
 * - `import` — импорт набора серверов (installer/аддон);
 * - `policy` — изменена **политика** MCP (`PUT`/`DELETE /settings/mcp-policy`,
 *   `/settings/mcp-network-policy`, `/settings/tools-policy`,
 *   `/settings/tools-disabled`): состав реестра тот же, изменился эффективный
 *   MCP-скоуп — что уходит модели и куда разрешён сетевой доступ.
 */
export type McpChangeAction = 'add' | 'update' | 'remove' | 'enable' | 'import' | 'policy';

/**
 * Область уровневой операции MCP — поле `scope` события `mcp.updated`.
 *
 * Не задана — мутация реестра инстанса как таковая (состав серверов); задана
 * — переключение видимости сервера в конкретной области (`instance`,
 * `project` с `projectId`, `session` с `sessionId`).
 */
export type McpChangeScope = 'instance' | 'session' | 'project';

/**
 * Payload события `mcp.updated` — реестр MCP-серверов инстанса изменился.
 *
 * Минимальный **по построению**: имя сервера, вид мутации и (для уровневой
 * операции) её область. Конфиг сервера (`config`, `env`, `headers`) в событие
 * не кладётся ни при каких условиях — там бывают секреты (инвариант 13
 * `AGENTS.md`); клиент перечитывает реестр своим обычным запросом
 * (`GET /mcp/registry`).
 */
export type McpUpdatedEventData = {
  /** Имя сервера, которого коснулась мутация (не задано — изменение целиком). */
  name?: string;
  /** Что произошло. */
  action: McpChangeAction;
  /** Область уровневой операции (реестр инстанса — не задана). */
  scope?: McpChangeScope;
  /** Сессия, чей MCP-скоуп изменён (`scope: 'session'`). */
  sessionId?: string;
  /** Проект, чей MCP-скоуп изменён (`scope: 'project'`). */
  projectId?: string;
};

/**
 * Вид мутации реестра скиллов — поле `action` события `skills.updated`.
 *
 * - `create` — создан instance-скилл (`POST /skills`) или bundle
 *   (`POST /skill-bundles`, имя — имя бандла);
 * - `update` — изменён скилл (`PATCH /skills/:name` — description/body/
 *   metadata) или bundle (`PATCH /skill-bundles/:name`);
 * - `delete` — удалён скилл (`DELETE /skills/:name`) или bundle
 *   (`DELETE /skill-bundles/:name`);
 * - `reload` — реестр пересканирован (`POST /skills/reload`): состав мог
 *   измениться целиком, конкретного имени нет;
 * - `files` — изменён supporting-файл скилла (`PUT`/`DELETE /skills/:name/files/*`);
 * - `scope` — изменён скоуп видимости (`PUT /sessions/:id/skills`,
 *   `PUT /projects/:id/skills`, `PUT`/`DELETE /settings/skills`): набор
 *   скиллов тот же, изменилось кто/где их видит.
 */
export type SkillChangeAction = 'create' | 'update' | 'delete' | 'reload' | 'files' | 'scope';

/**
 * Область уровневой операции скиллов — поле `scope` события `skills.updated`.
 *
 * Не задана — мутация реестра инстанса как таковая (состав скиллов/бандлов);
 * задана — изменение скоупа в конкретной области (`instance` — instance-wide
 * гейты и политика, `project` с `projectId`, `session` с `sessionId`).
 */
export type SkillChangeScope = 'instance' | 'project' | 'session';

/**
 * Payload события `skills.updated` — реестр скиллов инстанса изменился.
 *
 * Минимальный **по построению**: имя скилла/бандла, вид мутации и (для
 * уровневой операции) её область. Содержимое скилла — тело `SKILL.md`,
 * `metadata` и supporting-файлы — в событие не кладётся ни при каких условиях
 * (инвариант 13 `AGENTS.md`: в скиллах встречаются рецепты с секретами и
 * служебные пути); клиент перечитывает реестр своим обычным запросом
 * (`GET /skills`, `GET /skill-bundles`, `GET /settings/skills`).
 */
export type SkillsUpdatedEventData = {
  /** Имя скилла/бандла, которого коснулась мутация (не задано — изменение целиком). */
  name?: string;
  /** Что произошло. */
  action: SkillChangeAction;
  /** Область уровневой операции (реестр инстанса — не задана). */
  scope?: SkillChangeScope;
  /** Проект, чей скоуп скиллов изменён (`scope: 'project'`). */
  projectId?: string;
  /** Сессия, чей скоуп скиллов изменён (`scope: 'session'`). */
  sessionId?: string;
};

/**
 * Вид мутации каталога провайдеров/моделей — поле `action` события
 * `models.updated`.
 *
 * - `save` — модель сохранена/обновлена (`POST /models`);
 * - `delete` — модель удалена (`DELETE /models/:id`);
 * - `default` — изменена модель по умолчанию инстанса (`POST /models` с
 *   `set_as_default`: сохраняется модель и переключается дефолтная пара);
 * - `fetch` — каталог моделей синхронизирован с провайдером
 *   (`POST /models/fetch`): состав/метаданные моделей могли измениться целиком;
 * - `provider` — провайдер создан/изменён/удалён (`POST /providers`,
 *   `PATCH /providers/:name`, `DELETE /providers/:name`).
 */
export type ModelChangeAction = 'save' | 'delete' | 'default' | 'fetch' | 'provider';

/**
 * Payload события `models.updated` — каталог провайдеров/моделей инстанса
 * изменился.
 *
 * Минимальный **по построению**: провайдер, id модели и вид мутации. Клиент
 * перечитывает каталог своими обычными запросами (`GET /providers`,
 * `GET /models`, `GET /settings/default-model`). Конфиг провайдера (`api_key`,
 * `base_url` — в URL иногда лежит токен) в событие не кладётся ни при каких
 * условиях (инвариант 13 `AGENTS.md`); это свойство типа payload'а, а не
 * соглашение вызывающих.
 */
export type ModelsUpdatedEventData = {
  /** Провайдер, которого коснулась мутация (не задан — изменение целиком). */
  provider?: string;
  /** Имя модели, которой коснулась мутация (не задано — изменение целиком). */
  modelId?: string;
  /** Что произошло. */
  action: ModelChangeAction;
};

/**
 * Вид мутации каталога профилей исполнения — поле `action` события
 * `execution.updated` (ADR-135).
 *
 * - `profile.save` — runtime-каталог сохранён (`PUT /settings/execution`):
 *   профили добавлены/изменены/переименованы (переименование = удаление +
 *   сохранение), изменены дефолты или список отключённых;
 * - `profile.delete` — конкретный профиль удалён (расширение контракта: сейчас
 *   каталог правится целиком через `PUT`, поэтому путь один — `profile.save`,
 *   но клиент различает виды мутации, чтобы не завязываться на «целиком»);
 * - `profile.reset` — runtime-каталог сброшен к config-уровню
 *   (`DELETE /settings/execution`);
 * - `pool.save` — пул появился/изменил состояние;
 * - `pool.delete` — пул слит (`drain`) или удалён (`DELETE /pools/:key`): в
 *   обоих случаях он уходит из активного списка.
 */
export type ExecutionChangeAction =
  | 'profile.save'
  | 'profile.delete'
  | 'profile.reset'
  | 'pool.save'
  | 'pool.delete';

/**
 * Payload события `execution.updated` — каталог профилей исполнения изменился.
 *
 * Минимальный **по построению**: id профиля и/или имя пула + вид мутации. Клиент
 * перечитывает каталог своим обычным запросом (`GET /execution/profiles`,
 * `GET /execution/pools`, `GET /settings/execution`). Адреса исполнителей,
 * токен provisioner'а и прочий конфиг профиля (env, args MCP-серверов) в событие
 * не кладутся ни при каких условиях (инвариант 13 `AGENTS.md`); это свойство
 * типа payload'а, а не соглашение вызывающих.
 */
export type ExecutionUpdatedEventData = {
  /** Профиль, которого коснулась мутация (не задан — изменение каталога целиком). */
  profileId?: string;
  /** Пул, которого коснулась мутация (не задан — профили, не пулы). */
  poolName?: string;
  /** Что произошло. */
  action: ExecutionChangeAction;
};

/**
 * Вид мутации слоя внешних доступов — поле `action` события
 * `credentials.updated` (ADR-105).
 *
 * - `save` — доступ выдан (`POST /oauth/credentials`, завершение authorize или
 *   device flow);
 * - `delete` — доступ отозван (`DELETE /oauth/credentials/:id`);
 * - `refresh` — токен обновлён (`POST /oauth/credentials/:id/refresh`);
 * - `bind` — изменена привязка доступа к MCP-коннектору
 *   (`POST /oauth/credentials/:id/bind`).
 */
export type CredentialChangeAction = 'save' | 'delete' | 'refresh' | 'bind';

/**
 * Payload события `credentials.updated` — внешние доступы инстанса изменились.
 *
 * Минимальный **по построению**: id записи, провайдер и вид мутации. Токены
 * (`access_token`/`refresh_token`), маска секрета и прочие детали записи в
 * событие не кладутся ни при каких условиях (инвариант 13 `AGENTS.md`); клиент
 * перечитывает список своим обычным запросом (`GET /oauth/credentials`).
 */
export type CredentialsUpdatedEventData = {
  /** id записи доступа (не задан — изменение слоя доступов целиком). */
  credentialId?: string;
  /** OAuth-провайдер, которого коснулась мутация. */
  provider?: string;
  /** Что произошло. */
  action: CredentialChangeAction;
};

/** Payload события `session.messages.cleared` — история очищена, кроме закреплённых. */
export type SessionMessagesClearedEventData = {
  session_id: string;
};

/** Payload событий `project.updated`/`project.deleted` — проект сессии изменился. */
export type ProjectChangedEventData = {
  project_id: string;
};

// --- ADR-101 (авторство): сущность пайплайна проекта -------------------------
//
// Пайплайн — ресурс **проекта** (ADR-014), поэтому событие изменения его
// сущности идёт в каналы сессий проекта, как `worktree.updated` (ADR-114 §6) и
// `project.updated` (ADR-118 §4, инвариант 27); новых транспортных каналов не
// заводим (ADR-024). Прогоны — отдельные события `pipeline.run.*` в инстансном
// канале, их этот тип не касается.

/**
 * Вид мутации пайплайна проекта — поле `action` события `pipeline.updated`.
 *
 * - `save` — создан или сохранён черновик (`POST /projects/:id/pipelines`,
 *   `PUT /projects/:id/pipelines/:pid`, тул `pipeline_save`);
 * - `publish` — опубликована неизменяемая версия
 *   (`POST .../pipelines/:pid/publish`, тул `pipeline_publish`);
 * - `delete` — пайплайн удалён (`DELETE .../pipelines/:pid`,
 *   тул `pipeline_delete`); прогоны при этом остаются;
 * - `instantiate` — пайплайн создан из шаблона инстанса
 *   (`POST /pipeline-templates/:tid/instantiate`, тул `pipeline_instantiate`).
 */
export type PipelineChangeAction = 'save' | 'publish' | 'delete' | 'instantiate';

/**
 * Payload события `pipeline.updated` — сущность пайплайна проекта изменилась.
 *
 * Минимальный **по построению**: id пайплайна, проект-владелец и вид мутации.
 * Спецификация (черновик, `vars`, граф узлов) в событие не кладётся — клиент
 * перечитывает список/деталь своим обычным запросом
 * (`GET /projects/:id/pipelines`, `GET /projects/:id/pipelines/:pid`).
 */
export type PipelineUpdatedEventData = {
  /** Пайплайн, которого коснулась мутация. */
  pipelineId: string;
  /** Проект-владелец пайплайна (канал — сессии этого проекта). */
  projectId: string;
  /** Что произошло. */
  action: PipelineChangeAction;
};

// --- PROP-132: метаданные терминала ---------------------------------------
//
// События терминала несут **только метаданные**: поток вывода по шине не
// идёт (волатильный класс — отдельный NDJSON-поток), а содержимое терминала
// в LLM не попадает без явного действия человека.

/**
 * Payload события `terminal.created` — терминал открыт.
 *
 * Идентификаторы — snake_case (как у остальных payload'ов шины).
 */
export interface TerminalCreatedEventData {
  /** Идентификатор терминала (`term_<uuid>`). */
  terminal_id: string;
  /** Проект-владелец терминала. */
  project_id: string;
  /** Привязанная сессия (необязательно). */
  session_id?: string;
  /** Статус терминала (`starting`/`running`). */
  status: string;
  /** Ширина (колонки). */
  cols: number;
  /** Высота (строки). */
  rows: number;
  /** Заголовок вкладки (необязательно). */
  title?: string;
}

/**
 * Payload события `terminal.updated` — изменились метаданные терминала
 * (размер, заголовок, привязка к сессии).
 */
export interface TerminalUpdatedEventData extends TerminalCreatedEventData {
  /** Код выхода (только после выхода). */
  exit_code?: number;
  /** Сигнал завершения (только после выхода). */
  signal?: string;
}

/**
 * Payload события `terminal.exited` — процесс терминала завершился.
 */
export interface TerminalExitedEventData extends TerminalUpdatedEventData {
  /** Причина закрытия (`user`/`idle`/`disabled`/`exited`). */
  reason?: string;
}

/**
 * Payload события `terminal.deleted` — запись терминала удалена из реестра.
 */
export interface TerminalDeletedEventData extends TerminalUpdatedEventData {
  /** Причина удаления (`user`/`idle`/`disabled`). */
  reason?: string;
}

// --- PROP-141 (Часть B): таймеры и будильники -------------------------------
//
// События несут **только метаданные** автоматизации: id, вид, статус и время.
// Комментарий таймера — пользовательский текст, в live-событие он не попадает
// (он виден в сообщении `timer_fired` и в карточке панели).

/**
 * Payload событий `timer.created`/`timer.updated`/`timer.fired`/`timer.cancelled`/
 * `timer.deleted`.
 *
 * Идентификаторы — snake_case (как у остальных payload'ов шины).
 */
export interface TimerEventData {
  /** Id записи: `tmr_<uuid>` для таймера, `alm_<uuid>` для будильника. */
  timer_id: string;
  /** Вид автоматизации (`timer`/`alarm`). */
  kind: string;
  /** Проект автоматизации. */
  project_id: string;
  /** Сессия-получатель сообщения. */
  session_id: string;
  /** Статус записи (`active`/`paused`/`fired`/`cancelled`). */
  status?: string;
  /** Ближайшее срабатывание (ISO-8601). */
  fires_at?: string;
  /** Момент фактического срабатывания (ISO-8601) — для `timer.fired`. */
  fired_at?: string;
  /** Плановое время срабатывания (ISO-8601) — для `timer.fired`. */
  scheduled_for?: string;
  /** Имя автоматизации (необязательное). */
  name?: string;
}
