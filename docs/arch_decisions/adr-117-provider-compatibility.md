# ADR-117: Слой совместимости провайдеров и моделей

> **Статус:** ✅ Реализовано
> **Дата:** 2026-10-30
> **Связано:** [ADR-023](./adr-023-configuration.md) (каталог провайдеров/моделей как данные инстанса),
> [ADR-036](./adr-036-llm-gateway.md) (единственный путь LLM-вызова),
> [ADR-041](./adr-041-llm-error-taxonomy.md) (таксономия ошибок провайдера),
> [ADR-070](./adr-070-system-prompt-composer.md) (prompt-cache и `stream_options`),
> [ADR-111](./adr-111-background-subagent-sessions.md) (шаг-лимит агента — где всплыл дефект DeepSeek),
> [ADR-115](./adr-115-multimodal-input.md) (aux-модели вложений — тоже потребители каталога).

## Контекст

Один и тот же каталог провайдеров/моделей обслуживает и «чистые» API (OpenAI, Anthropic, Ollama),
и десятки совместимых шлюзов и прокси (RouterAI, OpenRouter, DeepSeek, локальные серверы).
Различия протокола не выводятся из типа провайдера, и это давало три класса дефектов:

1. **DeepSeek и шаг-лимит.** Thinking-модели требуют `reasoning_content` у **каждого**
   assistant-сообщения. Синтетический assistant-префилл шага-лимита
   ([ADR-111](./adr-111-background-subagent-sessions.md) п. 7, `engine/llm/max-steps.ts`) уходил без
   поля → провайдер отвечал `400` «The `reasoning_content` in the thinking mode must be passed back
   to the API». Имя поля при этом тоже не универсально: OpenRouter/RouterAI кладут reasoning в
   `reasoning`.
2. **Anthropic и thinking.** При `reasoningLevel: high` thinking-блоки нужно возвращать в истории
   вместе с `signature` — без этого падал второй шаг любого tool-loop. Жёсткий бюджет thinking (8192)
   при дефолтном `max_tokens` 4096 давал `400` уже на первом вызове; thinking требует
   `temperature: 1` и запрещает принудительный `tool_choice`. RouterAI+qwen отвечает пустой подписью
   (`signature: ""`) — это допустимо.
3. **Ollama и `tool_choice`.** Нативный `/api/chat` поля `tool_choice` не знает, а reasoned-режим
   включается отдельным `think`. Общего способа сказать это каталогу не было; Mistral-семейству,
   наоборот, нужен assistant-«мост» после `tool`-результатов.

Первым шагом (`ea20dc45`) появился точечный `ProviderConfig.requiresReasoning` + эвристика. Это
закрыло только симптом №1: остальные различия остались захардкоженными в провайдерах, а кастомный
шлюз с другим именем reasoning-поля или лимита вылечить было нечем. В opencode та же задача решена
данными — полем `compatibility` в каталоге модели/провайдера; берём этот механизм.

## Решение

1. **Один контракт на двух уровнях.** `ModelCompatibility` (`shared/types/provider.ts`):
   `reasoningField`, `requireReasoning`, `maxTokensField`, `requireAssistantAfterTool`,
   `streamUsage`, `supportsToolChoice`, `cacheFormat`, `requireFinishReason`.
   `ProviderConfig.compatibility` — дефолты для всех моделей
   провайдера, `ModelConfig.compatibility` — перекрывает их по каждому полю. `ModelConfig.requiresReasoning`
   остаётся **shorthand** для `compatibility.requireReasoning` (обратная совместимость записей,
   созданных между `ea20dc45` и `f3d1b780`; нормализация — `compatibility.requireReasoning ?? requiresReasoning`).
2. **Порядок резолва — модель → провайдер → эвристика → дефолт** (`resolveModelCompatibility`).
   Явно заданный `reasoningField` сам означает `requireReasoning: true`, если `requireReasoning`
   не переопределён явно (в т.ч. `false`) — как в opencode.
3. **Эвристики** (`detectCompatibilityHeuristics`) применяются только к незаданным полям:
   `requireReasoning` — тип/имя провайдера `deepseek`, URL с `deepseek.com` или id модели с
   `deepseek`; `requireAssistantAfterTool` — Mistral-семейство (`mistral`, `devstral`, `codestral`,
   `pixtral`, `mixtral`); `supportsToolChoice: false` — нативный Ollama. `maxTokensField` и
   `streamUsage` **не** эвристицируются: дефолт — `max_tokens` и `include_usage: true`
   (`max_completion_tokens` — только явным значением; отличие от opencode осознанное, локальные
   серверы этого поля не знают).
