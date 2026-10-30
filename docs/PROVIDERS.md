# Провайдеры и модели: протоколы, совместимость, особенности

> 🌐 [English](./en/PROVIDERS.md) · **Русский**

Справочная спецификация: «как устроено и что настраивать». Это **не** ADR — решение и его
обоснование в [ADR-117](./arch_decisions/adr-117-provider-compatibility.md) (слой совместимости и
Anthropic thinking round-trip), [ADR-036](./arch_decisions/adr-036-llm-gateway.md) (единственный
путь LLM-вызова), [ADR-070](./arch_decisions/adr-070-system-prompt-composer.md) (prompt-cache),
[ADR-115](./arch_decisions/adr-115-multimodal-input.md) (модальности и вложения),
[ADR-099](./arch_decisions/adr-099-egress-tls-trust.md) (TLS/прокси исходящих запросов).

## 1. Область и термины

| Термин | Что это | Где объявлен |
|---|---|---|
| **Провайдер** | Точка доступа: тип протокола, базовый URL, ключ, таймаут, валюта цен, `num_ctx`, дефолты совместимости | `ProviderConfig` — [shared/types/provider.ts](../packages/shared/src/types/provider.ts) |
| **Модель** | Запись каталога: пара «провайдер + имя модели», лимиты, цены, модальности, перекрытия совместимости | `ModelConfig` — там же |
| **Пара `provider/model`** | Адресация модели в роутинге, агенте, саб-агенте и `list_models` (модель без провайдера неоднозначна) | `id` модели = `<provider>/<name>` |
| **Протокол** | Формат запроса/ответа, который реализует адаптер (`openai`/`anthropic`/`ollama`/`decision`/`remote`) | `packages/core/src/providers/` |
| **Каталог** | Записи провайдеров и моделей инстанса (JSON или БД), а не ключи `config.yaml` | `{dataDir}/providers/`, `{dataDir}/models/` |
| **`compatibility`** | Данные о различиях протокола у совместимых шлюзов: имя reasoning-поля, поле лимита вывода, `tool_choice`, формат кэша, требование `finish_reason` | `ModelCompatibility` — [shared/types/provider.ts](../packages/shared/src/types/provider.ts) |

Провайдер и модель — **данные инстанса** (ADR-023/ADR-096), поэтому новый шлюз или прокси
заводится записью каталога, а не релизом ядра. Отдельных ключей `config.yaml` у них нет: правка —
через API, админку или (для первичного провижининга) env-синхронизацию.

**Спецификация не покрывает:**

- пользовательскую документацию портала [docs.synth.itphx.ru](https://docs.synth.itphx.ru/) (там —
  инструкции для конечного пользователя);
- dev-креды и локальные модели для разработки — [LLM_PROVIDERS.md](./LLM_PROVIDERS.md);
- выбор модели/маршрутизацию и микро-слой — [ROUTING.md](./ROUTING.md), ADR-034/ADR-035/ADR-084;
- политику LLM Gateway (обфускация, rate limit, guard) — ADR-036; здесь только граница
  «что гарантирует обёртка, а что протокол»;
- конвейер вложений (гидратация, aux-модели, отброс) — ADR-115 и §3 настоящей спеки;
- конфиг инстанса целиком — [CONFIGURATION.md](./CONFIGURATION.md), HTTP-справочник —
  [API_V2.md](./API_V2.md) §5.9/§5.10.

## 2. Протоколы

Тип провайдера выбирает класс адаптера; `type` берётся из записи провайдера, при отсутствии —
из имени провайдера. Если тип не зарегистрирован, он определяется по URL
(`ProviderFactory._detectProviderType`, [providers/base.ts](../packages/core/src/providers/base.ts)).

