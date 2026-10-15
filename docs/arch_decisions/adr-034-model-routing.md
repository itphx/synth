# ADR-034: Routing между моделями

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md

**Решение:** Router-слой между синтом и LLM — три стратегии: content-based, escalation by confidence, cost-aware.

**Контекст:** разные модели имеют разную специализацию и стоимость. Небольшие fine-tuned локальные модели работают быстро и лучше разбираются в конкретной области, облачные большие модели сильнее в логике и рассуждениях, большие локальные модели — баланс между скоростью и стоимостью. Выбор правильной модели на этапе запроса даёт выигрыш в качестве без удорожания. Мультимодальные модели - стоимость больше, но распознавание картинок нужно не в каждом запросе.

**Три стратегии роутинга:**

| Стратегия | Суть | Когда срабатывает |
|---|---|---|
| **Content** | Тип запроса → выбор модели | Кодинг → DeepSeek, сленг → Qwen, исследование → Gemma |
| **Confidence** | Quality check → FAIL → эскалация | Неуверенный или невалидный ответ Qwen → DeepSeek |
| **Cost** | Простые запросы → дешёвая, сложные → дорогая | < 10 слов → Qwen, > 50 слов → DeepSeek/MiniMax |

**Архитектура Router:**

```
Request
  │
  ▼
┌──────────────────────────────────────────────┐
│  Router                                        │
│  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Content      │  │  Provider Pool          │ │
│  │  Classifier   │──│  ├─ Qwen3-4B (local)   │ │
│  └──────┬───────┘  │  ├─ DeepSeek (API)      │ │
│         │           │  ├─ Gemma 12B (Ollama)  │ │
│         ▼           │  └─ MiniMax M3 (API)    │ │
│  ┌──────────────┐  └────────────────────────┘ │
│  │  Selector    │                              │
│  └──────┬───────┘                              │
│         ▼                                      │
│  ┌──────────────┐                              │
│  │  Executor    │── in/out logging + metrics   │
│  └──────┬───────┘                              │
│         ▼                                      │
│  ┌──────────────┐                              │
│  │  Quality     │── if FAIL → Selector → retry │
│  │  Check       │     (confidence escalation)  │
│  └──────────────┘                              │
└──────────────────────────────────────────────┘
  │
  ▼
Response + routing_metadata
```

**Конфигурация (synth.yaml):**

```yaml
router:
  strategy: content  # default: content-based

  # Content-based routing
  content:
    coding:
      provider: deepseek
      model: deepseek-v4-flash
      max_tokens: 4096
    slang_translate:
      provider: openai
      model: qwen3-4b-v2
      base_url: http://localhost:11434/v1
    research:
      provider: openai
      model: gemma-4-12b-it
      base_url: http://localhost:11434/v1

  # Escalation (confidence-based)
  escalation:
    enabled: true
    max_retries: 1
    on_failure: deepseek  # fallback provider
    checks:
      - constraint    # сленг/не сленг
      - min_length: 5 # слишком короткий ответ

  # Cost-aware routing
  cost:
    cheap_providers: [qwen, gemma_12b]
    expensive_providers: [deepseek, minimax]
    max_cheap_cost: 0.01  # $ за запрос
```

**Quality Check (набросок):**

```typescript
interface QualityResult {
  constraint: { pass: boolean; detail: string }
  minLength: { pass: boolean }
  overall: 'PASS' | 'UNSURE' | 'FAIL'
}

async function qualityCheck(
  answer: string,
  direction: 'to_slang' | 'to_lit',
  rules: QualityRule[]
): Promise<QualityResult> {
  // constraint: проверка наличия/отсутствия сленга
  // min_length: ответ не пустой
  // custom_rules: из конфига
}
```

**Порядок реализации:**
1. Router interface + Provider Pool (подключение к разным API)
2. Content classifier — простая классификация по ключевым словам (на первых порах)
3. Quality check — 3 возможных типа проверки:
  - Self-check  — модель оценивает свой ответ
  - Redundancy  — 3 прогона, Jaccard similarity
  - Constraint  — алгоритмическая проверка вывода - длина, наличие / остутствие слов или конструкций
4. Confidence escalation — при FAIL → повтор на другой модели
5. Cost strategy — трекинг токенов и стоимости
6. CLI: `synth router test "запрос"` — показать какая модель выбрана и почему
