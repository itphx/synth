# LLM-провайдеры

Synth поддерживает провайдеров трёх типов: `openai`, `anthropic`, `ollama` (проверяется в `synth config provider add --type`).

## Провайдеры для разработки

| Имя | Тип | Назначение |
|-----|-----|------------|
| `itphx` | openai | Рабочий провайдер (ai.itphx.ru), модель `local.qwen3:14b` |
| `ollama` | ollama | Локальный Ollama (owu.itphx.loc:11434) |

## Настройка через переменные окружения

Все переменные провайдеров имеют префикс `SYNTH_PROVIDER_<NAME>_`:

### Ollama (локально, бесплатно)

```bash
export SYNTH_PROVIDER_OLLAMA_URL=http://localhost:11434/v1
export SYNTH_PROVIDER_OLLAMA_MODEL=qwen3:14b
export SYNTH_PROVIDER_OLLAMA_TYPE=ollama
export SYNTH_PROVIDER_OLLAMA_API_KEY=""
```

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

## Настройка через CLI

Провайдеры хранятся как JSON-файлы в `{dataDir}/providers/`. Команды — через публичную CLI-обёртку `synth`:

```bash
# Добавить провайдера
synth config provider add \
  --name ollama --type ollama \
  --url http://localhost:11434/v1 \
  --model qwen3:14b

# Список провайдеров
synth config provider list

# Удалить провайдера
synth config provider delete ollama
```

Обязательные флаги: `--name`, `--type` (openai | anthropic | ollama). Опциональные: `--url`, `--model`, `--api-key`, `--data-dir`.

## Через веб-интерфейс

Провайдерами и моделями также можно управлять через UI, раздел **«Провайдеры»**.

## Модели для локального запуска (Ollama)

Примеры моделей, которые используются в Synth локально (актуальный набор в `{dataDir}/models/ollama/`):

| Модель | Команда для установки |
|--------|-----------------------|
| Qwen3 14B | `ollama pull qwen3:14b` |
| Qwen3.5 9B | `ollama pull qwen3.5:9b` |
| DeepSeek Coder V2 16B | `ollama pull deepseek-coder-v2:16b` |
| DeepSeek R1 14B | `ollama pull deepseek-r1:14b` |
| Gemma 4 12B | `ollama pull gemma4:12b` |
| Qwen2.5 Coder 1.5B | `ollama pull qwen2.5-coder:1.5b` |
| Nomic Embed Text | `ollama pull nomic-embed-text:latest` |

Для эмбеддинг-классификации (микро-слой, AD-035) используется `local.nomic-embed-text:latest` (см. [Маршрутизация](ROUTING.md)).