| `type` | Адаптер | Endpoint (после нормализации URL) | Чат | Особенности |
|---|---|---|---|---|
| `openai`, `generic` | `OpenAIProvider` | `POST {base}/chat/completions`, если `base` уже содержит `/v1` или `/chat/completions`; иначе `POST {base}/v1/chat/completions` | да | Основной путь совместимых шлюзов и прокси; `compatibility` раскрывается здесь максимально широко (§5) |
| `anthropic` | `AnthropicProvider` | `POST {base}/v1/messages` | да | Thinking-блоки и подписи (§6), собственный формат `tools`/`tool_choice`/`cache_control` |
| `ollama` | `OllamaProvider` | `POST {base}/api/chat` — **всегда нативный** | да | URL с `/v1` или `/v1/chat/completions` нормализуется в `/api/chat` с предупреждением в лог; `options.num_ctx`, `think` и нативный формат `tools` |
| `decision`, `systemone` | `DecisionProvider` | `POST {base}/decisions` (RouterAI/SystemOne) либо `POST {base}/v1/systemone` (Ollama ≥ 0.35.1) | **нет** | Не чат: `state` + типизированные вопросы → вероятности за один forward-pass (ADR-084); `chat`/`chatAsync` бросают `ProviderError` |
| `remote`, `synth-server` | `RemoteProvider` | `POST {backend}/api/v2/llm/chat/completions` (LLM Proxy backend'а) | да | Гибридный режим: локальный core ходит за LLM на сервер, gateway применяется на сервере; токен — из `RemoteSession`/реестра токенов |

`remote` и `synth-server` — один и тот же адаптер: `synth-server` зарегистрирован как **алиас**
(`providers/index.ts`, тест `remote.test.ts`), отдельного поведения не имеет и нужен для гибрида и
совместимости с прежними записями каталога.

Нормализация URL — `ProviderFactory._normalizeUrl`; для `decision`/`systemone` URL остаётся базовым
(путь протокола добавляет сам адаптер).

**Граница `GatewayProvider`** ([engine/gateway/gateway-provider.ts](../packages/core/src/engine/gateway/gateway-provider.ts)).
Любой LLM-вызов (чат, стрим, `embed`, `decide`) идёт через обёртку; провайдер напрямую не
дёргается (корневой инвариант 3). Обёртка даёт:

- **input guard** и обфускацию секретов (карта обфускации сессии; в провайдер уходит уже
  обфусцированный запрос — prompt-cache-маркеры ставятся после guard/обфускации);
- **rate limit** (пользователь и провайдер, окна в минуту);
- **аудит** каждого вызова (`AuditLogger`, в т.ч. применение фильтров LLM-вызовов);
- **output guard** для ответа;
- учёт вызова для метрик (`synth_llm_requests_total`/`synth_llm_duration_seconds`/
  `synth_llm_tokens_total`, ADR-094) и фазы фильтров `pre_request`/`post_response`/`embedding`.

Протокол-специфичное (какое поле несёт reasoning, как передать лимит вывода, что делать с
`tool_choice`, как реплеить thinking-блоки) остаётся в адаптере и управляется данными
`compatibility`. Guard/обфускация/сканер работают **только с текстом** — бинарь вложений не
сканируется (ADR-115).

## 3. Каталог и настройка

### 3.1 Хранение

| Что | Где | Тип |
|---|---|---|
| Провайдер | `{dataDir}/providers/<name>.json` (при `storage.backend=postgres` — таблица документов) | `ProviderConfig` |
| Модель | `{dataDir}/models/<id>.json`, `id` = `<provider>/<name>` | `ModelConfig` |

Запись атомарна (tmp → rename, ADR-005), чтение — через порт слоя хранения (ADR-096). Ручная правка
JSON допустима как аварийный путь, но источник истины поведения — API: кэши провайдеров/моделей
(`providerCache`/`modelCache`) обновляются обработчиками роутов.

### 3.2 API

| Метод/путь | Назначение |
|---|---|
| `GET /api/v2/providers` | Список: `name`, `type`, `url`, `model`, `enabled`, `is_default`, `currency`, `num_ctx`, `compatibility` (только если задан) |
| `POST /api/v2/providers`, `PATCH /api/v2/providers/:name` | Создать/обновить: `compatibility`, `num_ctx`, валюта, таймаут, иконка; принимаются и snake_case, и camelCase имена полей |
| `POST /api/v2/models` | Создать/обновить модель: `context_window`, `max_output_tokens`, цены, `price_source`, `currency`, `modalities`, `compatibility`, `requires_reasoning` |
| `POST /api/v2/models/fetch` (`?provider=<name>`) | Синхронизация с каталогом провайдера: `contextWindow`/`maxOutputTokens`/цены (`priceSource: 'api'`)/модальности; best-effort (недоступный каталог не роняет синхронизацию) |

Точные тела запросов и коды — [API_V2.md](./API_V2.md) §5.9/§5.10; реализация —
[server/routes/providers.ts](../packages/core/src/server/routes/providers.ts),
[server/routes/models.ts](../packages/core/src/server/routes/models.ts).

### 3.3 Каскад настроек и env

Каталог — данные инстанса; общий приоритет конфигурации (CLI > `SYNTH_*` env > `config.yaml` >
defaults, ADR-023) применяется к **секциям конфига**, а не к записям каталога. Исключение —
первичный провижининг провайдеров из env (`syncProvidersFromEnv`,
[providers/sync-from-env.ts](../packages/core/src/providers/sync-from-env.ts)):

```text
SYNTH_PROVIDER_<NAME>_(API_KEY|URL|MODEL|TYPE|NUM_CTX)
```

Имя приводится к lowercase с `_` → `-`; при старте запись каталога **дополняется/перезаписывается**
по этим полям, а `MODEL` создаёт модель `<name>/<model>` с `isDefault: true`, если её ещё нет.
Через env **не переносятся** `compatibility`, `timeout`, `currency`, `icon` — их задают API или
JSON каталога (см. §11). CLI-эквивалент — `synth config provider add` (флаги `--type`, `--url`,
`--model`, `--api-key`, `--num-ctx`), подробности — [LLM_PROVIDERS.md](./LLM_PROVIDERS.md).

### 3.4 `num_ctx` (размер контекста)

Применяется только нативным путём Ollama (`/api/chat`, `options.num_ctx`). Приоритет:
**явный `ProviderConfig.numCtx`** → `ModelConfig.contextWindow` → справочник
([engine/router/utils.ts](../packages/core/src/engine/router/utils.ts),
[engine/orchestrator/routing.ts](../packages/core/src/engine/orchestrator/routing.ts)).
Поле задаётся `num_ctx`/`numCtx` в `POST`/`PATCH /api/v2/providers`, env
`SYNTH_PROVIDER_<NAME>_NUM_CTX`, флагом `--num-ctx`; OpenAI-совместимый путь Ollama
(`type: openai`/`generic`) это значение не передаёт.

### 3.5 Цены, валюты, источник цен

- Цены — за **1 млн токенов**: `inputPrice`, `outputPrice`, `cacheReadPrice`, `cacheWritePrice`.
- Валюта — `RUB` | `USD` | `CNY`; отсутствует у модели → валюта провайдера → `USD`.
- `priceSource`: `api` — получено синхронизацией каталога, `manual` — введено вручную, `unknown` —
  не определено. Ручной ввод цены помечает `manual`; очистка всех цен сбрасывает источник.
- Парсинг прайсинга RouterAI/OpenRouter (`pricing`/`pricing_units`) учитывает **только токенные**
  тарифы (`request`/`second`/`image`/`search_unit` игнорируются) и нормирует значения ×1 000 000
  ([providers/base.ts](../packages/core/src/providers/base.ts)).

### 3.6 Модальности (ADR-115)

`ModelConfig.modalities` (`text`/`image`/`pdf`/`audio`/`video`) — какие вложения модель принимает.
Источник — каталог провайдера (`architecture.input_modalities`/`architecture.modality`, маппинг
`file` → `pdf`) при `POST /api/v2/models/fetch`, либо ручной override в `POST /api/v2/models`
(`null` — сброс). **Поля нет — модальности неизвестны**: фильтра нет, несовместимый тип отклоняет
сам провайдер (тихая потеря вложения запрещена). Справочника модальностей в ядре нет.

Модальности — вход гидратации: модель принимает — вложение уходит нативно; не принимает — aux-модель
семейства (`attachments.modalityModels`) или отброс с материализацией в workspace (ADR-115).
Адаптеры кодируют только то, что физически умеют: `video_url`/`input_audio{ogg}` — RouterAI,
`audio{base64}` — Anthropic-совместимый RouterAI (только wav), официальный Anthropic/OpenAI этих
блоков не знают.

### 3.7 Где смотреть каталог

- UI: разделы администрирования «Провайдеры» и «Модели» (формы + блок «Расширенные параметры» §4.6).
- API: `GET /api/v2/providers`, `GET /api/v2/models` (группы по провайдеру; `modalities`,
  `requiresReasoning`, `compatibility` отдаются **только если заданы**).
- Агенту: тул `list_models` (`provider/model`, модальности, текущая пара, `defaultFor`).

## 4. Слой совместимости `compatibility`

Один контракт `ModelCompatibility` объявлен на двух уровнях: `ProviderConfig.compatibility` —
дефолты для всех моделей провайдера, `ModelConfig.compatibility` — перекрывает их по каждому полю.

### 4.1 Поля

| Поле | Дефолт | Назначение | Протокол |
|---|---|---|---|
| `reasoningField` | `reasoning_content` | Имя поля reasoning в assistant-сообщениях; явное значение само включает `requireReasoning`, если тот не переопределён | openai-chat |
| `requireReasoning` | авто (эвристика DeepSeek) | Поле reasoning обязательно у **каждого** assistant-сообщения — пустой строкой, если reasoning нет | openai-chat |
| `maxTokensField` | `max_tokens` | Поле лимита вывода: `max_tokens` \| `max_completion_tokens` (второе — только явным значением) | openai-chat |
| `requireAssistantAfterTool` | `false` (эвристика Mistral) | Assistant-«мост» после `tool`-результатов и в конце истории, если она закончилась `tool` | openai-chat |
| `streamUsage` | `true` | `stream_options: {include_usage: true}` в стриме (без него usage в стриме нулевой) | openai-chat |
| `supportsToolChoice` | `true` (у `type: ollama` — `false`) | Отправлять ли `tool_choice` | openai-chat, Ollama |
| `cacheFormat` | не задан | Inline-маркеры prompt-cache `cache_control: {type:'ephemeral'}`: `anthropic` — последний tool + system + хвост последнего сообщения; `alibaba` — system + хвост, **без** tools. Бюджет ≤ 4 breakpoint'а; при заданном значении `prompt_cache_key` **не** отправляется | openai-chat |
| `requireFinishReason` | `true` | Стрим без `finish_reason` = недописанный ответ (incomplete-stream) → ошибка, не ретраится | openai-chat |
| `supportsEffortUpdates` | `false` (только явное значение) | Effort-режим Anthropic 5.x: отправлять `output_config.effort` (тир усилия — из `effort` агента/сессии либо из `reasoningLevel`) и **не** отправлять `thinking`; thinking-блоки истории не реплеятся, `temperature` не форсируется. Без флага — прежнее поведение, явный effort игнорируется | anthropic |

`ResolvedModelCompatibility` — полностью разрешённый набор: каждое поле заполнено, кроме
`cacheFormat`, где `undefined` — осмысленное состояние («маркеры не ставить»).

**Уровень размышлений и sampling — вне `compatibility`.** `reasoningLevel` задаётся агентом
(`AgentDefinition.reasoningLevel`) и сессией (`SessionSettings.reasoningLevel`). При создании сессии
(`POST /api/v2/sessions`) значение **сохраняется** (whitelist `SessionManager.createSession` его
больше не теряет — раньше `reasoningLevel` из тела запроса отбрасывался, и настройка начинала
действовать только после `PATCH`), а в запрос уходит эффективное значение
(`agentDef.reasoningLevel ?? session.settings.reasoningLevel`, агентом приоритетнее). `topP`/`topK` —
поля **агента**, не сессии: в `SessionSettings` их нет, и переданные в `POST /api/v2/sessions`
отбрасываются (sampling задаётся в админке «Агенты»).

**Тир усилия (`effort`) — отдельное поле, тоже вне `compatibility`.** Для effort-моделей тир можно
задать явно: `AgentDefinition.effort` (админка «Агенты», `POST`/`PATCH /api/v2/agents`) и
`SessionSettings.effort` (`POST /api/v2/sessions` и `PATCH /api/v2/sessions/:id`) — значения
`low|medium|high|xhigh|max`, `null` при обновлении — сброс к «авто» (тир снова выводится из
`reasoningLevel`). При создании сессии значение сохраняется (whitelist `createSession`). Приоритет
резолва на каждый LLM-вызов: `ChatOptions.effort` (код, шаги пайплайнов, LLM Proxy) → `agent.effort` →
`session.settings.effort` → `effortForReasoningLevel(agent.reasoningLevel ?? session.reasoningLevel)`.
`xhigh`/`max` из `reasoningLevel` **не выводятся** (шкалы не совпадают) — только явным `effort` или
`ChatOptions.effort`. Сам параметр уходит провайдеру лишь при `compatibility.supportsEffortUpdates:
true` у модели/провайдера (§6.1); иначе поле игнорируется.

### 4.2 Порядок резолва

**модель → провайдер → эвристика → встроенный дефолт** (`resolveModelCompatibility`,
[shared/types/provider.ts](../packages/shared/src/types/provider.ts)):

1. явное значение `ModelConfig.compatibility`;
2. явное значение `ProviderConfig.compatibility` (для полей, не заданных у модели);
3. эвристика `detectCompatibilityHeuristics`;
4. встроенный дефолт.

`ModelConfig.requiresReasoning` — **shorthand** для `compatibility.requireReasoning`;
нормализация `compatibility.requireReasoning ?? requiresReasoning` (записи, созданные до появления
`compatibility`, продолжают работать). Явный `reasoningField` на любом уровне сам означает
`requireReasoning: true`, если `requireReasoning` не задан явно (в т.ч. `false`).

### 4.3 Эвристики

Применяются **только к незаданным** полям:

| Поле | Условие |
|---|---|
| `requireReasoning: true` | тип/имя провайдера `deepseek`, URL содержит `deepseek.com`, id модели содержит `deepseek` |
| `requireAssistantAfterTool: true` | id модели содержит `mistral`/`devstral`/`codestral`/`pixtral`/`mixtral` |
| `supportsToolChoice: false` | `type: ollama` (нативный `/api/chat` поля не знает) |

`maxTokensField`, `streamUsage`, `cacheFormat`, `requireFinishReason`, `supportsEffortUpdates` **не**
эвристицируются: иначе существующие записи каталога начали бы вести себя иначе (локальные серверы не
знают `max_completion_tokens`; inline-маркеры кэша и effort-режим — только явным значением). Для
`supportsEffortUpdates` авто-эвристики нет принципиально: включение меняет тело запроса
(`output_config` вместо `thinking`), и угадывание по имени модели отправило бы неизвестное поле
шлюзам без поддержки (400).

### 4.4 Где резолвится

- Сборка каталога в домен: `server/app/deps.ts` и `backend/app/deps.ts`
  (`resolveModelCompatibility`: `provider.compatibility` → shorthand → `model.compatibility`);
- `toCoreProviderConfig` ([engine/router/utils.ts](../packages/core/src/engine/router/utils.ts))
  — конфиг провайдера вне сессий (суммаризация, шаги пайплайнов, aux-модели вложений);
- `ProviderPool` кладёт значение в ключ кэша — смена `compatibility` пересоздаёт экземпляр
  провайдера, чужие прогоны не затрагиваются;
- внутри адаптера — `resolveProviderCompatibility` ([providers/base.ts](../packages/core/src/providers/base.ts)):
  явное (provider+model) → shorthand → эвристика.

### 4.5 Семантика API — замена

`POST`/`PATCH /api/v2/providers`, `POST /api/v2/models` принимают `compatibility` как **полную
замену**:

| Тело | Результат |
|---|---|
| поле не передано | без изменений |
| `null` | сброс |
| `{}` | сброс (пустой объект равнозначен `null`) |
| объект | замена целиком: отсутствующее в объекте поле = «авто», а не «сохранить прежнее» |
| неизвестное поле / неверный тип | `400 VALIDATION_ERROR` (опечатка не теряется молча) |

`requires_reasoning: null` у модели снимает и shorthand, и `compatibility.requireReasoning`.
`GET` отдаёт `compatibility` только если он задан.

### 4.6 UI: блок «Расширенные параметры»

Сворачиваемый блок в формах провайдера и модели
([CompatibilityFields.tsx](../packages/ui/src/components/admin/CompatibilityFields.tsx),
черновик — [lib/api/compatibility.ts](../packages/ui/src/lib/api/compatibility.ts)):

- boolean-поля — tri-state **«Авто / Да / Нет»**: явный `false` не схлопывается в «авто»;
  «Авто» = поле **не уходит** в тело запроса (сервер выберет эвристику/дефолт);
- `reasoningField` — селект известных имён (`reasoning_content`/`reasoning`/`reasoning_text`) с
  вариантом «своё значение»; неизвестное сохранённое имя разворачивается в «своё значение»;
- `maxTokensField` и `cacheFormat` — селекты с «Авто»; `requireFinishReason` и `supportsEffortUpdates` —
  tri-state (у последнего «Авто» означает «Нет»: сервер включает effort-режим только явным `true`);
- бейдж «изменено»/«расш.» в списках; полная очистка у сущности с сохранёнными параметрами
  отправляет `compatibility: null` (явный сброс), у сущности без сохранённых — поле не отправляется.

### 4.7 Примеры

```jsonc
// PATCH /api/v2/providers/deepseek-gw — дефолты провайдера
{ "compatibility": { "reasoningField": "reasoning", "requireReasoning": true } }

// POST /api/v2/models — перекрытие для одной модели (полная замена объекта)
{ "id": "qwen3.7-flash", "provider": "routerai",
  "compatibility": { "maxTokensField": "max_completion_tokens", "streamUsage": false } }

// сброс к авто/дефолтам
{ "compatibility": null }
```

```bash
# кастомный OpenAI-совместимый шлюз: reasoning в поле reasoning, без stream_options
curl -X POST http://localhost:5000/api/v2/providers \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"name":"my-gw","type":"openai","base_url":"https://gw.example.com/v1",
       "api_key":"sk-…","default_model":"my-model",
       "compatibility":{"reasoningField":"reasoning","streamUsage":false}}'

# модель с другим полем лимита и inline-кэшем anthropic-формата
curl -X POST http://localhost:5000/api/v2/models \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"id":"my-gw/big","provider":"my-gw","name":"big",
       "context_window":200000,"max_output_tokens":8192,
       "compatibility":{"maxTokensField":"max_completion_tokens","cacheFormat":"anthropic"}}'
```

## 5. OpenAI-chat: особенности

Реализация — [providers/openai.ts](../packages/core/src/providers/openai.ts) (типы `openai`,
`generic` — один класс).

### 5.1 Имена поля reasoning

При чтении ответа приоритет: настроенное `reasoningField` → `reasoning_content` → `reasoning`
(пустые строки пропускаются). При отправке истории имя берётся из резолва; `reasoning_content` —
дефолт (DeepSeek), `reasoning` — OpenRouter/RouterAI, `reasoning_text` — прочие шлюзы (задаётся
явно). Служебные reasoning-чанки DeepSeek `'.'`/`'.\n'` отбрасываются (у поля `reasoning` такого
фильтра нет — там точки осмысленны).

### 5.2 Pass-back reasoning

Thinking-модели DeepSeek требуют возврата reasoning в повторной истории: иначе
`400` «The `reasoning_content` in the thinking mode must be passed back to the API». Поэтому при
`requireReasoning` поле пишется в **каждое** assistant-сообщение — пустой строкой, если reasoning
нет (`reasoning ?? (requireReasoning ? '' : undefined)`). Без этого ломался синтетический
assistant-префилл шага-лимита (§8).

### 5.3 Поле лимита вывода

`maxTokensField`: наш дефолт — `max_tokens` (осознанное отличие от opencode, где дефолт
`max_completion_tokens`). `max_completion_tokens` отправляется только при **явном** значении:
локальные и кастомные OpenAI-совместимые серверы это поле часто не знают, и молчаливая смена
дефолта ломала бы существующие инсталляции. Лимит уходит в тело, только если он задан и `> 0`.

### 5.4 `tool_choice`

`tool_choice` передаётся **только вместе с `tools`** (часть API отвечает ошибкой на поле без
инструментов) и только если он задан вызывающим слоем: `auto` | `none` | `required`. На
шаге-лимите — `none` (§8). У нативного Ollama поле не отправляется (§7).

### 5.5 `requireAssistantAfterTool` (assistant-«мост»)

Mistral-семейство не принимает историю, где после `tool`-результата сразу идёт `user`-реплика.
При включённом флаге адаптер вставляет `{role:'assistant', content:'Done.'}`:
после tool-результата перед `user`-сообщением **и** в конце истории, если она закончилась `tool`.
Пары `tool_calls`/`tool_call_id` при этом не рвутся.

### 5.6 `streamUsage`

`stream_options: {include_usage: true}` (дефолт — включено). Без него usage в стриме нулевой, и в
статистику не попадают `cached_tokens`/`reasoning_tokens` (ADR-070/ADR-094). `false` — эндпоинт
поля не знает; usage тогда остаётся нулевым, но запрос не падает.

### 5.7 `cacheFormat`: inline-маркеры вместо `prompt_cache_key`

- Без `cacheFormat` — implicit prefix caching: `prompt_cache_key` = стабильный id сессии
  (при `cachePolicy: 'none'` ключ не отправляется).
- `anthropic` — маркеры на последнем tool-дефинишне, на границах system (первый и последний
  **различные** блоки) и на границе последнего сообщения (`tail: 1`, последняя текстовая часть,
  иначе последняя часть контента).
- `alibaba` — только system и хвост сообщений, **без** tools (Qwen кеширует tools вместе с
  system и игнорирует маркеры на дефинишнах).
- Бюджет — не больше 4 breakpoint'ов на запрос; уже стоящие в теле маркеры не дублируются и
  расходуют бюджет, порядок заполнения — tools → system → хвост.
- При заданном `cacheFormat` `prompt_cache_key` **не** отправляется: это разные механизмы, и
  провайдер, ориентированный на inline-маркеры, полагается только на них.
- Стринг system-контент при маркировке разворачивается в массив частей
  (`{type:'text', text, cache_control}`) — так маркер живёт на проводе.
- `cachePolicy: 'none'` — ни одного маркера.

### 5.8 `requireFinishReason`

Дефолт `true`: провайдер, закрывший стрим без `finish_reason`, отдал недописанный ответ →
`ProviderError` «Провайдер закрыл стрим без finish_reason». Ошибка **невосстановимая**: паттерн
`finish_reason` входит в `UNRECOVERABLE_PATTERNS` ([engine/llm-error.ts](../packages/core/src/engine/llm-error.ts)),
`isLlmErrorRecoverable` её не ретраит (транспортные `network`/`timeout`/`rate_limit` — ретраятся
как раньше). Явный `false` возвращает толерантное поведение — для «старых» локальных серверов,
которые не присылают `finish_reason` вообще.

### 5.9 LLM Proxy (`POST /api/v2/llm/chat/completions`)

Прокси гибридного режима (backend) — **тот же контракт совместимости**, а не «сырой» openai-путь:

- необязательное поле `reasoning_effort` (`low|medium|high|xhigh|max`) уходит в `ChatOptions.effort`;
  невалидное значение — `400 BAD_REQUEST`, провайдер не вызывается (контракт запроса, а не «тихий» игнор);
- гибридный `RemoteProvider` **отправляет** это поле сам — и в stream, и в non-stream (приоритет:
  явный `ChatOptions.effort` → тир из `reasoningLevel` экземпляра провайдера); при `undefined` поля в
  теле **нет**, поэтому старые серверы не ломаются (схема запроса не strict, неизвестный ключ
  отбрасывается — деградация аддитивная);
- провайдер создаётся с merged `compatibility`: `provider.compatibility` → shorthand модели
  `requiresReasoning` → `model.compatibility`. Поэтому guard'ы (`requireReasoning`, `maxTokensField`,
  `cacheFormat`, `supportsEffortUpdates`) работают и на прокси;