4. **Где резолвится.** `resolveModelCompatibility` собирается в точках сборки (`server/app/deps.ts`,
   `backend/app/deps.ts`, шаги пайплайнов, aux-модели вложений); `ProviderPool` кладёт результат в
   ключ кэша провайдеров, `toCoreProviderConfig` — в конфиг провайдера. В самом провайдере —
   `resolveProviderCompatibility` (`providers/base.ts`): явное → shorthand → эвристика.
5. **Потребители.** OpenAI-совместимый путь: имя поля reasoning, пустая строка при
   `requireReasoning`, `maxTokensField`, assistant-«мост» после tool-результатов, `stream_options`.
   Ollama: `think` включается для `low|medium|high` (`none` — выключен), `tool_choice` не
   отправляется. Anthropic: thinking-план (бюджет от фактического `max_tokens`), `temperature: 1`,
   `tool_choice: required → auto`.
6. **Anthropic round-trip thinking — часть того же слоя.** Подпись thinking-блока и
   `redacted_thinking` собираются в стриме и non-stream (`reasoningSignature`, `reasoningRedacted`;
   с 2026-10-30 — **по блокам**, `reasoningBlocks`/`Part.metadata`, `91be3f89`);
   `_formatMessages` собирает assistant-блоки в порядке `redacted_thinking → thinking → text → tool_use`;
   при выключенном thinking блоки не реплеятся. Поля персистятся (файловый store и PostgreSQL,
   миграция `028-message-reasoning-signature`) и **наружу через API не отдаются** — это служебные
   данные протокола, UI на них не опирается.
7. **API — семантика замены.** `POST`/`PATCH /api/v2/providers` и `POST /api/v2/models` принимают
   `compatibility`: объект — **полная замена** (UI присылает весь черновик, поэтому отсутствующее
   поле означает «авто», а не «оставить как было»), `null`/`{}` — сброс, поле не передано — без
   изменений; неизвестное поле или неверный тип → `400 VALIDATION_ERROR` (опечатка не теряется молча).
   `GET` отдаёт `compatibility`, только если он задан. `requires_reasoning: null` у модели сбрасывает
   и shorthand, и `compatibility.requireReasoning`.
8. **Inline-кэш и `finish_reason` — тот же слой (2026-10-30, второй заход).**
   - `cacheFormat: 'anthropic' | 'alibaba'` включает **inline-маркеры** prompt-cache в теле
     OpenAI-совместимого запроса (`cache_control: {type:'ephemeral'}` на частях контента и на
     tool-дефинишне) — паритет с `cacheFormat`/`CachePolicy` в opencode
     (`packages/ai/src/cache-policy.ts`). `anthropic` = AUTO (`tools: true`, `system: true`,
     `messages: {tail: 1}`), `alibaba` = QWEN (`system: true`, `messages: {tail: 1}`, **без** tools:
     Qwen кеширует tools вместе с system). Бюджет — `BREAKPOINT_CAP = 4` на запрос: уже стоящие
     маркеры не дублируются и расходуют бюджет, порядок заполнения — tools → system → хвост.
     System-контент при маркировке — массив частей (`{type:'text', text, cache_control}`).
     При заданном `cacheFormat` `prompt_cache_key` **не** отправляется: это разные механизмы, и
     провайдер, ориентированный на маркеры, полагается только на них (как в opencode). Без
     `cacheFormat` поведение прежнее (только implicit prefix caching), поэтому запросы к обычным
     OpenAI-совместимым эндпоинтам не меняются.
   - `requireFinishReason` (дефолт **`true`**, как `request.model.compatibility?.requireFinishReason
     ?? true` в opencode): стрим, закрытый без `finish_reason`, — недописанный ответ
     (incomplete-stream) → `ProviderError` «Провайдер закрыл стрим без finish_reason». Ошибка
     **невосстановимая**: в `UNRECOVERABLE_PATTERNS` (`engine/llm-error.ts`) добавлен паттерн
     `finish_reason`, поэтому `isLlmErrorRecoverable` не ретраит её (как прочие invalid-output), а
     транспортные ошибки (`network`/`timeout`/`rate_limit`) сохраняют прежнюю политику повторов.
     Явный `false` возвращает толерантное поведение (провайдер без `finish_reason`).
   - **`supportsEffortUpdates` — реализован частично.** У нас нет механизма mid-turn-обновления effort
     (как в opencode: `output_config.effort` на каждое сообщение, `effort`-маркеры в истории), поэтому
     флаг делает только то, что осмысленно без него: при явном `compatibility.supportsEffortUpdates:
     true` Anthropic-провайдер отправляет `output_config.effort` и **не** отправляет `thinking`
     (ни `enabled`, ни `disabled`) — у effort-моделей это другой режим; thinking-блоки истории не
     реплеятся, `temperature` не форсируется. Тир считается на **каждый** LLM-вызов по цепочке
     `ChatOptions.effort` → `agent.effort` → `session.settings.effort` → `effortForReasoningLevel(
     reasoningLevel)` (оркестратор — основной ход, `engine/tools/task/run-cycle.ts` — саб-агент, у
     ребёнка тир фиксируется в его настройках) и едет через `ChatOptions.effort`, а не через
     конструктор провайдера (он кэшируется): `low|medium|high` из `reasoningLevel`, `none`/`default` —
     параметр не отправляется, **`xhigh`/`max` доступны из настроек** — поля `AgentDefinition.effort`/
     `SessionSettings.effort` (админка «Агенты», `null` — сброс к «авто») или явный `ChatOptions.effort`.
     Включение — **только явным значением** (дефолт `false`, авто-эвристик нет): иначе существующие
     записи каталога начали бы слать поле шлюзам без поддержки. Отличие от opencode: нет
     effort-маркеров в истории (там — служебное system-сообщение с партом `effort`, чтобы не
     инвалидировать prompt-cache); смена уровня между ходами подхватывается, но может инвалидировать
     кэш промпта. **Гибрид — исправлено** (`3f8fa7cb`): `RemoteProvider` отправляет `reasoning_effort`
     в LLM Proxy (stream и non-stream; при `undefined` поля нет — старые серверы не ломаются, guard
     остаётся на удалённой стороне). Остатки: mid-turn смена усилия (`PATCH` во время хода) не
     подхватывается до конца хода — дешёвого чтения настроек нет (`loadLight` в файловой реализации
     парсит всю сессию), нужен `SessionRepository.loadSettings`/кэш настроек с инвалидацией;
     официальный `api.anthropic.com` в effort-режиме не проверялся (проверки — на моках).
