---
name: synth-api-testing
description: Тестирование Synth через API: базовый URL, аутентификация, тестовые пользователи, curl-примеры. Используй при проверке эндпоинтов.
---

# Тестирование через API

Базовый URL: `http://localhost:5000/api/v2`. Аутентификация:

```bash
AUTH="Authorization: Bearer admin-key-123"
```

## Тестовые пользователи (debug mode, `SYNTH_AUTH_DEBUG=true`)

| Пользователь | Ключ | Роли |
|-------------|------|------|
| admin | admin-key-123 | ADMIN |
| developer | user-key-456 | USER |
| lead | lead-key-789 | LEAD |
| auditor | auditor-key-012 | AUDITOR |

## Аутентификация

Все запросы к API (кроме `GET /health`) аутентифицированы. 401 для неаутентифицированных.

Роли: `ADMIN`, `USER`, `LEAD`, `AUDITOR`. Middleware: `requireAuth`, `requirePermission`.

### Режимы

| Режим | Где | Когда | Механизм |
|-------|-----|-------|----------|
| Debug | backend | `SYNTH_AUTH_DEBUG=true` | Тестовые ключи (admin-key-123, user-key-456, lead-key-789, auditor-key-012) |
| API Key | backend | Продакшен без OIDC | Один `SYNTH_API_KEY` → роль ADMIN |
| OIDC | backend | Продакшен с Keycloak | JWT + cookie `user_session` |
| Local | core | `synth serve --api-key` | Один ключ → роль USER |

Auth middleware — первый в цепочке после CORS/logging.

## Runtime-настройки

| Метод/путь | Назначение |
|---|---|
| `PATCH /api/v2/sessions/:id` `{ mode }` | Переключение режима сессии: `plan` / `act` / `yolo` |
| `GET/PUT /api/v2/settings/workspace` | Рабочий каталог по умолчанию (runtime override, хранится в `settings.json`) |
| `GET/PUT /api/v2/settings/mcp` | Доступность MCP-инструментов по режимам (plan/act) |
| `POST /api/v2/mcp/probe` | Проверка MCP-сервера без регистрации инструментов |

## Важно

- **Не писать в JSON-файлы сессий/провайдеров/моделей вручную** — для создания провайдера/модели использовать API, для сообщений — `POST /sessions/:id/prompt`.
- Для проверки эндпоинтов достаточно curl, сложные bash-скрипты не нужны.
