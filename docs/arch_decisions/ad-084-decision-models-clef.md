# AD-084: Decision-модели (Clef/Clef-Flash) в маршрутизации и быстрых ответах

> **Статус:** ⏳ Не реализовано (предложение)
> **Дата:** 2026-10-04
> **Источник:** исследование 2026-10-04 — Cloudflare выпустил decision-модели Clef/Clef-Flash (2026-10-01);
> рассмотрены в контексте [AD-034](./ad-034-model-routing.md) и [AD-035](./ad-035-micro-model-first.md).
> **Связано:** [AD-034](./ad-034-model-routing.md), [AD-035](./ad-035-micro-model-first.md),
> [AD-036](./ad-036-llm-gateway.md), [AD-023](./ad-023-configuration.md), [AD-029](./ad-029-granular-permissions.md),
> [AD-070](./ad-070-system-prompt-composer.md), [AD-073](./ad-073-client-integrity-hybrid.md),
> [AD-080](./ad-080-managed-hybrid-modes.md), [AD-081](./ad-081-hybrid-policy-leak-protection.md).

**Решение:** добавить в Synth класс **decision-моделей** — моделей, которые за один forward-pass возвращают
вероятность для каждого допустимого варианта каждого вопроса, без генерации свободного текста и без парсинга
ответа. Использовать их в слое **«Быстрые ответы»** и в классификаторе **«Маршрутизации»**:

- **Clef-Flash** — быстрый слой: заменяет/усиливает текущий `micro_llm`-этап каскада [AD-035](./ad-035-micro-model-first.md)
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

### Как устроены AD-034 и AD-035 сегодня

- **AD-034** — Router-слой со стратегиями `content` / `confidence` / `cost`; классификация типа запроса
  (coding / research / chat) — **по ключевым словам**.
- **AD-035** — двухуровневый каскад **rules → embedding → micro_llm → LLM fallback**. Микро-модель возвращает
  `{label, confidence}` со статусом `OK`/`UNSURE`. Код — `packages/core/src/engine/router/micro/`
  (`MicroPipeline`, `models/rules-model.ts`, `models/embedding-model.ts`, `models/micro-llm-model.ts`,
  `tasks/small-talk.ts`, `tasks/classify-intent.ts`, `tasks/enum-decision.ts`). Включается `session.microFirst`.
  Метрики — в `DebugCollector` (`micro.handled`, `micro.fallback`, `micro.latency_by_model`).

**Слабое место, которое закрывают decision-модели:**

1. **Generic микро-LLM + парсинг/порог.** Этап `micro_llm` — это обычная генеративная LLM малого размера:
   ответ приходит текстом, который нужно распарсить, провалидировать по схеме и сравнить `confidence` с порогом.
   Ошибка формата → `UNSURE` → лишний fallback; калибровка вероятности не гарантируется.
2. **Классификация по словарям.** `content`-классификатор AD-034 и `tasks/*` AD-035 опираются на ключевые слова
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

Любой вызов decision-модели идёт через `GatewayProvider` ([AD-036](./ad-036-llm-gateway.md), инвариант №3
корневого `AGENTS.md`): guard, обфускация секретов, rate limit, аудит. Для локального инференса это тоже
обязательный слой (единая точка политики, даже если `state` не покидает инстанс).

### 3. Конфиг в `shared`

Новая секция конфигурации (например, `decision` / `micro.decision`) в `@itphx/synth-shared/config`
([AD-023](./ad-023-configuration.md)): выбор режима **локальный инференс vs Workers AI**, адрес/провайдер,
модель (`clef` / `clef-flash`), таймауты, пороги. Приоритет — CLI > `SYNTH_*` env > config.yaml > defaults.

### 4. Встраивание в `engine/router/micro/`

Decision-модель оформляется как ещё одна реализация интерфейса `MicroModel` (`models/`) — наравне с
`rules-model`, `embedding-model`, `micro-llm-model`. Каскад AD-035 расширяется:

```
rules → embedding → Clef-Flash → [Clef] → LLM fallback
```

- **Clef-Flash** встаёт на место (или сразу после) этапа `micro_llm` — параллельный скоринг схемы вместо
  генерации + парсинга.
- **Clef** подключается на эскалацию, когда нужна точность или задействована мультимодальность.

### 5. Классификатор «Маршрутизации»

Отдельный decision-вопрос `choice` заменяет/дополняет словарный `content`-классификатор AD-034 для выбора
`coding` / `research` / `chat`. Вероятности дают честный сигнал для стратегии `confidence` и порога эскалации.

## Безопасность и политики

- `state` decision-модели **может содержать пользовательский контент** (сообщения, фрагменты файлов). Для
  managed-инсталляций и чувствительных данных **по умолчанию — локальный инференс**; удалённый (Workers AI)
  — **только по политике**.
- Согласовать с политиками гибрида и защитой от утечек: [AD-073](./ad-073-client-integrity-hybrid.md)
  (enforcement на сервере), [AD-080](./ad-080-managed-hybrid-modes.md) (режимы-полюса),
  [AD-081](./ad-081-hybrid-policy-leak-protection.md) (серверные политики, запрет утечек).