9. **UI.** В формах провайдера и модели — сворачиваемый блок «Расширенные параметры»
   (`components/admin/CompatibilityFields.tsx`): tri-state «Авто / Да / Нет» (явный `false` не
   схлопывается в «авто»), селект поля reasoning с вариантом «своё значение», «изменено»-бейдж;
   полная очистка у сущности с сохранёнными параметрами отправляет `compatibility: null`.

**Справочная спецификация** — [PROVIDERS.md](../PROVIDERS.md): протоколы и нормализация URL, таблица
полей `compatibility` с дефолтами и порядком резолва, особенности OpenAI-chat / Anthropic / Ollama,
механика лимита шагов, диагностика «симптом → настройка» и известные ограничения. ADR фиксирует
решение и обоснование, спецификация — «как устроено и что настраивать».

## Альтернативы

- **Хардкод по типу провайдера** (`if type === 'deepseek'`). Отвергнуто: шлюзы и прокси
  представляются одним типом (`openai`), а имя/URL/модель у каждого клиента свои; каждый новый
  вариант требовал бы релиза ядра.
- **Только `requiresReasoning`** (состояние после `ea20dc45`). Отвергнуто как конечное решение:
  закрывает один симптом и оставляет `maxTokensField`, `streamUsage`, `tool_choice`,
  assistant-«мост» и имя reasoning-поля захардкоженными. Поле сохранено как shorthand.
- **Merge вместо replace в API.** Отвергнуто: сервер не может отличить «поле не прислали» от
  «вернуть это поле в авто», пришлось бы вводить `null` на каждое поле; замена целым объектом
  проще, валидируется целиком и совпадает с моделью черновика в UI.
- **Дефолт `max_completion_tokens`, как в opencode.** Отвергнуто: локальные OpenAI-совместимые
  серверы поля не знают, молчаливая смена дефолта ломала бы существующие инсталляции.
- **Держать бюджет thinking фиксированным (8192).** Отвергнуто: при `max_tokens` 4096 запрос
  отвергается; бюджет считается от фактического лимита запроса.

## Последствия и остатки

- **Хорошо:** кастомные и прокси-провайдеры настраиваются данными, без релиза ядра; шаг-лимит
  работает на DeepSeek; thinking-Anthropic проходит tool-loop; Ollama не получает неизвестное поле;
  дефекты вида «400 у конкретного шлюза» лечатся в админке.
- **Цена:** контракт шире (8 полей × 2 уровня + shorthand), поверхность для расхождения UI/сервера.
  Риск закрыт replace-семантикой, строгой валидацией и unit-тестами payload/round-trip в UI.
- **Осознанные отличия от opencode:** дефолт `max_tokens`; `reasoningField` из ответа модели
  авто-детектится по известным полям (`reasoning_content`/`reasoning`), произвольное имя задаётся
  только конфигом.
