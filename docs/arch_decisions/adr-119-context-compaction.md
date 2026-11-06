# ADR-119: Сжатие контекста — суммаризация и компактизация как два взаимоисключающих режима

> **Статус:** ✅ Реализовано — решение принято 2026-11-03; движок, промпты, API, UI и тесты в коде (см. «Статус в коде»).
> **Дата:** 2026-11-03
> **Связано:** [ADR-070](./adr-070-system-prompt-composer.md) (композер и блок `summary`),
> [ADR-118](./adr-118-message-stream-v2.md) (поток хода, события, `messageModel`),
> [ADR-036](./adr-036-llm-gateway.md) (все LLM-вызовы через `GatewayProvider`),
> [ADR-096](./adr-096-storage-layer.md) (порты хранения; история — только через `SessionManager`),
> [ADR-005](./adr-005-json-storage.md) (атомарная запись истории),
> [ADR-041](./adr-041-llm-error-taxonomy.md) (таксономия ошибок, `context_length`),
> [PROP-062](./prop-062-context-optimization.md) (исходное предложение).

## Контекст

История сессии растёт неограниченно: длинная работа над кодом упирается в контекстное окно
модели, а простая передача всей истории приводит либо к ошибке `context_length`, либо к
деградации качества и росту стоимости. Прежний механизм знал только «скользящее окно» и
суммаризацию с границей по числу сообщений (`head`/`tail` в сообщениях): это не давало ни
предсказуемого хвоста в токенах, ни рабочего состояния по проекту (пути, команды, ошибки), а
при переполнении ход просто падал.

Нужны два разных продукта сжатия: **итоги беседы** (для разговорных сессий) и **рабочее
состояние по коду/проекту** (для инженерных). Оба должны: сохранять последние сообщения
дословно, не терять закреплённое, не рвать пары tool-вызовов, переживать переполнение
контекста и быть наблюдаемыми в UI.

## Решение

1. **Один переключатель — `contextOptimization`**, значения `none` | `sliding_window` |
   `summarization` | `compaction`; режимы **взаимоисключающие**, источник истины — это поле
   (не набор флагов). Дефолт новых сессий — `compaction` (`context.defaults`).
2. **`summarization` — итоги беседы**: о чём говорили, к чему пришли, открытые вопросы,
   следующие шаги; вызовы инструментов в транскрипте обобщаются.
3. **`compaction` — рабочее состояние по коду/проекту**: Objective / Requirements / Decisions /
   Work State / Next Move / Relevant Files / Important Context — точные пути, команды, строки
   ошибок, состояние workflow.
4. **Хвост — в токенах, а не в сообщениях**: `summarizationKeepTokens` (5000) и
   `compactionKeepTokens` (15000); `0` — без хвоста (для суммаризации). Хвост остаётся
   **живыми** сообщениями и никогда не покрывается резюме.
5. **Сжатие — отдельный LLM-вызов**, **всегда** через `GatewayProvider` (ADR-036,
   инвариант 3). Guard и обфускация, а также остальные слои шлюза (`pre_request`-фильтры,
   аудит, rate limit) действуют по глобальной политике `llmGateway.enabled`: при
   выключенном шлюзе обёртка — passthrough (guard/обфускация no-op; ADR-090 — фильтры
   требуют включённого gateway), при включённом — те же, что у обычного хода. Метрики
   (`synth_llm_*`) учитывают вызов суммаризации всегда. Провайдер суммаризации может
   быть задан отдельно (`summarization.provider`/`model`, иначе — провайдер сессии):
   транскрипт уходит именно этому получателю, поэтому для чувствительных данных
   включайте gateway. Расход (`usage`) сохраняется на сообщении-резюме (роль агента
   `summary`) и виден в статистике сессии.
6. **Резюме — сообщение истории** (`role: summary`) с `summaryOf` (покрытый префикс) и
   `metadata {type:'auto_summary', mode, keepFrom}`; покрытые сообщения получают `disabled=true`
   и `metadata.compactedBy`, но не удаляются.
