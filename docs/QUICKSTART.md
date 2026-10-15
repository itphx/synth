# Быстрый старт

> 🌐 [English](./en/QUICKSTART.md) · **Русский**

> [!NOTE]
> Актуальная пользовательская версия этого документа — в портале документации:
> https://docs.synth.itphx.ru/getting-started/quickstart/.

Короткая инструкция для конечного пользователя: установка, настройка провайдера и первый запуск Synth.

## Требования

- **Node.js** >= 22
- **pnpm** >= 11 (для установки из исходников)
- **Ollama** — только если используете локальные модели (или любой OpenAI/Anthropic-совместимый API)

## 1. Установка

### Способ 1: npm (глобальная установка)

```bash
npm i -g @itphx/synth
```

### Способ 2: Docker

```bash
docker pull gitverse.ru/itphx/synth:<version>
docker run -p 4300:4300 -e SYNTH_API_KEY=my-secret-key gitverse.ru/itphx/synth:<version>
```

Указывайте версию: тег `latest` не публикуется (образы в реестре только версионные).

Либо docker-compose из корня репозитория (`docker-compose.yml`):

```bash
git clone https://gitverse.ru/itphx/synth synth && cd synth
echo "SYNTH_API_KEY=my-secret-key" > .env
docker compose up -d
```

### Способ 3: из исходников

```bash
git clone https://gitverse.ru/itphx/synth synth && cd synth
pnpm install
pnpm build

# Запуск через тонкую CLI-обёртку (UI резолвится из @itphx/synth-ui автоматически)
node packages/synth/dist/cli.js serve --api-key my-secret-key
```

## 2. Настройка провайдера (минимум)

Минимальная настройка — добавить провайдера через CLI. Провайдеры хранятся как JSON-файлы в `{dataDir}/providers/`.

```bash
# Ollama (локальные модели); рекомендуемая модель — qwen3.8:27b
# ollama pull qwen3.8:27b
# URL без /v1: type: ollama ходит на нативный /api/chat
# (так работают num_ctx, think и инструменты).
synth config provider add \
  --name ollama --type ollama \
  --url http://localhost:11434 \
  --model qwen3.8:27b
```

```bash
# Любой OpenAI-совместимый API
synth config provider add \
  --name my-openai --type openai \
  --url https://api.openai.com/v1 \
  --model gpt-4o \
  --api-key sk-xxx
```

Обязательные флаги: `--name`, `--type` (`openai`, `anthropic`, `ollama`). Список: `synth config provider list`, удаление: `synth config provider delete <name>`.

Альтернатива — переменные окружения (`SYNTH_PROVIDER_<NAME>_*`):

```bash
export SYNTH_PROVIDER_OLLAMA_URL=http://localhost:11434
export SYNTH_PROVIDER_OLLAMA_MODEL=qwen3.8:27b
export SYNTH_PROVIDER_OLLAMA_TYPE=ollama
```

Подробнее — [LLM-провайдеры](LLM_PROVIDERS.md).

### Контекстное окно и `num_ctx`

`qwen3.8:27b` поддерживает окно **~100k–256k токенов**, но Ollama по умолчанию
поднимает его небольшим. `num_ctx` **задаётся через Synth** (`ProviderConfig.numCtx`)
и **передаётся** в теле запроса: провайдер `type: ollama` работает через
**нативный** `/api/chat`, поэтому `options.num_ctx` применяется (вместе с `think`
и нативным форматом инструментов). Базовый URL указывайте **без** суффикса `/v1`.

Задать `num_ctx` через Synth (приоритет: явный `numCtx` провайдера >
`contextWindow` модели):

