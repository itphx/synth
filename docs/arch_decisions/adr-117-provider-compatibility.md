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
   `streamUsage`, `supportsToolChoice`. `ProviderConfig.compatibility` — дефолты для всех моделей
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
   `redacted_thinking` собираются в стриме и non-stream (`reasoningSignature`, `reasoningRedacted`);
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
8. **UI.** В формах провайдера и модели — сворачиваемый блок «Расширенные параметры»
   (`components/admin/CompatibilityFields.tsx`): tri-state «Авто / Да / Нет» (явный `false` не
   схлопывается в «авто»), селект поля reasoning с вариантом «своё значение», «изменено»-бейдж;
   полная очистка у сущности с сохранёнными параметрами отправляет `compatibility: null`.

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
- **Цена:** контракт шире (6 полей × 2 уровня + shorthand), поверхность для расхождения UI/сервера.
  Риск закрыт replace-семантикой, строгой валидацией и unit-тестами payload/round-trip в UI.
- **Осознанные отличия от opencode:** дефолт `max_tokens`; `reasoningField` из ответа модели
  авто-детектится по известным полям (`reasoning_content`/`reasoning`), произвольное имя задаётся
  только конфигом.
- **Остатки:** авто-определения для `maxTokensField`/`streamUsage` нет (только явное значение или
  дефолт); существующие записи каталога не мигрируются (совместимость — через эвристики и дефолты);
  поведение при смене провайдера/модели у сохранённой подписи не проверяется отдельно (подпись
  реплеится только когда thinking включён в этом запросе).

## Статус в коде

Реализовано 2026-10-30 (`f3d1b780`, `e2a6e359`, `2d4f5763`, поверх `ea20dc45`):

- контракт и резолв — `packages/shared/src/types/provider.ts` (`ModelCompatibility`,
  `ResolvedModelCompatibility`, `detectCompatibilityHeuristics`, `mergeModelCompatibility`,
  `resolveModelCompatibility`, `parseModelCompatibilityInput`);
- провайдеры — `packages/core/src/providers/base.ts` (`resolveProviderCompatibility`), `openai.ts`,
  `ollama.ts`, `anthropic.ts` (`resolveThinkingBudget`, порядок блоков, подпись);
- проброс — `engine/router/{utils,provider-pool}.ts`, `server/app/deps.ts`, `backend/app/deps.ts`,
  шаги пайплайнов и aux-модели вложений;
- API — `server/routes/{providers,models}.ts`; UI — `components/admin/CompatibilityFields.tsx`,
  `lib/api/compatibility.ts`, панели `ProvidersPanel`/`ModelsPanel`; i18n ru/en;
- персист подписи — `packages/shared/src/types/{llm,message}.ts`,
  `storage/file-store.ts`, `packages/storage-postgres/src/migrations/028-message-reasoning-signature.ts`,
  контрактный паспорт порта сессий; наружу не сериализуется (`server/serialize.ts`);
- справка — [CONFIGURATION.md](../CONFIGURATION.md) §«Каталог моделей», [API_V2.md](../API_V2.md)
  §5.9/§5.10, `packages/{core,ui}/AGENTS.md`.

## История

- 2026-10-30 — принято (`f3d1b780` — слой совместимости, `e2a6e359` — UI, `2d4f5763` — Anthropic
  round-trip thinking и персист подписи).