- отправляет ли провайдер effort, по-прежнему решает `compatibility.supportsEffortUpdates`
  (guard в провайдере, §6.1).

## 6. Anthropic: особенности

Реализация — [providers/anthropic.ts](../packages/core/src/providers/anthropic.ts).

### 6.1 Extended thinking

| `reasoningLevel` | Что в `body.thinking` | Thinking-блоки в истории |
|---|---|---|
| `high` | `{type:'enabled', budget_tokens: …}` | реплеятся |
| `none` | `{type:'disabled'}` | не реплеятся |
| `default`, `low`, `medium` | поле не отправляется (дефолт модели) | не реплеятся |

Бюджет — `resolveThinkingBudget(requested, maxTokens)` (`requested` = 8192):
`min(8192, max(⌊max_tokens/2⌋, 1024))`, и результат обязан быть **строго меньше** `max_tokens`.
Практически это «не больше половины лимита, но не ниже 1024»; если половина лимита ниже минимума,
бюджет поднимается до 1024 (место под минимум ещё есть); если места нет вовсе (`max_tokens` ≤ 1024) —
thinking **не включается**, запрос уходит обычным (вместо `400` «max_tokens must be greater than
thinking.budget_tokens»). Лимит берётся фактический: `ProviderConfig.maxTokens` → дефолт 4096.