- **Остатки:**
  - авто-определения для `maxTokensField`/`streamUsage`/`cacheFormat` нет (только явное значение или
    дефолт) — так существующие записи каталога не начинают внезапно ставить маркеры;
  - существующие записи каталога не мигрируются (совместимость — через эвристики и дефолты);
  - фильтр thinking-блоков учитывает **роль агента и пару `provider/model`** (`4fe6a36b`): блоки
    отбрасываются, только когда обе половины пары известны — и у сообщения, и у текущего запроса — и
    они расходятся; legacy-сообщения без пары сохраняют прежнее поведение (`sessionMessagesToLlm`
    принимает `currentPair`, `engine/orchestrator/prompt-info.ts`). Остаток: `buildPromptHistoryInfo`
    пару не передаёт, поэтому счётчик reasoning-символов в диагностике промпта может учитывать блоки,
    которые в запрос не уйдут (косметика статистики);
  - подпись thinking реплеится только когда thinking включён в этом запросе; при выключенном блоки в
    историю не уходят.

## Статус в коде

Реализовано 2026-10-30 (`f3d1b780`, `e2a6e359`, `2d4f5763`, поверх `ea20dc45`):

- контракт и резолв — `packages/shared/src/types/provider.ts` (`ModelCompatibility`,
  `ResolvedModelCompatibility`, `detectCompatibilityHeuristics`, `mergeModelCompatibility`,
  `resolveModelCompatibility`, `parseModelCompatibilityInput`);
- провайдеры — `packages/core/src/providers/base.ts` (`resolveProviderCompatibility`), `openai.ts`
  (`_applyInlineCacheMarkers` — маркеры `cache_control` при `cacheFormat`, `finish_reason`-контроль
  стрима, `_applyPromptCacheKey` без ключа при `cacheFormat`), `ollama.ts`, `anthropic.ts`
  (`resolveThinkingBudget`, порядок блоков, подпись);
- проброс — `engine/router/{utils,provider-pool}.ts`, `server/app/deps.ts`, `backend/app/deps.ts`,
  шаги пайплайнов и aux-модели вложений;
- API — `server/routes/{providers,models}.ts`; UI — `components/admin/CompatibilityFields.tsx`,
  `lib/api/compatibility.ts`, панели `ProvidersPanel`/`ModelsPanel`; i18n ru/en. Форма покрывает **все
  восемь** полей, включая `cacheFormat` и `requireFinishReason` (`f3ab0140`: `CompatibilityDraft`,
  `CompatibilityFields.tsx`, payload; тесты UI — 2413), поэтому сохранение из админки их не сбрасывает;
- персист подписи — `packages/shared/src/types/{llm,message}.ts`,
  `storage/file-store.ts`, `packages/storage-postgres/src/migrations/028-message-reasoning-signature.ts`,
  контрактный паспорт порта сессий; наружу не сериализуется (`server/serialize.ts`);
- **мульти-блочная подпись thinking** (`91be3f89`) — `Part.metadata {signature?, redacted?}` у
  reasoning-частей, `LLMReasoningBlock`/`reasoningBlocks` в LLM-контракте, `engine/reasoning-blocks.ts`,
  сбор блоков в Anthropic (stream/non-stream) и реплей по блокам, персист `metadata` частей
  (file + PG), `messageToLLMMessage(msg, currentAgentRole?, currentPair?)` с фильтром по роли агента **и**
  паре `provider/model` (`4fe6a36b`), `content` при наличии `parts` — без reasoning-частей;
  `optimizer.ts` переведён на общий `toCoreProviderConfig`;
- справка — [PROVIDERS.md](../PROVIDERS.md) (спецификация: протоколы, поля `compatibility`,
  особенности протоколов, лимит шагов, диагностика), [CONFIGURATION.md](../CONFIGURATION.md)
  §«Каталог моделей», [API_V2.md](../API_V2.md) §5.9/§5.10, `packages/{core,ui}/AGENTS.md`.

## История

- 2026-10-30 — принято (`f3d1b780` — слой совместимости, `e2a6e359` — UI, `2d4f5763` — Anthropic
  round-trip thinking и персист подписи).
- 2026-10-30 — **мульти-блочная подпись thinking реализована** (`91be3f89`): за ход reasoning приходит
  несколькими блоками, и подпись живёт на каждом блоке (`Part.metadata` ↔ `LLMReasoningBlock`), а не
  одним полем на сообщение; реплей — по блокам (`redacted_thinking → thinking → text → tool_use`),
  `content` без reasoning-частей при наличии `parts`; фильтрация блоков учитывает роль агента **и** пару
  provider/model (`4fe6a36b`: блоки отбрасываются только когда обе половины пары известны и расходятся),
  остаток — `buildPromptHistoryInfo` пару не передаёт (косметика диагностики; см. «Последствия → Остатки»).
