# ADR-084: Decision-модели (Clef/Clef-Flash) в маршрутизации и быстрых ответах

> **Статус:** ✅ Реализовано — адаптер/конфиг, Clef-Flash в micro, decision-классификатор
> маршрутизации, decision-роутинг событий (ADR-089), UI-настройки, эскалационный тир
> `primary → escalation`, агрегатные метрики и мультимодальный контракт (источник изображений —
> [PROP-085](./prop-085-multimodal-input.md)).
> **Дата:** 2026-10-04
> **Обновлено:** 2026-10-10 — Ф6–Ф8: **эскалация** (вторая пара `escalationProvider`/`escalationModel`,
> единый каскад `decision-cascade.ts` `primary → escalation`), **агрегатные метрики**
> (`decision-metrics.ts`; `GET/DELETE /settings/decision/metrics`), **мультимодальный контракт**
> (`images`/`videos` в `DecisionRequest`/`decide`/`MicroInput`; источник медиа —
> [PROP-085](./prop-085-multimodal-input.md)). Ранее (Ф1–Ф5): `DecisionProvider`, `GatewayProvider.decide`,
> `DecisionModel` (micro), `DecisionContentClassifier` (router), `DecisionRuleProvider` (events),
> конфиг `decision` + `events.decisionRouting`, runtime-API `/settings/decision`, UI «Decision-модели».
> **Источник:** исследование 2026-10-04 — Cloudflare выпустил decision-модели Clef/Clef-Flash (2026-10-01);
> рассмотрены в контексте [ADR-034](./adr-034-model-routing.md) и [ADR-035](./adr-035-micro-model-first.md).
> **Связано:** [ADR-034](./adr-034-model-routing.md), [ADR-035](./adr-035-micro-model-first.md),
> [ADR-036](./adr-036-llm-gateway.md), [ADR-023](./adr-023-configuration.md), [ADR-029](./adr-029-granular-permissions.md),
> [ADR-070](./adr-070-system-prompt-composer.md), [PROP-073](./prop-073-client-integrity-hybrid.md),
> [PROP-080](./prop-080-managed-hybrid-modes.md), [PROP-081](./prop-081-hybrid-policy-leak-protection.md),
> [PROP-085](./prop-085-multimodal-input.md).

**Решение:** добавить в Synth класс **decision-моделей** — моделей, которые за один forward-pass возвращают
вероятность для каждого допустимого варианта каждого вопроса, без генерации свободного текста и без парсинга
ответа. Использовать их в слое **«Быстрые ответы»** и в классификаторе **«Маршрутизации»**:

- **Clef-Flash** — быстрый слой: заменяет/усиливает текущий `micro_llm`-этап каскада [ADR-035](./adr-035-micro-model-first.md)
  (низкая latency, 64K, мультимодальность);
- **Clef** — точный и мультимодальный: на эскалацию и сложные/визуальные решения;
- **Chat-LLM остаётся** для генерации и рассуждений — decision-модель его **не заменяет**.

## Контекст

### Что такое decision-модели

**Decision-модель** (эталон — **Jev** от Typesafe AI, System One) — это не чат-модель. Она не пишет текст, а
отвечает на **типизированный вопрос** о переданном состоянии, возвращая вероятность по каждому допустимому
варианту. Ответ структурирован по построению, поэтому не требует парсинга свободного текста, JSON-схем и
retry-логики.

Cloudflare 2026-10-01 выпустил сразу две такие модели — **Clef** и **Clef-Flash**, совместимые по API с
Jev/SystemOne и нативно хостящиеся на Workers AI. Ключевые отличия от Jev: типизированные вероятностные
ответы, **non-autoregressive** инференс (prefill-only + параллельный скоринг схемы), контекст **64K**, опциональная
**мультимодальность** (vision encoder; на входе `images`/`videos`), лицензия **Apache-2.0**, веса на Hugging Face
и community-кванты для локального запуска.

### Как устроены ADR-034 и ADR-035 сегодня

- **ADR-034** — Router-слой со стратегиями `content` / `confidence` / `cost`; классификация типа запроса
  (coding / research / chat) — **по ключевым словам**.
