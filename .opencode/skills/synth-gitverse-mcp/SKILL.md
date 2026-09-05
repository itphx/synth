---
name: synth-gitverse-mcp
description: GitVerse MCP: подключение к opencode, токен, инструменты. Используй при настройке MCP GitVerse или работе через него.
---

# GitVerse MCP

## Подключение к opencode

Конфигурация в `~/.config/opencode/opencode.jsonc`:

```jsonc
"mcp": {
  "gitverse": {
    "type": "remote",
    "url": "https://mcp.gitverse.ru",
    "headers": {
      "Authorization": "Bearer <токен>"
    },
    "oauth": false,
    "enabled": true
  }
}
```

**Важно:** `"oauth": false` обязательно для GitVerse MCP (не поддерживает OAuth flow). Изменения в `opencode.jsonc` требуют перезапуска opencode.

## Токен

Получить: `https://gitverse.ru/settings/tokens`
Права: для read-only достаточно «Чтение», для записи — «Запись».

## Доступные инструменты (37 шт.)

Группы: репозитории, файлы, коммиты, релизы, PR, CI/CD, пользователи, команды, звёзды.
Подробнее: `https://gitverse.ru/docs/ai/mcp/gitverse-mcp-tools`