```bash
# 1) CLI — флаг есть только у `config provider add` (подкоманды `edit` нет)
synth config provider add \
  --name ollama --type ollama \
  --url http://localhost:11434 \
  --model qwen3.8:27b \
  --num-ctx 262144

# 2) Переменная окружения (OLLAMA → ollama, `_` в имени → `-`)
export SYNTH_PROVIDER_OLLAMA_NUM_CTX=262144

# 3) API — поле `num_ctx` (он же `numCtx`) в POST/PATCH /api/v2/providers;
#    GET отдаёт значение; null/'' — сброс
```

У существующего провайдера поле правится через `PATCH /api/v2/providers/:name`.

**`type: ollama` работает только нативно.** URL всегда нормализуется к
`/api/chat`: старый базовый URL с суффиксом `/v1` (или `/v1/chat/completions`)
сработает — суффикс снимается, в лог уходит предупреждение. OpenAI-совместимый
путь Ollama нужен отдельным провайдером: `type: openai`/`generic` с URL
`http://localhost:11434/v1` (там `num_ctx` не применяется).

Альтернатива на стороне Ollama — серверный дефолт окна:

```bash
# 1) Основной способ — переменная окружения сервера Ollama (при запуске `ollama serve`)
OLLAMA_CONTEXT_LENGTH=262144 ollama serve

# 2) Либо модель с явным num_ctx (Modelfile)
cat > Modelfile <<'EOF'
FROM qwen3.8:27b
PARAMETER num_ctx 262144
EOF
ollama create qwen3.8-27b-256k -f Modelfile
# затем используйте модель qwen3.8-27b-256k
```

Бюджет контекста самого Synth считается по `contextWindow` модели: он
синхронизируется из Ollama (`/api/tags`) или задаётся вручную у модели; явный
`numCtx` провайдера имеет приоритет над `contextWindow`. Но **фактическое** окно
определяет Ollama.

## 3. Запуск

```bash
synth serve --api-key my-secret-key
```

`--api-key` необязателен: если ключ не задан (`--api-key`/`SYNTH_API_KEY`/`core.apiKey`),
`synth serve` сгенерирует устойчивый локальный ключ, сохранит его в
`{dataDir}/secrets/api-key` и напечатает полностью при старте — введите его в UI.

Сервер слушает `http://127.0.0.1:4300` (host — `--host` или `SYNTH_HOST`, по умолчанию
`127.0.0.1`; порт — `--port` или `SYNTH_CORE_PORT`, по умолчанию `4300`). UI поставляется
вместе с `@itphx/synth-ui` и резолвится автоматически.

Откройте [http://localhost:4300](http://localhost:4300) и введите API-ключ.

## 4. CLI-чат

```bash
# Одноразовый запрос
synth chat "привет" --provider ollama --model qwen3.8:27b

# Интерактивный режим
synth chat --provider ollama --model qwen3.8:27b

# Просто synth — сразу в интерактивный чат
synth
```

## Аутентификация

Запросы к API (кроме `GET /health`) аутентифицированы. Роли: `ADMIN`, `USER`, `LEAD`, `AUDITOR`.

| Режим | Где | Механизм |
|-------|-----|----------|
| API Key | backend (`SYNTH_API_KEY`) | Один ключ → роль ADMIN |
| API Key | core standalone (`synth serve`, `--api-key`/`SYNTH_API_KEY`; иначе авто-ключ `{dataDir}/secrets/api-key`) | Один ключ → роль ADMIN |
| Debug | backend (`SYNTH_AUTH_DEBUG=true`) | Тестовые пользователи (admin-key-123, user-key-456, lead-key-789, auditor-key-012) |
| OIDC | backend (Keycloak) | JWT + cookie `user_session` |

## Дальнейшие шаги

- [Конфигурация](CONFIGURATION.md) — переменные окружения и `config.yaml`
- [Маршрутизация](ROUTING.md) — быстрые ответы и выбор модели
- [Разработка](DEVELOPMENT.md) — сборка и запуск из исходников
- [Архитектура](ARCHITECTURE.md) — компоненты и сценарии развёртывания
- [Диагностика](TROUBLESHOOTING.md) — известные проблемы
