# LLM-провайдеры

> 🌐 [English](./en/LLM_PROVIDERS.md) · **Русский**

Synth поддерживает провайдеров типов `openai`, `anthropic`, `ollama`, `decision` и `systemone` (проверяется в `synth config provider add --type`).

## Провайдеры для разработки

| Имя | Тип | Назначение |
|-----|-----|------------|
| `itphx` | openai | Рабочий провайдер (ai.itphx.ru), модель `local.qwen3.8:27b` |
| `ollama` | ollama | Локальный Ollama (owu.itphx.loc:11434) |

## Настройка через переменные окружения

Все переменные провайдеров имеют префикс `SYNTH_PROVIDER_<NAME>_`:

### Ollama (локально, бесплатно)

```bash
export SYNTH_PROVIDER_OLLAMA_URL=http://localhost:11434
export SYNTH_PROVIDER_OLLAMA_MODEL=qwen3.8:27b
export SYNTH_PROVIDER_OLLAMA_TYPE=ollama
export SYNTH_PROVIDER_OLLAMA_API_KEY=""
```

> **Контекстное окно и `num_ctx`.** У модели окно ~100k–256k токенов, но Ollama
> по умолчанию поднимает его небольшим. `num_ctx` **задаётся через Synth**
> (`ProviderConfig.numCtx`) и **передаётся** в теле запроса: провайдер
> `type: ollama` работает через **нативный** `/api/chat`, поэтому `options.num_ctx`
> применяется — как и `think` и нативный формат инструментов. Базовый URL
> указывайте **без** суффикса `/v1`.
>
> Способы задать (приоритет: явный `numCtx` провайдера → `ModelConfig.contextWindow`
> → справочник):
>
> ```bash
> # 1) CLI — флаг есть только у `config provider add` (подкоманды `edit` нет)
> synth config provider add \
>   --name ollama --type ollama \
>   --url http://localhost:11434 \
>   --model qwen3.8:27b \
>   --num-ctx 262144
>
> # 2) Переменная окружения (имя провайдера в env-форме: OLLAMA → ollama, `_` → `-`)
> export SYNTH_PROVIDER_OLLAMA_NUM_CTX=262144
>
> # 3) API — поле `num_ctx` (он же `numCtx`) в POST/PATCH /api/v2/providers;
> #    GET отдаёт значение; null/'' — сброс
> ```
>
> У существующего провайдера поле правится через `PATCH /api/v2/providers/:name`.
>
> **`type: ollama` работает только нативно.** URL всегда нормализуется к
> `/api/chat`: старый базовый URL с суффиксом `/v1` (или
> `/v1/chat/completions`) сработает — суффикс снимается, в лог уходит
> предупреждение. OpenAI-совместимый путь Ollama нужен отдельным провайдером:
> `type: openai`/`generic` с URL `http://localhost:11434/v1` (там `num_ctx`
> не применяется).
>
> Альтернатива на стороне Ollama — серверный дефолт окна:
> `OLLAMA_CONTEXT_LENGTH=262144 ollama serve` или модель с явным
> `PARAMETER num_ctx 262144` (Modelfile → `ollama create`).
>
> Synth для бюджета контекста использует `contextWindow` модели (синхронизируется
> из Ollama `/api/tags` или задаётся вручную), но фактическое окно определяет Ollama.

### Любой OpenAI-совместимый API (LM-Studio, vLLM, Together, Groq, …)

```bash
export SYNTH_PROVIDER_OPENAI_URL=https://api.openai.com/v1
export SYNTH_PROVIDER_OPENAI_API_KEY=sk-xxx
export SYNTH_PROVIDER_OPENAI_MODEL=gpt-4o
export SYNTH_PROVIDER_OPENAI_TYPE=openai
```

### Anthropic-совместимый API