- **ADR-035** — двухуровневый каскад **rules → embedding → micro_llm → LLM fallback**. Микро-модель возвращает
  `{label, confidence}` со статусом `OK`/`UNSURE`. Код — `packages/core/src/engine/router/micro/`
  (`MicroPipeline`, `models/rules-model.ts`, `models/embedding-model.ts`, `models/micro-llm-model.ts`,
  `tasks/small-talk.ts`, `tasks/classify-intent.ts`, `tasks/enum-decision.ts`). Включается `session.microFirst`.
  Метрики — в `DebugCollector` (`micro.handled`, `micro.fallback`, `micro.latency_by_model`).

**Слабое место, которое закрывают decision-модели:**

1. **Generic микро-LLM + парсинг/порог.** Этап `micro_llm` — это обычная генеративная LLM малого размера:
   ответ приходит текстом, который нужно распарсить, провалидировать по схеме и сравнить `confidence` с порогом.
   Ошибка формата → `UNSURE` → лишний fallback; калибровка вероятности не гарантируется.
2. **Классификация по словарям.** `content`-классификатор ADR-034 и `tasks/*` ADR-035 опираются на ключевые слова
   и правила — предсказуемо, но хрупко к перефразировкам и новым формулировкам.
3. **Стоимость/латентность.** Гонять генеративную модель даже ради одного enum-решения — дороже и медленнее,
   чем один forward-pass decision-модели.

Decision-модель даёт ровно то, что нужно микро-слою: типизированный ответ с вероятностью, без парсинга и без
свободной генерации.

### Справочная таблица моделей

| Модель | База | Мультимодальность | Контекст | Latency (median) | Лицензия | Источник |
|---|---|---|---|---|---|---|
| **Clef** | `Qwen/Qwen3.8-27B` | да (vision encoder) | 64K | 209.3 мс | Apache-2.0 | Cloudflare, HF, Workers AI |
| **Clef-Flash** | `Qwen/Qwen3.5-9B` | да (vision encoder) | 64K | 38.8 мс | Apache-2.0 | Cloudflare, HF, Workers AI |
| **Jev** (System One) | — | нет (text-only) | 32K | 524.1 мс | — | Typesafe AI |

- В карточках приводятся также p95-значения задержки — **122.4 / 238.6 / 536.0 мс** (по данным Cloudflare).
- Community-кванты: **GGUF** (bartowski, ggml-org, llama.cpp), **MLX** (mlx-community, Apple Silicon),
  **FP8/NVFP4** (vLLM).
- API Clef/Clef-Flash полностью совместим с Jev/SystemOne.
- **Данные бенчмарков заявлены Cloudflare** и **требуют проверки на собственных задачах Synth**: по заявлению
  Cloudflare Clef/Clef-Flash обходят Jev в 3 из 4 end-to-end workflow (invoice processing, customer service,
  security incidents; в agent trace observability выше Jev). Полная таблица — Decision Index 0.2.1.

### Первоисточники

- Карточки: <https://huggingface.co/Cloudflare/clef>, <https://huggingface.co/Cloudflare/clef-flash>
- Блог: <https://blog.cloudflare.com/clef-decision-models>
- Лидерборд: <https://clef-evals.workers-ai-mle.workers.dev>
- Доки: <https://developers.cloudflare.com/workers-ai/models/clef>

## Типы вопросов

Decision-модель формулирует задачу как вопрос с заранее известным множеством вариантов; на выходе — вероятности.

| Тип | Смысл | Пример под задачу Synth |
|---|---|---|
| `noul` | булев вопрос (true/false) | `is_urgent` — «требует ли сообщение немедленной реакции?» |
| `choice` | выбор из именованных опций | `intent` — `{small_talk, classify, enum_decision, llm_task}` (аналог `task-classifier.ts`) |
| `score` | упорядоченные опции (шкала) | `complexity` — `{low, medium, high}` для решения об эскалации |

Вход — `state` (строка или JSON), опционально `images`/`videos`. Это позволяет переиспользовать уже
существующие в микро-слое задачи (`classify-intent`, `enum-decision`, `small-talk`) в типизированной форме.

