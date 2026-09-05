---
name: synth-hybrid
description: Гибридный режим Synth: локальный core + централизованный сервер, включение, CLI-команды, поведение, ключевые файлы. Используй при работе с гибридным режимом.
---

# Гибридный режим

Гибридный режим — локальный core подключается к корпоративному серверу (`synth serve --connect <url>`): в одном локальном UI объединяются локальные и удалённые (backend) проекты/сессии, а LLM-запросы централизованы на сервере (ключи, модели и аудит — только на нём). Реализовано в ветке `feat/hybrid-mode`; детальные требования, архитектура и статус — в [docs/HYBRID.md](docs/HYBRID.md).

## Включение

Секция `remote` в config.yaml:

```yaml
remote:
  enabled: true
  backendUrl: "https://synth.k3s.itphx.loc"
  auth:
    type: device                  # device | api_key
    issuer: "https://keycloak.itphx.loc/realms/synth"
    clientId: "synth"
  llm: "server"                   # server | local; server — централизация LLM
```

Или CLI-флагами без правки конфига:

```bash
synth serve --connect https://synth.k3s.itphx.loc \
  --oidc-issuer https://keycloak.itphx.loc/realms/synth \
  --oidc-client-id synth
```

## Команды CLI

| Команда | Назначение |
|---|---|
| `synth serve --connect <url>` | Запуск локального core с подключением к серверу (опции `--oidc-issuer`, `--oidc-client-id`, `--token`) |
| `synth connect --backend <url>` | Аутентификация (OIDC device flow / `--token` API-ключ); credentials — в `~/.config/synth/credentials.json` (0600) |
| `synth disconnect --backend <url>` | Удалить сохранённые credentials |
| `synth project publish <id> --remote <url>` | Локальный проект → сервер (проект + сессии + файлы; `--no-files` / `--no-sessions`) |
| `synth project fork <id> --remote <url>` | Удалённый проект → локально (`--local-name`, `--no-files`, `--no-sessions`) |

## Поведение

- **Агрегация миров:** проекты/сессии локального core объединяются с удалёнными (backend); у каждой сущности поле `origin: 'local'|'remote'`, удалённые id — `remote:<uuid>` (исключают коллизии UUID). Запросы маршрутизируются по миру: локальные обрабатывает core, удалённые — проксируются на сервер.
- **Статус:** `GET /api/v2/hybrid/status` → `{ enabled, connected, backendUrl, user }` (без auth; UI опрашивает ~30 с).
- **События:** RemoteEventBridge транслирует SSE сервера в локальный EventBus, события удалённых сессий переписываются в `remote:<id>` и доходят до UI.
- **LLM:** локальные сессии в гибриде ходят за LLM через сервер (`POST /api/v2/llm/chat/completions`, RemoteProvider `synth-remote`); при `remote.llm: server` локальные провайдеры запрещены полностью.
- **Offline-деградация:** сервер недоступен — локальный мир работает, списки деградируют с warn, явные remote-операции возвращают 502 OFFLINE; в UI баннер «Сервер недоступен», remote-сущности приглушены, селектор «где создать» — только «Локально».

## Ключевые файлы

- `packages/core/src/remote/` — клиент, device flow, credentials, агрегация, событийный мост, publish/fork
- `packages/backend/src/routes/llm.ts` — LLM Proxy (`POST /api/v2/llm/chat/completions`)
- `packages/backend/src/routes/sessions.ts` — `GET /sessions/:id/export`, `POST /sessions/import`
- UI: `packages/ui/src/components/layout/HybridStatusIndicator.tsx`, `HybridOfflineBanner.tsx`, бейджи origin, селектор «где создать»