```bash
export SYNTH_PROVIDER_ANTHROPIC_URL=https://api.anthropic.com/v1
export SYNTH_PROVIDER_ANTHROPIC_API_KEY=sk-ant-xxx
export SYNTH_PROVIDER_ANTHROPIC_MODEL=claude-sonnet-4-20250514
export SYNTH_PROVIDER_ANTHROPIC_TYPE=anthropic
```

### Decision-модели (System One, ADR-084)

Отдельный класс моделей: не чат, а `state` (текст/JSON) + типизированные вопросы →
вероятности за один forward-pass. Протокол задаётся **типом провайдера**:

| Тип | Endpoint | Назначение |
|-----|----------|------------|
| `decision` | `POST {baseUrl}/decisions` | RouterAI и прочие SystemOne-совместимые API (Bearer) |
| `systemone` | `POST {baseUrl}/v1/systemone` | Локальный Ollama (≥0.35.1) |

`baseUrl` — базовый URL сервиса; путь протокола добавляет сам провайдер.

```bash
# RouterAI (remote) — тип decision
export SYNTH_PROVIDER_ROUTERAI_DECISION_TYPE=decision
export SYNTH_PROVIDER_ROUTERAI_DECISION_URL=https://routerai.ru/api/v1
export SYNTH_PROVIDER_ROUTERAI_DECISION_API_KEY=sk-xxx
export SYNTH_PROVIDER_ROUTERAI_DECISION_MODEL=clef-flash

# Ollama (local) — тип systemone
export SYNTH_PROVIDER_OLLAMA_DECISION_TYPE=systemone
export SYNTH_PROVIDER_OLLAMA_DECISION_URL=http://localhost:11434
export SYNTH_PROVIDER_OLLAMA_DECISION_MODEL=clef-flash
```

Слой включается секцией `decision` (`enabled`, `provider`, `model`, `confidenceThreshold`) —
см. [CONFIGURATION.md](CONFIGURATION.md). Любой decision-запрос идёт через
`GatewayProvider` (guard/обфускация/rate limit/аудит), при ошибке или низкой
уверенности — fail-safe откат к текущему поведению.

## Настройка через CLI

Провайдеры хранятся как JSON-файлы в `{dataDir}/providers/`. Команды — через публичную CLI-обёртку `synth`:

```bash
# Добавить провайдера (рекомендуемая локальная модель — qwen3.8:27b).
# URL без /v1: type: ollama ходит на нативный /api/chat.
synth config provider add \
  --name ollama --type ollama \
  --url http://localhost:11434 \
  --model qwen3.8:27b

# Список провайдеров
synth config provider list

# Удалить провайдера
synth config provider delete ollama
```

Обязательные флаги: `--name`, `--type` (openai | anthropic | ollama | decision | systemone). Опциональные: `--url`, `--model`, `--api-key`, `--num-ctx <n>` (размер контекста, `num_ctx` Ollama; целое > 0), `--data-dir`.

## Через веб-интерфейс

Провайдерами и моделями также можно управлять через UI, раздел **«Провайдеры»**.

## Модели для локального запуска (Ollama)

Примеры моделей, которые используются в Synth локально (актуальный набор в `{dataDir}/models/ollama/`):

| Модель | Команда для установки |
|--------|-----------------------|
| Qwen3.8 27B **(рекомендуемая)** | `ollama pull qwen3.8:27b` |
| DeepSeek Coder V2 16B | `ollama pull deepseek-coder-v2:16b` |
| DeepSeek R1 14B | `ollama pull deepseek-r1:14b` |
| Gemma 4 12B | `ollama pull gemma4:12b` |
| Qwen2.5 Coder 1.5B | `ollama pull qwen2.5-coder:1.5b` |
| Nomic Embed Text | `ollama pull nomic-embed-text:latest` |

Для эмбеддинг-классификации (микро-слой, ADR-035) используется `local.nomic-embed-text:latest` (см. [Маршрутизация](ROUTING.md)).