## Интеграция в архитектуру

### 1. Отдельный `DecisionProvider` / адаптер

Decision-модель — **не chat-провайдер**. Вводится отдельный адаптер (назовём его `DecisionProvider`) с
контрактом «вопрос + state + варианты → вероятности», инкапсулирующий транспорт (локальный SystemOne-сервер
или Workers AI). Он не участвует в обычном `ProviderPool` генерации и не смешивается с chat-моделями.

### 2. Вызов через `GatewayProvider`

Любой вызов decision-модели идёт через `GatewayProvider` ([ADR-036](./adr-036-llm-gateway.md), инвариант №3
корневого `AGENTS.md`): guard, обфускация секретов, rate limit, аудит. Для локального инференса это тоже
обязательный слой (единая точка политики, даже если `state` не покидает инстанс).

### 3. Конфиг в `shared`

Новая секция конфигурации (например, `decision` / `micro.decision`) в `@itphx/synth-shared/config`
([ADR-023](./adr-023-configuration.md)): выбор режима **локальный инференс vs Workers AI**, адрес/провайдер,
модель (`clef` / `clef-flash`), таймауты, пороги. Приоритет — CLI > `SYNTH_*` env > config.yaml > defaults.

### 4. Встраивание в `engine/router/micro/`

Decision-модель оформляется как ещё одна реализация интерфейса `MicroModel` (`models/`) — наравне с
`rules-model`, `embedding-model`, `micro-llm-model`. Каскад ADR-035 расширяется:

```
rules → embedding → Clef-Flash → [Clef] → LLM fallback
```

- **Clef-Flash** встаёт на место (или сразу после) этапа `micro_llm` — параллельный скоринг схемы вместо
  генерации + парсинга.
- **Clef** подключается на эскалацию, когда нужна точность или задействована мультимодальность.
- **Эскалационный тир** (`escalationProvider`/`escalationModel`, необязательный) прогоняется единым
  каскадом `decideChoiceCascade` (`decision-cascade.ts`): `primary → escalation`. Переход — при низкой
  уверенности, невалидной метке, отсутствии ответа или ошибке основной модели; тир переиспользуется
  микро-моделью, `DecisionContentClassifier` и `DecisionRuleProvider`.

### 5. Классификатор «Маршрутизации»

Отдельный decision-вопрос `choice` заменяет/дополняет словарный `content`-классификатор ADR-034 для выбора
`coding` / `research` / `chat`. Вероятности дают честный сигнал для стратегии `confidence` и порога эскалации.

## Безопасность и политики

- `state` decision-модели **может содержать пользовательский контент** (сообщения, фрагменты файлов). Для
  managed-инсталляций и чувствительных данных **по умолчанию — локальный инференс**; удалённый (Workers AI)
  — **только по политике**.
- Согласовать с политиками гибрида и защитой от утечек: [PROP-073](./prop-073-client-integrity-hybrid.md)
  (enforcement на сервере), [PROP-080](./prop-080-managed-hybrid-modes.md) (режимы-полюса),
  [PROP-081](./prop-081-hybrid-policy-leak-protection.md) (серверные политики, запрет утечек).
- Не логировать `state` в аудит, если он может содержать секреты; guard/обфускация [ADR-036](./adr-036-llm-gateway.md)
  применяются до отправки и в локальном, и в удалённом режиме.
- Decision-слой подчиняется permission-слою и режимам ([ADR-029](./adr-029-granular-permissions.md),
  ADR-025/ADR-028): его включение/поведение — настройка и политика, а не хардкод в тулах.

## Мультимодальность

`images`/`videos` на входе — **контракт готов** (Ф8): типы `DecisionRequest`/`DecisionMediaInput`
(`packages/shared/src/types/decision.ts`), `DecisionProvider.decide(state, questions, { images, videos })`
и `MicroInput`/`ClassifyRequest` принимают медиа-массивы; значения добавляются в тело запроса только
если непусты. Сквозной источник изображений/видео — мультимодальный ввод, который ещё не реализован:
это [PROP-085](./prop-085-multimodal-input.md); здесь же — только контракт-плумбинг. Применения —
классификация скриншотов, вложений, фрагментов UI («тип вложения», «нужна ли визуальная проверка»).