7. **Резюме попадает в системный промпт** блоком `summary` (композер, volatile, order 30,
   ADR-070), а история для LLM — живой хвост + новые сообщения.
8. **Переполнение контекста восстанавливается одним принудительным сжатием** и повтором шага
   с синтетическим чекпоинтом; второй overflow — штатная ошибка.
9. **Событие `context.summarization_applied`** — единственный сигнал «сжатие применено»
   (обычный путь, ручной запуск, overflow); UI по нему снимает плашку и перечитывает историю.

## Режимы и параметры

| Поле (`SessionSettings` / `context.defaults`) | Дефолт | Смысл |
|---|---|---|
| `contextOptimization` | `compaction` (новая сессия) | режим: `none` \| `sliding_window` \| `summarization` \| `compaction` |
| `summarizationTriggerMode` | `messages` | триггер суммаризации: `messages` (N реплик) \| `tokens` (% окна) |
| `summarizeAfterN` | `10` | реплик пользователя с последнего SUMMARY (≥1) |
| `summarizeTokenThreshold` | `50` | порог суммаризации, % окна модели (1..100) |
| `summarizationKeepTokens` | `5000` | хвост дословно, токены (0 — без хвоста) |
| `compactionTokenThreshold` | `85` | порог компактизации, % окна модели (1..100) |
| `compactionKeepTokens` | `15000` | хвост дословно, токены |
| `summarizationHeadMessages` / `summarizationTailMessages` | `2` / `3` | **deprecated**: сохранены в схеме, движком не используются |
| `summarizationEnabled` | `true` | legacy-флаг: гейтит только легаси-фоллбек `none + true` |

`sliding_window` и его параметры (`slidingWindowMode`/`MessageLimit`/`TokenThreshold`)
не меняются и сжатия в SUMMARY не запускают.

## Механика

- **Граница хвоста.** Кандидаты — активные сообщения после последнего SUMMARY (не `pinned`,
  не `disabled`, не `hidden`/`ephemeral`, не `INFO`/`SUMMARY`). Токены считаются с конца;
  граница сдвигается вперёд до ближайшего `user`-сообщения, чтобы не разорвать ход и пары
  tool-вызовов. `keepTokens = 0` без нижней границы — хвоста нет.
- **Что покрывается.** Только префикс до границы хвоста. `pinned` не отключаются никогда;
  покрытые сообщения остаются в истории с `disabled=true` и `metadata.compactedBy = mode`
  (видны в UI как отключённые, но не теряются).
- **Резюме.** Сообщение `role: summary` пишется в конец истории через `SessionManager`
  (порт хранения, ADR-096/ADR-005) с `summaryOf` = покрытые индексы и `metadata`
  `{type:'auto_summary', mode, keepFrom}`; принудительное сжатие добавляет `reason`.
- **Порядок для LLM.** `ContextOptimizer.getMessagesForLlm` отдаёт `[SUMMARY] + живой хвост`;
  при сборке запроса (`phases/process-setup.ts`) SUMMARY **вынимается** в системный блок
  `summary` (volatile, order 30, ADR-070), а история — хвост + новые сообщения. Дублирования
  нет: резюме живёт в системном промпте, не в истории.
- **Идемпотентность.** Ручной прогон (`summarize`) кэширует результат по ключу
  `session:mode:coveredIndices` + хеш входа; повтор на неизменном транскрипте LLM не вызывает.

## Триггеры и оценка

- **Оценка токенов** — `inputTokens + outputTokens` последнего assistant-сообщения **той же
  пары провайдер/модель** плюс оценка активных сообщений после него (калиброванный
  chars-per-token, ADR-070). Измерение, лежащее **до последнего SUMMARY**, не используется
  (промпт изменился) — тогда оценивается вся выборка `getMessagesForLlm`.
- **Суммаризация, `messages`** — число реплик пользователя после последнего SUMMARY ≥
  `summarizeAfterN`.