Принудительные ограничения при включённом thinking:

- `temperature` принудительно `1` (значение сессии/агента перекрывается, экземпляр провайдера не
  мутируется — он кэшируется и разделяется между прогонами);
- `tool_choice: 'required'` коэрсится в `'auto'` (API запрещает принудительный вызов);
  `'none'` разрешён — это путь шага-лимита.

**Effort-режим (`output_config.effort`, ADR-117).** Включается только явным
`compatibility.supportsEffortUpdates: true` (дефолт — `false`, авто-эвристики нет) и меняет тело
запроса:

- `body.output_config = { effort }`. Что именно уходит:
  - приоритет — явный `ChatOptions.effort` (оркестратор и цикл саб-агента собирают его **на каждый
    LLM-вызов** по цепочке `agent.effort` → `session.settings.effort` →
    `effortForReasoningLevel(reasoningLevel)`), иначе — `reasoningLevel` экземпляра провайдера;
  - маппинг `reasoningLevel` → тир: `low|medium|high` — те же тиры; `none`/`default` — параметр
    **не отправляется** («выключить размышления» effort-тиром не выразить, выдумывать значение
    нельзя); `xhigh`/`max` из `reasoningLevel` не выводятся — задаются явным `effort` в настройках
    агента/сессии (админка «Агенты»; `null` — сброс к «авто») либо `ChatOptions.effort` из кода;