## Метрики

✅ **Реализовано (Ф5, Ф7).**

- **Агрегатные метрики** — `decision-metrics.ts` (`DecisionMetrics`, process-wide синглтон
  `decisionMetrics`): `calls` / `handled` / `fallback` / `escalated`, `attempts`
  (`primary`/`escalation`), `rejected` (статусы `ok`/`low_confidence`/`invalid`/`no_answer`/
  `no_provider`/`error`), `by_model` (`'<provider>/<model>'` → `calls`/`handled`/`latency_ms_avg`/
  `latency_ms_max`). Каждый итог `decideChoiceCascade` фиксируется в `recordOutcome` (в т.ч. при отказе).
- **Экспозиция** — `GET /api/v2/settings/decision/metrics` (`requireAuth`) → `{ metrics, ts }`;
  `DELETE /api/v2/settings/decision/metrics` (`decisionWriteGuard`) → сброс и `{ metrics }`.
  In-memory, сбрасываются при рестарте.
- **Микро/роутер** — `DebugCollector.addContext('decision' | 'decision_routing', …)`
  (+ `metadata.micro_first.decision`); сигнал перехода на эскалацию.
- **События (ADR-089)** — мета `confidence`/`signals` в `RouteDecision` (попадает в ответ
  `POST /events` и журнал) и лог успеха `[DECISION] … agent/confidence/latency/model`; latency
  добавлена и в warning-ветки промаха.

Возможный задел (сейчас не требуется): `decision.calibration` — сопоставление заявленной вероятности
и фактической корректности для мониторинга порогов.

## Этапы реализации

1. ✅ **Адаптер + конфиг + провайдеры.** `DecisionProvider` (типы провайдеров `decision` →
   `POST {base}/decisions` RouterAI и `systemone` → `POST {base}/v1/systemone` Ollama), секция
   `decision` в `shared`, подключение через `GatewayProvider.decide`.
2. ✅ **Clef-Flash в micro за флагом.** Новый `DecisionModel` (`MicroModelKind: 'decision'`) для задач
   `classify` / `enum_decision`; включается per-session флагом `decisionFirst` (ADR-035), старый
   `micro_llm`-путь сохранён — сравнение качества/латентности на своих данных.
3. ✅ **Clef на эскалацию.** Вторая пара `escalationProvider`/`escalationModel` (пусто — без
   эскалации): единый каскад `decideChoiceCascade` (`decision-cascade.ts`) идёт `primary → escalation`
   при низкой уверенности/невалидной метке/отсутствии ответа/ошибке основной модели; переиспользуется
   микро-моделью, `DecisionContentClassifier` и `DecisionRuleProvider`; переход observable (лог
   `[DECISION] … переход на эскалацию …`).
4. ✅ **Мультимодальный контракт (задел PROP-085).** `images`/`videos` в `DecisionRequest`/
   `DecisionMediaInput`, `DecisionProvider.decide(opts.images/videos)` и `MicroInput`/`ClassifyRequest`;
   прокидываются в тело запроса, только если непусты. Сквозной источник медиа — [PROP-085](./prop-085-multimodal-input.md).
5. ✅ **Decision-классификатор маршрутизации.** `DecisionContentClassifier` (ADR-034) — опциональный
   decision-вопрос `choice` `{coding|research|chat}` при низкой уверенности словарного
   `content`-классификатора; приоритет `routingCategory` не меняется.
6. ✅ **Интеграция в события (ADR-089).** `DecisionRuleProvider` (`name='decision-rules'`) —
   decision-шаг после `ProjectRuleProvider` при флаге `events.decisionRouting` (default off),
   fail-safe (ошибка/низкая уверенность → Router идёт дальше).
7. ✅ **UI-настройки и метрики.** Админ-секция «Decision-модели» (Settings UI Kit, ADR-072): пара
   провайдер/модель, пара эскалации, порог уверенности и read-only статистика (`GET/DELETE
   /settings/decision/metrics`); per-session флаг `decisionFirst`, events-тумблер `decisionRouting`.