- **Суммаризация, `tokens`** — оценка ≥ `summarizeTokenThreshold`% окна.
- **Компактизация — только токены**: порог = `окно − max((100 − pct)% окна, 16000)`, то есть
  резерв — не меньше 16k токенов. Если резерв ≥ окна (малые окна 8k/16k) — авто-триггер
  выключен (порог не клампится в 1 токен). **Неизвестное окно (`0`)** — не «выключено»:
  все авто-триггеры считают от fallback-оценки `DEFAULT_CONTEXT_WINDOW = 200000`
  (`shared/src/model-metadata.ts`) — той же величины, что показывает индикатор контекста в UI
  (единый источник константы). Явно заданное окно модели (`ModelConfig.contextWindow` или
  справочник) всегда приоритетнее. Ручной запуск и overflow работают всегда.
- **Триггер не сжимает сразу**: по завершении хода ставится `summarizationPending` и
  публикуется `context.summarization_pending`; сжатие выполняет процессор очереди отдельным
  служебным сообщением (`type: 'summarization_request'`) перед следующим ходом. `canCompress`
  (есть что покрывать) — дополнительный гейт, чтобы не запускать вызов впустую.

## Промпты и валидация

- `packages/core/prompts/system/SUMMARIZER.{ru,en}.md` — итоги беседы: о чём говорили, к чему
  пришли, открытые вопросы, следующие шаги.
- `packages/core/prompts/system/COMPACTOR.{ru,en}.md` — рабочее состояние: Objective,
  Requirements, Decisions, Work State (Completed/Active/Blocked), Next Move, Relevant Files,
  Important Context. Транскрипт подаётся с обобщёнными tool-вызовами: аргументы ≤ 120
  символов, успешный результат — без тела (первая строка ≤ 120 либо счётчик), ошибка ≤ 300;
  на нижних уровнях бюджета лимиты ужимаются (300/200/120/80, аргументы до 80).
- **Валидация ответа**: компактизация требует ≥ 2 заголовков шаблона, суммаризация —
  непустой ответ (≥ 20 символов). Первый невалидный ответ — **один nudge-повтор** с
  требованием формата; снова невалидно — ошибка сжатия (ход не портится).
- `finish_reason: max_tokens|length` → `context.compression_output_limit`;
  `content_filter` → ошибка сжатия. Промпты ищутся с override из `{dataDir}/user/system/`
  (общий механизм `ContextConfig`, ADR-070).

## Бюджет запроса сжатия

- Окно — у модели **компрессора**; на транскрипт остаётся `окно − max(4000, 20% окна)`
  токенов (резерв на системный промпт и ответ). Окно неизвестно — бюджет не применяется.
- При нехватке — уровни усечения от старых к новым: сначала ужимаются tool-результаты
  (300→200→120→80) и аргументы (120→80), затем бинарным поиском выбрасывается минимальное
  число **самых старых** сообщений с маркером «пропущено N». Последний `user`-ход не
  выбрасывается никогда.
- Для компактизации в запрос дополнительно кладётся хвост («останется дословно»), если он
  влезает в бюджет; раздел нужен только для Work State / Next Move.

## Overflow

1. Ошибка распознаётся как `ContextLengthExceededError` либо `classifyLlmError(...) ===
   'context_length'` (ADR-041).
2. **Одно** принудительное сжатие за ход (флаг `overflowRecoveryAttempted`): план строится на
   текущей истории, резюме сохраняется, покрытые сообщения отключаются, публикуется
   `context.summarization_applied` с `reason: 'overflow'`.
3. Повтор шага: системный промпт **не пересобирается**; сообщения = синтетический
   `[CONTEXT CHECKPOINT]` (user) + живой хвост + текущий ход. Пересечение хвоста и текущего
   хода схлопывается по наибольшему суффиксу; пары tool-вызовов проверяются
   (`hasValidToolPairs`) — разорваны, повтора нет.
4. Отказ от повтора (нечего сжимать, нет провайдера/промпта, частичный текст шага уже записан,
   пары разорваны) — исходная ошибка отдаётся штатно. **Второй** overflow — штатная ошибка
   (повторной попытки нет).