- Не логировать `state` в аудит, если он может содержать секреты; guard/обфускация [AD-036](./ad-036-llm-gateway.md)
  применяются до отправки и в локальном, и в удалённом режиме.
- Decision-слой подчиняется permission-слою и режимам ([AD-029](./ad-029-granular-permissions.md),
  AD-025/AD-028): его включение/поведение — настройка и политика, а не хардкод в тулах.

## Мультимодальность

`images`/`videos` на входе — **задел на будущее**, не первый этап. Возможные применения: классификация
скриншотов, вложений, фрагментов UI (например, «тип вложения», «нужна ли визуальная проверка»). Начать стоит
с текстового `state`; мультимодальность включать отдельным этапом после стабилизации базового слоя.

## Метрики

Расширить `DebugCollector` в духе существующих `micro.*`:

- `decision.calls` / `decision.handled` / `decision.fallback` — сколько решений обработано decision-слоем;
- `decision.latency_by_model` — латентность по `clef` / `clef-flash` / `jev`;
- `decision.calibration` — сопоставление заявленной вероятности и фактической корректности (мониторинг порогов);
- разрез по локальный/remote, чтобы видеть долю трафика, уходящего в Workers AI.

## Этапы реализации

1. **Адаптер + конфиг + провайдеры.** `DecisionProvider`, секция конфига в `shared`, режим локальный/remote,
   подключение через `GatewayProvider`.
2. **Clef-Flash в micro за флагом.** Новый `MicroModel` для задач `classify` / `enum_decision`, включается
   отдельным флагом; сравнение качества/латентности с текущим `micro_llm` (без снятия старого пути).
3. **Clef на эскалацию.** Подключение точной модели на `UNSURE`/сложные решения и на мультимодальные запросы.
4. **Decision-классификатор маршрутизации.** Замена/дополнение словарного `content`-классификатора AD-034.
5. **UI-настройки и метрики.** Панель настроек (по [AD-072](./ad-072-settings-ui-kit.md)), метрики в статистике.
6. **Документация.** Обновить `docs/ROUTING.md` — **позже, при реализации** (сейчас не трогать).

## Риски и открытые вопросы

- **Локальный инференс требует кастомного рантайма:** веса рассчитаны на `joint_schema_model.py` (joint schema
  head), стандартный `transformers`-инференс «из коробки» не подходит; доступны community-кванты (GGUF/MLX/FP8/NVFP4),
  но их пригодность для типизированного скоринга нужно проверить.
- **Нужен SystemOne-API-совместимый локальный сервер** — уточнить, каким рантаймом он поднимается и насколько
  полно воспроизводит семантику API Clef.
- **Трафик в Cloudflare (remote)** при managed/чувствительных данных — политики локально/remote (см. выше).
- **Калибровка вероятностей и порогов** — заявленные вероятности требуют проверки; порог `OK`/`UNSURE` (сейчас
  фиксированный, AD-035) может потребовать настройки.
- **Не путать с chat-LLM:** decision-модель не умеет генерировать и рассуждать; её нельзя ставить туда, где
  нужен свободный ответ.
- **Устаревание/доступность моделей:** Clef/Clef-Flash — новые (2026-10-01), API и хостинг могут меняться;
  Jev остаётся альтернативой/фоллбеком.
- **Официальные бенчмарки — заявленные Cloudflare;** переносить цифры в решения без собственной проверки нельзя.

## Связи

- [AD-034](./ad-034-model-routing.md) «Routing между моделями» — decision-классификатор для стратегии `content`.
- [AD-035](./ad-035-micro-model-first.md) «Micro-model first» — место decision-моделей в каскаде (замена/усиление `micro_llm`).
- [AD-036](./ad-036-llm-gateway.md) «LLM Gateway» — единственный путь вызова (guard/обфускация/rate limit/аудит).
- [AD-023](./ad-023-configuration.md) «Конфигурация» — секция decision-моделей и приоритеты.
- [AD-029](./ad-029-granular-permissions.md) «Гранулярные permissions» — decision-слой подчиняется permission/политикам.
- [AD-070](./ad-070-system-prompt-composer.md) «SystemPromptComposer» — статистика/прозрачность вызовов (если уместно).
- [AD-073](./ad-073-client-integrity-hybrid.md), [AD-080](./ad-080-managed-hybrid-modes.md),
  [AD-081](./ad-081-hybrid-policy-leak-protection.md) — целостность/режимы/политики гибрида и защита от утечек.
- [AD-072](./ad-072-settings-ui-kit.md) — UI-настройки decision-слоя.
- [docs/ROUTING.md](../ROUTING.md) — пользовательские слои «Быстрые ответы» и «Маршрутизация» (обновить при реализации).
- [packages/core/AGENTS.md](../../packages/core/AGENTS.md) — код микро-слоя (`engine/router/micro/`).