- `thinking` **не отправляется вообще** — ни `{type:'enabled', budget_tokens}`, ни `{type:'disabled'}`:
  у effort-моделей это другой режим, и смешивать их нельзя. Следствия: бюджет (см. выше) не считается,
  `temperature` не форсируется в `1` (действует значение агента/сессии), `tool_choice` не коэрсится;
- thinking-блоки истории **не реплеятся** (как при выключенном thinking, §6.2) — иначе Anthropic
  получил бы их без включённого thinking;
- смена уровня между **ходами** подхватывается (effort едет в опциях вызова, а не в конструкторе
  провайдера, который кэшируется и разделяется между прогонами), но меняет параметры запроса и может
  сбросить кэш промпта на стороне провайдера. Внутри хода изменение настроек (`PATCH` во время
  прогона) до следующего шага **не** подхватывается — настройки читаются на старте хода (§11).

Без флага поведение прежнее (`thinking` по `reasoningLevel`), а явный `ChatOptions.effort`
**игнорируется**.

### 6.2 Подпись thinking

- За ход reasoning приходит **несколькими блоками**, и подпись валидна только для своего текста,
  поэтому блоки хранятся **по отдельности**: `Part` с `type:'reasoning'` и `metadata {signature?,
  redacted?}`; в LLM-контракте — `LLMReasoningBlock {text, signature?, redactedData?}`
  (`LLMChunk`/`LLMResponse.reasoningBlocks`, `LLMMessage.reasoningBlocks`). Шов —
  [engine/reasoning-blocks.ts](../packages/core/src/engine/reasoning-blocks.ts).