5. При `none`/`sliding_window` сжатие не запускается (`mode_disabled`), overflow остаётся
   обычной ошибкой хода.

## Совместимость и легаси

- **Legacy-фоллбек**: `contextOptimization: 'none'` + `summarizationEnabled: true` у сохранённой
  сессии трактуется как `summarization` (старые сессии не ломаются и не мигрируются).
- `summarizationEnabled` больше не гейтит явный режим — только легаси-фоллбек; UI по-прежнему
  отправляет его как производный флаг (`true` для любого режима, кроме `none`).
- `summarizationHeadMessages`/`summarizationTailMessages` сохранены в схеме и API, но движком
  не используются (граница хвоста — в токенах). Поля помечены `@deprecated`.
- `sticky_notes` остаётся legacy-значением сохранённых сессий (в дефолтах и UI не
  предлагается); заметки работают независимо от режима.
- История не мигрируется: старые SUMMARY читаются как есть, новый режим применяется к
  следующим сжатиям.

## API и UI

- `GET/PATCH /api/v2/sessions/:id/optimization` (backend): отдают/принимают
  `context_optimization`, `summarization_trigger_mode`, `summarize_after_n`,
  `summarize_token_threshold`, `summarization_keep_tokens`, `compaction_keep_tokens`,
  `compaction_token_threshold` (плюс прежние поля окна и deprecated head/tail).
- `POST /api/v2/sessions/:id/optimization/check` — аддитивный блок `compression`
  `{triggered, reason, mode, currentTokens?, threshold?, userCount?, limit?}` рядом с
  `sliding_window`/`summarization`.
- `POST /api/v2/sessions/:id/summarize` — ручной запуск (полное покрытие активной истории);
  `cancel-summarization` снимает ожидание.
- UI: правая панель «Контекст» — три взаимоисключающих блока-тумблера (скользящее окно,
  суммаризация, компактизация) с полями хвоста/порогов; при легаси-сессии
  (`none + summarization_enabled`) показывается суммаризация. Админка «Контекст» —
  стратегия + секции суммаризации (триггер, keep-токены) и компактизации (порог, keep-токены).

## Занятость контекста: источник истины

- **Источник истины один** — серверная оценка `estimatePromptTokens`: тот же счётчик, что
  триггерит авто-сжатие. Замеры, сделанные на промпте **до последнего SUMMARY**, отбрасываются
  (M2) — после компактизации они неактуальны.
- **Отдаётся клиенту:** `context_usage {tokens, limit, estimated}` в detail-DTO сессии
  (`GET /api/v2/sessions/:id`; в списочных сводках — нет) и `context_tokens`/`context_limit`
  в событии `context.summarization_applied` — значение **после** `disableCompressedMessages`.
  `usage` в этом событии — расход вызова сжатия, а не занятость окна.
- **Правило для UI:** занятость контекста нельзя выводить из `usage` последнего
  assistant-сообщения без учёта последнего SUMMARY; `usage` служебного шага сжатия (весь
  транскрипт на входе) занятостью окна **не является** — такой шаг помечен
  `kind: 'compression'` (`step.started`/`step.finished`).
- **Причина правила:** до его фикса индикаторы в шапке чата и на панели «Контекстное окно»
  «залипали» на до-сжатом уровне после авто-компактизации (в т.ч. в локальной сессии
  гибридного режима).

## Альтернативы

- **Один режим сжатия.** Отклонено: разговорным сессиям нужны итоги и открытые вопросы, а
  инженерным — точные пути, команды и состояние workflow; один шаблон ухудшает оба сценария.
- **Хвост в сообщениях (`head`/`tail`).** Отклонено: число сообщений не отражает объём
  контекста (одно сообщение с огромным tool-результатом); токены — предсказуемая граница.
- **Сжатие «на лету» внутри хода при каждом вызове.** Отклонено: скрытые LLM-вызовы посреди
  хода ломают предсказуемость, стриминг и учёт; сжатие — отдельный служебный ход.
