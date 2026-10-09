# AD-042: Гибридный режим — локальный core + централизованный сервер

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md

**Решение:** локальный `synth serve` становится **агрегатором двух миров**: локального (свой `dataDir`, локальные проекты/сессии, локальные файлы) и удалённого (backend в K3s). Удалённые сессии исполняются **сервером** (Модель A): локальный core для них — тонкий клиент, проксирующий API и события. **Все LLM-запросы централизованы** на сервере — включая локальные сессии, которые ходят за LLM через серверный **LLM Proxy**. Точка входа — только локальный UI. Аутентификация и единая личность (вход в UI по логину/паролю, дискавери IdP, старт без device flow) — см. **AD-043**; device flow сохранён для CLI `synth connect`/автоматизации.

**Контекст:** у продукта есть два сценария — облачный (backend+UI в K3s, движок in-process, центральные ключи/аудит) и локальный (standalone core, свои провайдеры и файлы). Гибрид нужен разработчику, который хочет работать на своей машине (локальные проекты, прямой доступ к ФС, VPN-ресурсы), но при этом видеть корпоративные проекты/сессии и пользоваться централизованными LLM (ключи и аудит — только на сервере). Backend уже умеет исполнять сессии целиком, поэтому удалённые сессии проще исполнять там, а не дублировать оркестратор локально.

**Ключевые решения (утверждены 2026-08-31):**

| № | Вопрос | Решение |
|---|--------|---------|
| 1 | Исполнение удалённых сессий | **Модель A**: сервер; локальный core — клиент-агрегатор (прокси API + события) |
| 2 | LLM для локальных сессий | **LLM Proxy** на backend; локальные провайдеры в гибриде **запрещены** (`remote.llm: server`) |
| 3 | Аутентификация | Вход в UI: **ROPC по логину/паролю**, дискавери IdP `GET /auth/oidc-meta` (public-клиент `synth-cli`); CLI `synth connect` — device flow. Credentials — `~/.config/synth/credentials.json` (0600). См. **AD-043** |
| 4 | Идентификация сущностей | namespace `remote:<id>`, поле `origin: local \| remote` (исключает коллизии UUID) |
| 5 | События | **RemoteEventBridge**: SSE сервера → локальный EventBus → UI |
| 6 | Перенос между мирами | `synth project publish` / `fork`: проект + сессии (с историей) + файлы, **прямая синхронизация** (не git) |
| 7 | Точка входа | Только локальный UI (localhost) |
| 8 | Offline | Сервер недоступен → удалённые сущности неактивны (502 `OFFLINE`), локальные работают, UI-баннер |

**Архитектура (Модель A):**

```
Машина пользователя                                Сервер (K3s)
synth serve --connect https://synth.k3s.itphx.loc
  ┌────────────────────────────┐   HTTPS        ┌───────────────────────────────┐
  │ Browser → localhost UI     │                │ synth-backend (:5000)          │
  │  └─ @itphx/synth-ui (SPA)  │                │  ├─ OIDC (Keycloak) / device   │
  │       │ WS/SSE             │                │  ├─ RBAC                        │
  │  synth-core (serve :4300)  │  ───────────►  │  ├─ ChatOrchestrator (движок)   │
  │  ├─ локальный мир          │  /api/v2/*     │  │   └─ удалённые сессии        │
  │  │   ├─ sessions/projects  │  (remote)      │  ├─ LLM Proxy /api/v2/llm      │
  │  │   ├─ локальные файлы    │                │  │   └─ Gateway (AD-036)       │
  │  │   └─ локальные провайдеры                 │  ├─ центральные провайдеры      │
  │  │      (в гибриде ЗАПРЕЩЕНЫ)                │  │   (ключи на сервере)        │
  │  ├─ RemoteBackendClient    │  ◄───────────  │  ├─ события /api/v2/events     │
  │  │   └─ /api/v2/* + SSE    │   SSE          │  └─ сессии/проекты/файлы (PVC)  │
  │  ├─ RemoteEventBridge      │                │                                   │
  │  └─ RemoteProvider          │                │                                   │
  │     (synth-remote → /api/v2/llm)            └───────────────────────────────┘
  └────────────────────────────┘
```

**Ключевые механизмы:**

