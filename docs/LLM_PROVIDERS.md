# LLM-провайдеры

Synth поддерживает провайдеров трёх типов: `openai`, `anthropic`, `ollama`.

## Настройка через переменные окружения

Все переменные провайдеров имеют префикс `SYNTH_PROVIDER_<NAME>_`:

### Ollama (локально, бесплатно)

```bash
export SYNTH_PROVIDER_OLLAMA_URL=http://localhost:11434/v1
export SYNTH_PROVIDER_OLLAMA_MODEL=qwen3.5
export SYNTH_PROVIDER_OLLAMA_TYPE=ollama
export SYNTH_PROVIDER_OLLAMA_API_KEY=""
```

### Любой OpenAI-совместимый API (LM-Studio, vLLM, Together, Groq, …)

```bash
export SYNTH_PROVIDER_OPENAI_URL=https://api.openai.com/v1
export SYNTH_PROVIDER_OPENAI_API_KEY=sk-xxx
export SYNTH_PROVIDER_OPENAI_MODEL=deepseek-coder-v2
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

```bash
# Добавить провайдера
node packages/core/dist/main.js config provider add \
  --name ollama --type ollama \
  --url http://localhost:11434/v1 \
  --model qwen3.5

# Список провайдеров
node packages/core/dist/main.js config provider list

# Удалить провайдера
node packages/core/dist/main.js config provider delete ollama
```

## Через веб-интерфейс

Провайдерами и моделями также можно управлять через UI, раздел **«Провайдеры»**.

## Модели для локального запуска (Ollama)

| Модель | Команда для установки |
|--------|-----------------------|
| Qwen 3.5 | `ollama pull qwen3.5` |
| Gemma 4 | `ollama pull gemma4` |
| DeepSeek Coder V2 | `ollama pull deepseek-coder-v2` |
| Llama 4 | `ollama pull llama4` |
