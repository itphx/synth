# ADR-035: Micro-model first — дешёвый слой перед LLM

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md

**Решение:** двухуровневый каскад: **микро-модель** (правила / embedding / словарь) обрабатывает запрос первой и зовёт LLM только при неуверенности. LLM — не дефолт, а fallback.

**Контекст:** большинство запросов к LLM на самом деле простые и структурируемые (классификация, интент, извлечение полей, enum-решения). Гонять их через большую модель — тратить токены и время. Двухуровневый каскад отсекает 60-80% трафика до LLM.

**Архитектура:**

```
Запрос
  │
  ▼
┌──────────────────────────────────┐
│  Уровень 1: MICRO-MODEL           │
│  (правила / словарь / embeddings) │
│  → структурированный результат    │
│  → enum / label / score           │
│  → confidence: OK | UNSURE        │
└──────┬───────────────────────────┘
       │
  ┌────┴────┐
  │         │
 OK        UNSURE
  │         │
  │    ┌────▼─────────────────────┐
  │    │  Уровень 2: LLM fallback  │
  │    │  → маршрутизация (ADR-034) │
  │    │  → верификация результата │
  │    └────┬─────────────────────┘
  │         │
  ▼         ▼
 Ответ    Ответ + метка "fallback"
без LLM
```

**Требования к микро-модели:**
- Возвращает **структурированный результат**: `{label: enum, confidence: 0.0-1.0}`
- Возвращает **статус уверенности**: `OK` (порог пройден) или `UNSURE`
- Работает **без вызова LLM** (0 токенов)

**Варианты реализации микро-модели (по возрастанию сложности):**

| Вариант | Скорость | Стоимость | Когда использовать |
|---|---|---|---|
| **Правила + словарь** | мс | 0 | Классификация по ключевым словам, форматные проверки |
| **Embedding-классификатор** (sentence-transformers) | ~50 мс | 0 (локально) | Семантика: интенты, темы, похожесть |
| **Микро-LLM** (1-3B, local) | ~0.5 с | ~0 | Контекстные решения, когда правил мало |

**Логика confidence:**

```
confidence >= 0.8  → OK     → ответ без LLM
confidence < 0.8   → UNSURE → fallback на LLM
формат невалиден    → UNSURE → fallback на LLM
```

Порог конфигурируется per-task.

**Интеграция с ADR-034 (routing):**

```
Запрос
  │
  ├─ ADR-035: Micro-first
  │     ├─ OK → ответ (0 токенов)
  │     └─ UNSURE ↓
  ├─ ADR-034: Routing
  │     └─ content/confidence/cost → выбор провайдера
  └─ LLM ответ
```

**Конфигурация (synth.yaml):**

```yaml
micro_first:
  enabled: true
  tasks:
    classify_intent:
      type: embedding       # rules | embedding | micro_llm
      model: local-embed    # для embedding
      confidence_threshold: 0.8
      labels: [bug, feature, question, spam]
    extract_fields:
      type: rules
      patterns:
        - email
        - phone
        - url
      confidence_threshold: 0.8
```

**Метрики (что логируем):**
- % запросов, обработанных микро-моделью (target: 60-80%)
- % fallback на LLM
- Средняя latency по уровням
- Стоимость токенов сэкономленная

**Реализация (2026-08-03):**

Код: `packages/core/src/engine/router/micro/`

```
micro/
├── index.ts              # MicroPipeline — каскад rules→embedding→micro_llm
├── types.ts              # MicroInput, MicroResult, PipelineResult
├── task-classifier.ts    # Классификация: small_talk | classify | enum_decision | llm_task
├── models/
│   ├── base.ts           # Интерфейс MicroModel
│   ├── rules-model.ts    # Правила + словарь (DictionaryStore), 0 токенов
│   ├── embedding-model.ts # Lazy import @huggingface/transformers
│   └── micro-llm-model.ts # Локальная LLM через ProviderPool
└── tasks/
    ├── small-talk.ts     # Приветствия / прощания / благодарности → готовый ответ
    ├── classify-intent.ts # Вопрос / команда / ревью / объяснение → label + confidence
    └── enum-decision.ts  # Да / нет / режим → enum + score
```

**Включение:** `session.microFirst: true` (в Settings сессии или config.yaml). По умолчанию `false` — обратная совместимость.

**Каскад:** rules (0 токенов, ~1 мс) → embedding (~50 мс, ленивый импорт) → micro_llm (~0.5 с, локальная) → LLM fallback через ADR-034.

**Метрики:** в DebugCollector (`micro.handled`, `micro.fallback`, `micro.latency_by_model`).

**Бенчмарк:** `npx tsx scripts/micro-benchmark.mjs` — 25 запросов, таблица результатов + сводка.

**Что не делаем в демо:**
- Обучение кастомных микро-моделей (берём готовые embeddings)
- Динамический подбор порога (фиксированный per-task: 0.8)
