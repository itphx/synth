---
name: synth-dev
description: Запуск и настройка dev-окружения Synth: dev.sh, порты, data dir, runtime-настройки API. Используй при работе с dev-серверами Synth.
---

# Dev-окружение Synth

## Запуск

Скрипты лежат в `synth/scripts/`. Запуск из `synth/` (`./scripts/dev.sh`) или из корня проекта (`./synth/scripts/dev.sh`):

```bash
./scripts/dev.sh            # backend (:5000) + UI (:5002)
./scripts/dev.sh backend    # только backend
./scripts/dev.sh core       # synth-core standalone (:4300)
./scripts/dev.sh all        # backend + UI + core
```

## Переменные окружения (устанавливает dev.sh)

- `SYNTH_AUTH_DEBUG=true` — debug-режим аутентификации с тестовыми пользователями
- `SYNTH_DATA_DIR=/home/eof/dev/Synth/data` — каталог данных вне репозитория
- `SYNTH_PORT`, `SYNTH_CORE_PORT`, `VITE_PORT` — порты компонентов

## Хранилище данных

Все runtime-данные (сессии, проекты, провайдеры, модели) — в `$SYNTH_DATA_DIR`.

Провайдеры: JSON-файлы в `$SYNTH_DATA_DIR/providers/`. Модели: файлы в `$SYNTH_DATA_DIR/models/`.

Основные провайдеры для разработки:

| Имя | Тип | Назначение |
|-----|-----|------------|
| `itphx` | openai | Рабочий провайдер (ai.itphx.ru), модель `local.qwen3:14b` |
| `ollama` | ollama | Локальный Ollama (owu.itphx.loc:11434) |

Для добавления нового провайдера достаточно создать JSON-файл в `providers/`, для модели — в `models/`.

## Порты

| Сервис | Порт | Env var |
|--------|------|---------|
| synth-backend | 5000 | `SYNTH_PORT` |
| synth-ui | 5002 | `VITE_PORT` |
| synth-core | 4300 | `SYNTH_CORE_PORT` |
| opencode (движок) | 4100 | — |
| cline (движок) | 4200 | — |

## Runtime-настройки (API)

| Метод/путь | Назначение |
|---|---|
| `PATCH /api/v2/sessions/:id` `{ mode }` | Переключение режима сессии: `plan` / `act` / `yolo` |
| `GET/PUT /api/v2/settings/workspace` | Рабочий каталог по умолчанию (runtime override, хранится в `settings.json`) |
| `GET/PUT /api/v2/settings/mcp` | Доступность MCP-инструментов по режимам (plan/act) |
| `POST /api/v2/mcp/probe` | Проверка MCP-сервера без регистрации инструментов |

## Логи

Логи: `tmp/backend.log`, `tmp/ui.log`, `tmp/core.log`. Каталог `tmp/` не коммитится.