- **Удаление покрытых сообщений.** Отклонено: история нужна для аудита, экспорта, повторного
  чтения и отладки; `disabled` сохраняет данные и скрывает их из LLM.
- **Отдельный агент-суммаризатор.** Отклонено: достаточно промпта и модели компрессора
  (дефолт — модель сессии, override `context.summarization.*`), меньше сущностей и прав.

## Последствия

- Стоимость и латентность: одно сжатие = один LLM-вызов (не потоковый) + возможный nudge;
  расход виден на сообщении-резюме (роль агента `summary`) в статистике сессии.
- Кэш промпта: после сжатия меняется системный блок `summary` (volatile) и история — префикс
  кэша инвалидируется. Это осознанная плата за возврат в окно.
- Качество: компактизация сохраняет рабочее состояние, но не дословный транскрипт; хвост
  ограничен токенами, поэтому длинные tool-результаты в хвосте «переживают» сжатие только в
  пределах бюджета.
- `pinned` и хвост неприкосновенны; покрытые сообщения остаются в истории (аудит, экспорт).
- Неизвестное окно оценивается как 200k (консервативно): у модели с реальным окном больше
  200k сжатие наступит раньше, у модели с меньшим окном предохранителем остаются
  `context.windowPolicy` и штатная ошибка `context_length`. Осознанный выбор: молча не
  сжимать (как раньше) хуже, чем сжать чуть раньше — UI и бэкенд считают по одной величине.
- Наблюдаемость: `context.summarization_pending` → `context.summarization_applied` с
  `reason`/`mode`/`covered_indices`/`keep_from`/`usage`.

## Статус в коде

- Движок: `packages/core/src/engine/context/optimizer.ts` (`effectiveMode`, `shouldCompress`,
  `estimatePromptTokens`, `prepareCompression`, `completeCompression`, `canCompress`),
  `engine/context/config.ts` (промпты), `engine/context/builder.ts` (блок `summary`).
- Применение: `engine/orchestrator/compression.ts` (`disableCompressedMessages`,
  `forceCompression`), `engine/orchestrator/overflow.ts` (чекпоинт и повтор),
  `engine/orchestrator/phases/process-finalize.ts` (триггеры), `engine/queue/processor.ts`
  (служебный ход сжатия), `engine/orchestrator/summarization.ts` (ручной/авто-прогон).
- Промпты: `packages/core/prompts/system/{SUMMARIZER,COMPACTOR}.{ru,en}.md`.
- Схема/дефолты: `packages/shared/src/{schemas,config/defaults,types/session}.ts`.
- API: `packages/backend/src/routes/sessions.ts` (`/optimization*`).
- UI: `packages/ui/src/components/panels/ContextTab.tsx`,
  `components/admin/ContextDefaultsSettings.tsx`, `stores/transportStore.ts`.

## Тесты

- `packages/core/src/engine/context/optimizer.test.ts`, `optimizer-compression.test.ts`,
  `optimizer-compatibility.test.ts` — триггеры, граница хвоста, бюджет, валидация.
- `packages/core/src/engine/orchestrator/compression.test.ts` — применение, `disabled`/
  `compactedBy`, событие.
- `packages/core/src/engine/orchestrator/overflow.test.ts`,
  `orchestrator-overflow.test.ts` — чекпоинт, повтор, пары tool-вызовов, второй overflow.
- `packages/core/src/engine/orchestrator/summarization.test.ts` — ручной/авто-прогон, события.
- `packages/shared/src/{schemas,config}/*.test.ts` — дефолты и границы значений.
- `packages/core/src/server/routes/settings-context-defaults.test.ts` — API дефолтов.
- `packages/ui/src/stores/transportStore.context-summarization.test.ts` — реакция UI на
  `context.summarization_applied`.

## История

- 2026-11-03 — принято и реализовано: два режима сжатия (`summarization`/`compaction`),
  хвост в токенах, триггеры, overflow-восстановление, событие `context.summarization_applied`.