- Стрим: `content_block_start` открывает блок (`thinking` с возможной подписью, `redacted_thinking`
  с opaque `data`, `tool_use`), `thinking_delta` накапливает текст, `signature_delta` кладёт
  подпись (авторитетнее значения из старта блока), новый блок закрывает предыдущий. Non-stream —
  тем же результатом по `content`.
- Реплей в `assistant`-сообщении: порядок `redacted_thinking → thinking → text → tool_use`,
  **у каждого блока своя подпись**.
- Пустая подпись (`signature: ""`) допустима — так отвечает RouterAI для qwen.
- Legacy-поля `reasoningSignature`/`reasoningRedacted` на сообщении сохранены как fallback
  (`reasoningBlocksOfMessage`).
- При выключенном thinking блоки в историю **не уходят** (Anthropic не примет их без включённого
  thinking).
- Блоки прокидываются только «своему» агенту **и** только сообщениям той же пары
  `provider/model`, что текущий запрос (`messageToLLMMessage(msg, currentAgentRole?, currentPair?)`,
  алиасы ролей учитываются; legacy-сообщения без пары — прежнее поведение); наружу через API не
  отдаются — служебные данные протокола.

### 6.3 Prefill шага-лимита при thinking

На шаге-лимите в конец истории дописывается синтетическое assistant-сообщение с требованием «только
текст» (§8). При включённом thinking в этом префилле **нет** thinking-блока. Проверено живьём на
RouterAI/qwen: запрос принимается, ход завершается `completed` с `step_limit_reached`.
Официальный `api.anthropic.com` в этом сценарии не прогонялся (§11).

### 6.4 Prompt-cache breakpoints

`system` отдаётся массивом блоков (при `stablePrefix` — `[stable, остаток]`), маркеры
`cache_control: {type:'ephemeral'}` ставятся в порядке приоритета: tools → system → последнее
user-сообщение; бюджет ≤ 4 breakpoint'а, лишние дропаются с предупреждением (запрос не падает).
Индекс tools-брейкпоинта учитывает `stableToolCount` (ADR-071 §2.1): MCP-инструменты после границы
не кэшируются. `cachePolicy: 'none'` — ни одного маркера; у последнего user-сообщения без
text-части (например, только `tool_result`) маркер не ставится.

### 6.5 Врезка `deepseek-anthropic`

Anthropic-совместимый эндпоинт DeepSeek (`type: anthropic`, URL `https://api.deepseek.com/anthropic`)
проверен живьём (dev). Поведение, важное для эксплуатации:

- думает **всегда** по умолчанию: thinking отключается только `reasoningLevel: none`
  (`thinking: {type:'disabled'}` принимается), а не отсутствием поля;
- подпись thinking-блока непустая и равна `id` блока; реплей с `thinking`+`signature` — `200`;
- эндпоинт **толерантен** к отсутствию thinking-блока в истории (реплей без блока — `200`), то есть
  строгий round-trip, обязательный для официального Anthropic, здесь не требуется.

Непроверенным остаётся `tool_choice: 'none'` вместе с `tools` на этом эндпоинте (§11) — это путь
шага-лимита.

## 7. Ollama

Реализация — [providers/ollama.ts](../packages/core/src/providers/ollama.ts). `type: ollama` **всегда**
работает нативно: URL нормализуется к `/api/chat`, суффиксы `/v1` и `/v1/chat/completions`
снимаются с предупреждением в лог. Причины: только нативный путь понимает `options` (`num_ctx`),
`think` и нативный формат `tools`; OpenAI-слой Ollama всё это молча игнорирует. OpenAI-совместимый
путь — отдельный провайдер `type: openai`/`generic` с URL `.../v1`.

### 7.1 `think`

| `reasoningLevel` | `body.think` |
|---|---|
| `low` / `medium` / `high` | `true` |
| `none` | `false` |
| `default` | поле не отправляется (дефолт модели) |

Системный промпт идёт **первым сообщением** `role:'system'` (нативный `/api/chat` игнорирует
top-level `system` — он есть только у `/api/generate`).

### 7.2 Нет `tool_choice`

Эвристика ставит `supportsToolChoice: false` для `type: ollama`; поле не отправляется вовсе.
Явное `compatibility.supportsToolChoice: true` вернёт отправку (для совместимых форков сервера).