8. ✅ **Документация.** `docs/ROUTING.md` обновлён (decision-уровень в «Быстрых ответах»/
   «Маршрутизации», эскалация и метрики); AD/AGENTS/API_V2/CONFIGURATION синхронизированы.

## Статус реализации в коде

✅ **Реализовано (Ф1–Ф8).**

- **Адаптер и транспорт:** `packages/core/src/providers/decision.ts` (`DecisionProvider`, типы
  провайдеров `decision` → `POST {base}/decisions` (RouterAI) и `systemone` → `POST {base}/v1/systemone`
  (Ollama) — endpoint выбирается по типу провайдера); регистрация
  `ProviderFactory.register('decision', …)`/`ProviderFactory.register('systemone', …)`
  (`providers/index.ts`), таймаут/`AbortController`, ошибки → `ProviderError`/`RateLimitError`/
  `ContextLengthExceededError`.
- **Gateway:** `GatewayProvider.decide(state, questions, opts?)`
  (`packages/core/src/engine/gateway/gateway-provider.ts`) — guard/обфускация `state`, rate limit, аудит;
  при блокировке/лимите бросает `ProviderError`/`RateLimitError`, вызывающий слой делает fail-safe откат.
- **Каскад:** `packages/core/src/engine/router/decision-cascade.ts` (`decideChoiceCascade`) — единый
  проход `primary → escalation` по необязательной паре `escalationProvider`/`escalationModel`
  (тир добавляется, только если задан и отличается от основной пары); фиксирует попытки и пишет
  метрики; fail-safe — исключения наружу не пробрасываются. Переиспользуется микро-моделью,
  `DecisionContentClassifier` и `DecisionRuleProvider`.
- **Метрики:** `packages/core/src/engine/router/decision-metrics.ts` (`DecisionMetrics`, синглтон
  `decisionMetrics`) — `calls`/`handled`/`fallback`/`escalated`, `attempts`/`rejected`/`by_model`.
- **Микро-слой (ADR-035):** `packages/core/src/engine/router/micro/models/decision-model.ts`
  (`DecisionModel`, `kind='decision'`) — в каскаде после embedding, за per-session флагом
  `decisionFirst`; старый `micro_llm`-путь сохранён.
- **Router (ADR-034):** `packages/core/src/engine/router/decision-content-classifier.ts`
  (`DecisionContentClassifier`) — опциональный decision-вопрос категории при низкой уверенности.
- **События (ADR-089):** `packages/core/src/engine/events/decision-rule-provider.ts`
  (`DecisionRuleProvider`, `name='decision-rules'`); регистрация в `server/app.ts` (core) и
  `backend/src/app.ts` после `ProjectRuleProvider`, fail-safe (`null` → Router идёт дальше);
  decision-вызов — через общий каскад.
- **Мультимодальный контракт (PROP-085 задел):** `images`/`videos` в `DecisionRequest`/
  `DecisionMediaInput` (`packages/shared/src/types/decision.ts`), `DecisionProvider.decide(opts.images/
  videos)` (`providers/decision.ts`) и `MicroInput`/`ClassifyRequest` (`engine/router/micro/types.ts`);
  добавляются в тело запроса, только если непусты.
- **Конфиг:** `@itphx/synth-shared/config` — секция `decision` (`enabled`/`provider`/`model`/
  `confidenceThreshold` + `escalationProvider`/`escalationModel`; `provider`/`escalationProvider` —
  имена провайдеров decision-протокола типа `decision`/`systemone`) +
  поле `events.decisionRouting`; env-резолверы `SYNTH_DECISION_PROVIDER`/`SYNTH_DECISION_MODEL`; типы
  `DecisionQuestion`/`DecisionAnswer`/`DecisionRequest`/`DecisionResponse` (`types/decision.ts`).
- **Runtime-API:** `GET/PUT/DELETE /api/v2/settings/decision` (`server/routes/settings.ts`,
  `decisionWriteGuard`), live-применение — `onDecisionChange`; снимок/сброс метрик —
  `GET /settings/decision/metrics` (`requireAuth`) и `DELETE /settings/decision/metrics`
  (`decisionWriteGuard`); runtime-стор — `DecisionRuntimeSettings` + `mergeDecisionConfig`
  (`storage/runtime-settings.ts`, включая escalation-поля).
