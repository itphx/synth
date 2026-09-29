# Быстрый старт

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
docker pull gitverse.ru/itphx/synth
docker run -p 4300:4300 -e SYNTH_API_KEY=my-secret-key gitverse.ru/itphx/synth
```

Либо docker-compose из корня репозитория (`docker-compose.yml`):

```bash
git clone <repo-url> synth && cd synth
echo "SYNTH_API_KEY=my-secret-key" > .env
docker compose up -d
```

### Способ 3: из исходников

```bash
git clone <repo-url> synth && cd synth
pnpm install
pnpm build

# Запуск через тонкую CLI-обёртку (UI резолвится из @itphx/synth-ui автоматически)
node packages/synth/dist/cli.js serve --api-key my-secret-key
```

## 2. Настройка провайдера (минимум)

Минимальная настройка — добавить провайдера через CLI. Провайдеры хранятся как JSON-файлы в `{dataDir}/providers/`.

```bash
# Ollama (локальные модели)
synth config provider add \
  --name ollama --type ollama \
  --url http://localhost:11434/v1 \
  --model qwen3:14b
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
export SYNTH_PROVIDER_OLLAMA_URL=http://localhost:11434/v1
export SYNTH_PROVIDER_OLLAMA_MODEL=qwen3:14b
export SYNTH_PROVIDER_OLLAMA_TYPE=ollama
```

Подробнее — [LLM-провайдеры](LLM_PROVIDERS.md).

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
synth chat "привет" --provider ollama --model qwen3:14b

# Интерактивный режим
synth chat --provider ollama --model qwen3:14b

# Просто synth — сразу в интерактивный чат
synth
```

## Аутентификация

Запросы к API (кроме `GET /health`) аутентифицированы. Роли: `ADMIN`, `USER`, `LEAD`, `AUDITOR`.

| Режим | Где | Механизм |
|-------|-----|----------|
| API Key | backend (`SYNTH_API_KEY`) | Один ключ → роль ADMIN |
| API Key | core standalone (`synth serve`, `--api-key`/`SYNTH_API_KEY`; иначе авто-ключ `{dataDir}/secrets/api-key`) | Один ключ → роль USER |
| Debug | backend (`SYNTH_AUTH_DEBUG=true`) | Тестовые пользователи (admin-key-123, user-key-456, lead-key-789, auditor-key-012) |
| OIDC | backend (Keycloak) | JWT + cookie `user_session` |

## Дальнейшие шаги

- [Конфигурация](CONFIGURATION.md) — переменные окружения и `config.yaml`
- [Маршрутизация](ROUTING.md) — быстрые ответы и выбор модели
- [Разработка](DEVELOPMENT.md) — сборка и запуск из исходников
- [Архитектура](ARCHITECTURE.md) — компоненты и сценарии развёртывания
- [Диагностика](TROUBLESHOOTING.md) — известные проблемы