### 7.3 `num_ctx`

`options.num_ctx` уходит в тело, если задан `numCtx > 0`. Приоритет источника — §3.4: явный
`provider.numCtx` **выше** `ModelConfig.contextWindow`.

### 7.4 Следствие для шага-лимита

Так как запретить вызов инструментов нечем, модель на шаге-лимите может вернуть `tool_calls`.
Вызовы **не исполняются**, но и не выбрасываются молча: на каждый пишется парный `tool`-результат с
`isError` и ключом `tool.disabled_by_step_limit`, затем ход завершается детерминированным отчётом
`session.steps_limit` (статус `limit`). Проверено живьём: `qwen3.8:27b-256k` через нативный Ollama
даёт `status=limit`, `step_limit_reached=true`, текста модель не даёт.

## 8. Лимит шагов

Механика — паритет с opencode; общий модуль —
[engine/llm/max-steps.ts](../packages/core/src/engine/llm/max-steps.ts) (им пользуются основной
цикл `engine/orchestrator.ts` и цикл саб-агента `engine/tools/task/run-cycle.ts`).

### 8.1 Нумерация: `maxSteps: N` → N−1 рабочих шагов + шаг-лимит

`stepLimitStep = iteration + 1 >= maxSteps` (`iteration` с нуля). Следствия:

- `maxSteps: N` — **N−1** рабочих шагов и **один** шаг-лимит (не «N рабочих, потом отчёт»);
- `maxSteps: 1` — сразу только шаг-лимит (tool-вызовов в ходе нет);
- `maxSteps` не задан (или `<= 0`) — лимита нет (`DEFAULT_MAX_ITERATIONS = Infinity`).

### 8.2 Что происходит на шаге-лимите

- **`tools` остаются в запросе** — иначе у провайдера слетает кэшированный префикс, и модель
  начинает печатать разметку вызова текстом;
- вызов запрещается `toolChoice: 'none'` (Ollama — см. §7.4);
- инструкция «отвечай только текстом» вставляется **assistant-сообщением** в конец запроса
  (`prompts/system/MAX_STEPS.{lang}.md`, override — `{dataDir}/user/system/MAX_STEPS.{lang}.md`,
  fallback — `MAX_STEPS_FALLBACK_PROMPT` с подстановкой `{limit}`); **в историю сессии она не
  пишется**;
- «непослушный» tool call (провайдер вернул `tool_calls` несмотря на `none`): вызовы не
  исполняются, но `assistant(tool_calls)` сохраняется, и на каждый вызов пишется парный
  `tool`-результат с `isError` и ключом `tool.disabled_by_step_limit` (`{tool}`, `{limit}`),
  публикуется `tool_call.result`; пары `toolUse`/`toolResult` не рвутся (иначе следующий вызов
  получил бы `400` «insufficient tool messages following tool_calls»).

### 8.3 Отчёты и метки

| Где | Что |
|---|---|
| Основной агент, пустой ответ | `session.steps_limit` (`{limit}`); статус ответа — `limit` |
| Основной агент, есть текст | этот текст становится отчётом |
| metadata финального assistant-сообщения | `step_limit_reached: true` |
| `stream.done` | `step_limit_reached: true` (аддитивное поле) |
| Саб-агент, пустой ответ | `task.steps_limit_empty` (`{limit}`) |
| Саб-агент, страховка после отчёта | суффикс `task.steps_limit` (`[steps_limit]`) — всегда, когда шаг-лимит исполнялся |
| metadata сообщения ребёнка и `task`-результата родителя | `step_limit_reached: true`, `step_limit: N` |

Флаг «шаг-лимит действительно исполнялся» ставит сам цикл: отчёт подставляется только тогда, когда
синтетический префилл реально уходил в запрос. Ключ `session.max_iterations` для основного цикла
больше не используется (остался у шагов пайплайнов).

## 9. Безопасность и наблюдаемость

- **Единственный путь вызова** — `GatewayProvider` (ADR-036): guard, обфускация, rate limit,
  аудит, output guard, `embed` и `decide` — через ту же обёртку. Прямой вызов адаптера — нарушение
  инварианта.
- **TLS/прокси** — единый egress-слой (ADR-099): провайдеры ходят только через `egressFetch`,
  собственных HTTP-агентов не создают; доверие CA/mTLS и маршрут через прокси задаются секцией
  `security.tls`/`proxy` и применяются при старте.
- **Prompt-cache** — ADR-070: `SystemPromptPayload` (`text`/`stablePrefix`/`cacheKey`/`cachePolicy`/
  `stableToolCount`) проходит через Gateway без изменений, маркеры ставятся в провайдере уже после
  guard/обфускации; статистика попадания — `usage.ts` (`cacheReadTokens / inputTokens`).
- **Метрики** — ADR-094: `synth_llm_requests_total`, `synth_llm_duration_seconds`,
  `synth_llm_tokens_total` (лейблы `provider`/`model`/`outcome`, без id сессий); каталог —
  [OBSERVABILITY.md](./OBSERVABILITY.md).
- **Ошибки** — таксономия ADR-041 (`classifyLlmError`/`isLlmErrorRecoverable`,
  `engine/llm-error.ts`): транспортные ошибки ретраятся, invalid-output (в т.ч. incomplete-stream)
  — нет; тексты движка — через ключи `shared/i18n`.
- **Вложения** — ADR-115: модальности — данные каталога; guard/обфускация работают только с
  текстом, метаданные срезаются `stripMetadata` на границе отправки.

## 10. Диагностика: симптом → причина → настройка