- **UI:** `packages/ui/src/components/settings/DecisionSettings.tsx` — админ-секция «Decision-модели»
  (Settings UI Kit, ADR-072): основная пара провайдер/модель, пара эскалации, порог уверенности и
  read-only статистика; per-session `decisionFirst` (`SessionSettingsTab`), тумблер `decisionRouting`
  в настройках событий (`EventsSettings`).

## Риски и открытые вопросы

- **Локальный инференс:** транспорт `systemone` (Ollama, `POST /v1/systemone`) реализован, но требует
  Ollama **≥ 0.35.1** (в dev — 0.32.14) и `ollama pull clef-flash` (~11 ГБ). Обновление рантайма —
  отдельная задача `@admin` с бэкпом/тестом/откатом (риск: перезапуск Ollama).
- **Политика local/remote — зависимость, а не остаток ADR-084.** Транспорт задаётся типом провайдера
  (`decision` — RouterAI, `systemone` — Ollama); явного поля `mode` в конфиге нет по решению.
  Полноценная типизация политики (локально/remote, запрет утечек) появится вместе с
  [PROP-080](./prop-080-managed-hybrid-modes.md)/[PROP-081](./prop-081-hybrid-policy-leak-protection.md) —
  до тех пор управление идёт выбором провайдера.
- **Трафик в Cloudflare (remote)** при managed/чувствительных данных — снимается будущими политиками
  [PROP-080](./prop-080-managed-hybrid-modes.md)/[PROP-081](./prop-081-hybrid-policy-leak-protection.md).
- **Калибровка вероятностей и порогов** — заявленные вероятности требуют проверки; порог `OK`/`UNSURE` (сейчас
  фиксированный, ADR-035) может потребовать настройки. Агрегатные метрики (`by_model`, `rejected`) дают
  основу для наблюдения, но сопоставление вероятности и фактической корректности (`calibration`) сейчас
  не требуется.
- **Не путать с chat-LLM:** decision-модель не умеет генерировать и рассуждать; её нельзя ставить туда, где
  нужен свободный ответ.
- **Устаревание/доступность моделей:** Clef/Clef-Flash — новые (2026-10-01), API и хостинг могут меняться;
  Jev остаётся альтернативой/фоллбеком.
- **Официальные бенчмарки — заявленные Cloudflare;** переносить цифры в решения без собственной проверки нельзя.

## Связи

- [ADR-034](./adr-034-model-routing.md) «Routing между моделями» — decision-классификатор для стратегии `content`.
- [ADR-035](./adr-035-micro-model-first.md) «Micro-model first» — место decision-моделей в каскаде (замена/усиление `micro_llm`).
- [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — единственный путь вызова (guard/обфускация/rate limit/аудит).
- [ADR-023](./adr-023-configuration.md) «Конфигурация» — секция decision-моделей и приоритеты.
- [ADR-029](./adr-029-granular-permissions.md) «Гранулярные permissions» — decision-слой подчиняется permission/политикам.
- [ADR-070](./adr-070-system-prompt-composer.md) «SystemPromptComposer» — статистика/прозрачность вызовов (если уместно).
- [PROP-073](./prop-073-client-integrity-hybrid.md), [PROP-080](./prop-080-managed-hybrid-modes.md),
  [PROP-081](./prop-081-hybrid-policy-leak-protection.md) — целостность/режимы/политики гибрида и защита от утечек.
- [ADR-072](./adr-072-settings-ui-kit.md) — UI-настройки decision-слоя.
- [PROP-085](./prop-085-multimodal-input.md) «Мультимодальный ввод» — сквозной источник `images`/`videos`
  для мультимодального контракта decision-слоя.
- [docs/ROUTING.md](../ROUTING.md) — пользовательские слои «Быстрые ответы» и «Маршрутизация» (обновлено).
- [packages/core/AGENTS.md](../../packages/core/AGENTS.md) — код микро-слоя (`engine/router/micro/`).