- **Агрегация и маршрутизация.** Core-API объединяет локальные и удалённые проекты/сессии: удалённые получают `origin: 'remote'` и id `remote:<uuid>` (переписываются вложенные ссылки: `project_id`, `parent_id`, `references[].session_id`). Запросы к `remote:<id>` проксируются на backend (sessions/projects/messages/fs/queue/prompt). `POST /sessions/:id/prompt` для удалённой сессии возвращает upstream SSE-стрим как есть.
- **Централизация LLM.** Backend отдаёт OpenAI-совместимый `POST /api/v2/llm/chat/completions` (stream/non-stream) с применением Gateway AD-036 (обфускация, аудит, rate limit, tool-calling). В core регистрируется `RemoteProvider` (тип `remote`) — локальный движок использует сервер как источник LLM; при `remote.llm: server` локальные провайдеры скрыты/запрещены (policy в `providerLoader`), модели сервера сливаются в models-роут.
- **События.** `RemoteEventBridge` подписывается на SSE `/api/v2/events` сервера, переписывает sessionId в `remote:<id>` и публикует в локальный EventBus; локальные SSE/WS-эндпоинты в гибриде используют `subscribeAll`. SSE-адаптер сервера сбрасывает заголовки (`res.flushHeaders()`), иначе стрим «пустого» начала не доходит до клиента.
- **Перенос.** `synth project publish` (локальный → сервер) и `fork` (сервер → локально): переносится проект (включая `plan`), сессии (через backend `GET /sessions/:id/export` + `POST /sessions/import`; `parentId`/`references` переписываются по mapping при топологической сортировке), файлы — прямой синхронизацией (обход каталога, `fsWrite`/`fsUpload`/`fsDownload`; исключаются `node_modules`, `.git`, `.synth`, скрытые). Инстанс-локальные секреты (API-ключи привязок событий — [AD-089](./ad-089-external-events-automation.md)/[AD-052](./ad-052-public-api-platform.md), [AD-081](./ad-081-hybrid-policy-leak-protection.md)) **не переносятся** — создаются заново на целевом инстансе.
- **WS.** `send_message` для `remote:<id>` маршрутизируется на backend (`promptSession`), события возвращаются через мост.
- **Offline-деградация.** Списки при недоступности сервера возвращают локальный мир (warn); явные remote-операции — 502 `OFFLINE`/401; `getToken` при ошибке refresh возвращает null (без падения потока); в UI — баннер «Сервер недоступен», remote-действия блокируются, remote-сущности приглушены.

**Статус/диагностика:** `GET /api/v2/hybrid/status` → `{ enabled, connected, backendUrl, user, serverConfigured, serverLoginAvailable }` (без auth); UI опрашивает ~30 с с кешем 5 с.

**Конфигурация (`remote` в config.yaml или CLI-флаги):**

```yaml
remote:
  enabled: false
  backendUrl: "https://synth.k3s.itphx.loc"   # можно не задавать — адрес вводится в UI
  auth:
    type: device            # device | api_key; вход в UI — ROPC (см. AD-043)
    apiKey: ""
    issuer: "https://keycloak.itphx.loc/realms/synth"   # fallback дискавери
    clientId: "synth-cli"                                # public-клиент CLI/device flow
  llm: "server"             # server (централизация) | local
  worlds: { local: true, remote: true }
  credentialsPath: ""       # пусто → ~/.config/synth/credentials.json
  timeoutMs: 15000
```

CLI: `synth serve --connect <url> [--oidc-issuer ...] [--oidc-client-id ...] [--token ...]`, `synth connect`, `synth disconnect`, `synth project publish <id> [--no-files] [--no-sessions]`, `synth project fork <id> [--local-name ...] [--no-files] [--no-sessions]`.

**Реализация (файлы):**

- `packages/shared/src/config/types.ts` — `remoteConfigSchema`.
- `packages/core/src/remote/` — `client.ts` (RemoteBackendClient), `device-flow.ts`, `credentials.ts`, `session.ts` (RemoteSession + `getToken` с авто-refresh), `aggregate.ts` (origin/remote-ref/`remoteErrorToHttp`), `event-bridge.ts`, `transfer.ts` (publish/fork), `types.ts`.
- `packages/core/src/providers/remote.ts` — `RemoteProvider` (тип `remote`), реестр токенов.
- `packages/core/src/server/routes/hybrid.ts` — `/api/v2/hybrid/status`; маршруты sessions/projects/messages/fs/queue — remote-ветки.
- `packages/backend/src/routes/llm.ts` — LLM Proxy; `sessions.ts` — export/import; `projects.ts` — `plan`.
- UI: `OriginBadge`, `HybridStatusIndicator`, `HybridOfflineBanner`, `hybridStore`, селектор «где создать».
- CLI: `packages/core/src/main.ts`, `packages/synth/src/cli.ts`.

**Расширяет:** AD-022 (третий сценарий развёртывания: локальный core как агрегатор + сервер), AD-024 (транспорт: RemoteEventBridge как мост событий), AD-036 (Gateway применяется и к LLM-Proxy). Аутентификация/единая личность/дискавери IdP — **AD-043**. Детальные требования и статус — в `docs/HYBRID.md`.

---