| Симптом | Причина | Что настроить |
|---|---|---|
| `400` «The `reasoning_content` in the thinking mode must be passed back to the API» | Провайдер/модель DeepSeek-совместимого шлюза с «не-дефолтным» именем: эвристика не сработала, assistant-сообщения уходят без reasoning-поля | `compatibility.requireReasoning: true` (и/или `reasoningField` с фактическим именем поля) на провайдере или модели |
| `400` по `thinking`/`signature` (Anthropic) | thinking в этом запросе выключен, а история содержит блоки; или подпись потеряна при мульти-блочном ответе | не смешивать `reasoningLevel` в одной сессии; подпись хранится по блокам (§6.2) — проверить, что запись не создана старым ядром; для шлюзов без подписи — `reasoningLevel: none` |
| `400` «max_tokens must be greater than thinking.budget_tokens» | Лимит вывода меньше бюджета thinking (жёсткий бюджет при малом `max_tokens`) | бюджет теперь считается от фактического `max_tokens` (§6.1); если `max_tokens ≤ 1024` — thinking отключается сам; поднять `maxOutputTokens` модели/`maxTokens` провайдера |
| `temperature` не действует при thinking (Anthropic) | API требует `temperature: 1` при включённом thinking | так и задумано; для управления вариативностью — `reasoningLevel` ниже или thinking выключить |
| `tool_choice: required` не срабатывает при thinking | Anthropic запрещает принудительный вызов при thinking — коэрсится в `auto` | убрать `required` или выключить thinking |
| Стрим обрывается ошибкой «Провайдер закрыл стрим без finish_reason» | `requireFinishReason: true` (дефолт), а сервер не присылает `finish_reason` | `compatibility.requireFinishReason: false` для этого провайдера/модели (ошибка невосстановимая, ретраи не помогут) |
| Кэш промпта не работает | провайдер кеширует только по inline-маркерам, а `cacheFormat` не задан (работает `prompt_cache_key`), либо наоборот | выставить `compatibility.cacheFormat: anthropic`/`alibaba` (тогда `prompt_cache_key` не отправляется) либо убрать его и пользоваться implicit caching |
| Задвоение/лишние маркеры кэша | `cacheFormat` задан, но прокси/шлюз сам ставит `cache_control`; либо маркеры уже пришли в теле | бюджет ≤ 4 считается с учётом уже стоящих маркеров; при собственном кэше шлюза `cacheFormat` не задавать; `cachePolicy: 'none'` отключает маркеры для отладки |
| Модель вызывает инструменты на шаге-лимите (Ollama) | нативный `/api/chat` не знает `tool_choice` | ожидаемое поведение: вызовы не исполняются, приходит детерминированный отчёт (§7.4); поднять `maxSteps` агента |
| `tool_choice` не поддерживается (`400` unknown field / игнор) | нестандартный сервер | `compatibility.supportsToolChoice: false` (для нативного Ollama — уже дефолт) |
| `usage` в стриме нулевой | сервер не поддерживает `stream_options` | `compatibility.streamUsage: false` (запрос перестанет нести непонятное поле; usage останется нулевым) |
| `400` про `output_config` / `effort` (Anthropic) | включён `supportsEffortUpdates`, а шлюз поля не знает; либо модель не effort-тира | убрать `supportsEffortUpdates` (вернётся прежний режим `thinking`); тиры `xhigh`/`max` отправлять только после проверки на живом провайдере (задаются в настройках агента/сессии — селект «Усилие рассуждений») |

## 11. Известные ограничения

- **`supportsEffortUpdates` реализован частично.** Effort-режим Anthropic (`output_config.effort`,
  §6.1) включается только явным флагом; тир берётся из `effort` агента/сессии (админка «Агенты»,
  `AgentDefinition.effort`/`SessionSettings.effort`), затем из `reasoningLevel` (`low|medium|high`),
  либо из явного `ChatOptions.effort`. Отличие от opencode: там effort-маркеры переносятся в истории
  (system-сообщение с партом `effort`) и есть mid-turn UI-смена уровня. У нас effort применяется **на
  запрос**: смена уровня между ходами подхватывается, но маркеров в истории нет и кэш промпта при
  смене уровня может инвалидироваться. **Mid-turn смена усилия не подхватывается**: `PATCH` во время
  хода применяется только со следующего хода — дешёвого чтения настроек нет (`loadLight` в файловой
  реализации парсит всю сессию), нужен отдельный `SessionRepository.loadSettings`/кэш настроек с
  инвалидацией (остаток). Гибрид **исправлено**: `RemoteProvider` отправляет `reasoning_effort` в LLM
  Proxy (stream и non-stream; `undefined` — поля нет), guard остаётся на удалённой стороне (§5.9).
  Официальный `api.anthropic.com` в effort-режиме не проверялся (проверки — на моках).
- **Фильтр thinking-блоков — роль агента + пара `provider/model`.** Блоки отбрасываются, только
  когда обе половины пары известны — и у сообщения, и у текущего запроса — и они расходятся;
  legacy-сообщения без пары сохраняют прежнее поведение (`sessionMessagesToLlm(..., currentPair)`).
  Остаток: `buildPromptHistoryInfo` пару не передаёт, поэтому счётчик reasoning-символов в диагностике
  промпта может учитывать блоки, которые в запрос не уйдут (косметика статистики). Подпись реплеится
  только когда thinking включён в этом запросе.
- **Официальный `api.anthropic.com` не прогонялся** живьём: проверки thinking round-trip и
  prefill шага-лимита сделаны на Anthropic-совместимом RouterAI (qwen) и на `deepseek-anthropic`.
  Для строгого Anthropic поведение prefill при включённом thinking стоит перепроверить.
- **`tool_choice: 'none'` + `tools` на `deepseek-anthropic` не проверен.** Это путь шага-лимита; при
  появлении `400` на этом эндпоинте смотреть сюда.
- **`cacheFormat` без авто-эвристик.** Формат inline-маркеров включается только явным значением;
  автоматически по имени/URL провайдера не выводится (чтобы существующие записи каталога не начали
  ставить маркеры). То же — `maxTokensField`, `streamUsage`, `requireFinishReason`.
- **Env-синхронизация провайдеров (`SYNTH_PROVIDER_*`) не переносит `compatibility`** (и
  `timeout`/`currency`/`icon`) — эти поля задаются API/JSON каталога; env-провижининг годится для
  первичной настройки, не для тонкой совместимости.
- **Только токенные тарифы** попадают в цены при синхронизации каталога: тарифы `request`/`second`/
  `image`/`search_unit` игнорируются (цена останется незаполненной).
- **Модальности без справочника.** Если каталог провайдера модальностей не сообщает, ограничения не
  применяются: несовместимый тип отклоняет сам провайдер (ошибка вместо тихой потери — но и без
  предварительной проверки).
