# Гибридный режим (HYBRID)

> Черновик требований. Ветка: `feat/hybrid-mode`. Дата: 2026-08-31.
> Статус: согласование. Пока НЕ реализовано.

## Цель

Пользователь запускает Synth **локально** (`synth serve`), локальная копия
**подключается к серверу** (backend в K3s на `synth.k3s.itphx.loc`).
В гибридном режиме доступны **и локальные, и удалённые проекты/сессии**.
Все запросы к LLM **централизованы** — проходят через сервер (ключи, модели,
аудит — только на сервере).

## Принятые решения (2026-08-31)

| № | Вопрос | Решение |
|---|--------|---------|
| 1 | Исполнение удалённых сессий | **Модель A**: удалённые сессии исполняются сервером; локальный core — тонкий клиент (проксирует API и события) |
| 2 | LLM для локальных сессий | **LLM Proxy на backend**: локальные сессии в гибриде тоже ходят за LLM через сервер |
| 3 | Аутентификация | **OIDC device flow** (Keycloak) |
| 4 | Видимость миров | Локальный мир **персональный**; предусмотреть операции: **publish** локального проекта → сервер и **fork** удалённого проекта → локально |
| 5 | Точка входа UI | **Только локальный UI** (браузер на localhost, агрегирует оба мира) |

## Архитектура (Модель A)

```
Машина пользователя                            Сервер (K3s)
┌──────────────────────────────┐   HTTPS      ┌────────────────────────────────┐
│  Browser → localhost UI      │              │  synth-backend (:5000)          │
│  └─ @itphx/synth-ui (SPA)    │              │  ├─ OIDC (Keycloak) / device    │
│       │ WS/SSE               │              │  ├─ RBAC (ADMIN/USER/...)        │
│  synth-core (serve :4300)    │  ──────────► │  ├─ ChatOrchestrator (движок)    │
│  ├─ локальный мир            │  /api/v2/*   │  │   └─ удалённые сессии         │
│  │   ├─ sessions/projects    │  (remote     │  ├─ LLM Proxy (/api/v2/llm)     │
│  │   ├─ локальные файлы      │   клиент)    │  │   └─ gateway (AD-036)        │
│  │   └─ локальный ollama?    │              │  ├─ центральные провайдеры       │
│  │                           │  ◄────────── │  │   (ключи на сервере)          │
│  ├─ RemoteBackendClient      │  SSE         │  ├─ события /api/v2/events      │
│  │   └─ /api/v2/* + /ws      │  /ws/events  │  └─ сессии/проекты/файлы (PVC)   │
│  └─ RemoteEventBridge        │              │                                   │
└──────────────────────────────┘              └────────────────────────────────┘
```

Принципы:

- **Локальный core — единая точка входа** для локального UI: агрегирует
  локальный и удалённый миры, маршрутизирует запросы по origin сессии/проекта.
- **Удалённые сессии исполняются сервером**: локальный core для них — тонкий
  клиент (создание/чтение/промпт/события/файлы/гит — через `/api/v2/*` сервера).
- **Локальные сессии исполняются локально**, но их LLM-запросы идут через
  **LLM Proxy** на сервере → централизованный аудит (AD-036) и доступ к
  корпоративным моделям/ключам без их утечки на машину пользователя.
- **Идентификация сущностей**: namespace `local:` / `remote:` (или поле
  `origin`), чтобы исключить коллизии UUID между мирами.

## Ключевые потоки

### 1. Подключение (device flow)

```
synth serve --connect https://synth.k3s.itphx.loc
  → GET /oidc/device (issuer, client_id, verification_uri, user_code)
  → печать ссылки + кода пользователю
  → пользователь подтверждает в браузере (Keycloak)
  → local core опрашивает токен → сохраняет в ~/.config/synth/credentials.json (600)
```

- Credentials: access_token + refresh_token, автообновление.
- Команды: `synth connect`, `synth disconnect`, статус в UI.

### 2. Агрегация миров

- `GET /api/v2/projects` (локальный core) → локальные + удалённые проекты
  (через RemoteBackendClient), с полем `origin: local|remote`.
- `GET /api/v2/sessions` → аналогично. Фильтр `origin`.
- Операции с удалёнными сущностями — проксируются на сервер; мутации требуют
  подтверждения в UI (удаление, переключение проекта).

### 3. Централизация LLM

- Удалённые сессии: LLM вызывает серверный движок (уже так).
- Локальные сессии: `ProviderPool` локального core получает провайдера типа
  `remote`, который направляет запрос в `POST /api/v2/llm` на сервере;
  сервер прогоняет через gateway (AD-036: аудит, обфускация, rate limit) и
  реального провайдера.
- Политика: **в гибриде локальные провайдеры запрещены полностью** — все
  LLM-запросы идут только через сервер (централизованные ключи/модели).

### 4. События

- RemoteEventBridge: локальный EventHub подписывается на SSE `/api/v2/events`
  сервера и транслирует события удалённых сессий в локальный WS/SSE для UI.
- Стриминг ответов удалённых сессий проксируется с сервера.

### 5. Publish (локальный проект → сервер)

```
synth project publish <local-id> --remote
  → создать/обновить проект на сервере
  → (опционально) залить workspace-файлы
  → перенести сессии? (решается отдельно)
```

### 6. Fork (удалённый проект → локально)

```
synth project fork <remote-id> --local
  → склонировать проект с сервера в локальный мир
  → (опционально) склонировать git-репозиторий, скачать workspace
```

## Текущее состояние (что уже есть)

- Backend в K3s = полноценный движок in-process (ChatOrchestrator, сессии,
  проекты, файлы, git, SSE `/api/v2/events`), центральные провайдеры, OIDC+RBAC.
- Backend API v2: sessions, projects, messages, queue, fs, git, providers,
  models, agents, mcp, audit, logs, settings. **Нет exec/shell эндпоинта.**
- Core standalone: полный движок + UI; локальный auth (API key).
- Общие zod-контракты в `@itphx/synth-shared` (core и backend — один контракт).
- UI: TransportClient (WS→SSE фоллбек), GlobalTransportIndicator.

## Объём работ (гэпы → задачи)

### P1 — база гибрида
1. **Конфиг** — секция `remote` в `synthConfigSchema`
   (`packages/shared/src/config/types.ts`):
   `{ enabled, backendUrl, auth: { type: 'device', ... }, llm: 'server'|'local'|'auto', worlds: { local, remote } }`.
2. **CLI** — `synth serve --connect <url>` (+ `synth connect|disconnect`) в
   обёртке `@itphx/synth`; статус подключения.
3. **OIDC device flow** — клиент в core (`remote/device-flow.ts`), хранение
   credentials, refresh токена.
4. **RemoteBackendClient** — HTTP-клиент к `/api/v2/*` сервера
   (`packages/core/src/remote/client.ts`): auth, таймауты, ретраи, ошибки
   «сервер недоступен», общие zod-схемы.
5. **Агрегация** — объединённые списки проектов/сессий с `origin`,
   маршрутизация запросов по миру, namespace коллизий.
6. **UI** — бейджи «локально/удалённо», индикатор подключения,
   подтверждение удалённых мутаций.

### P2 — централизация LLM
7. **LLM Proxy endpoint** на backend (`/api/v2/llm`, OpenAI-совместимый):
   принимает запросы, прогоняет через gateway (AD-036), вызывает провайдера.
8. **Провайдер `remote`** в `ProviderPool`/`ProviderFactory` core — локальный
   движок использует сервер как источник LLM.
9. **Политика провайдеров** в гибриде — запрет всех локальных провайдеров,
   LLM только через сервер.

### P3 — события и сущности
10. **RemoteEventBridge** — SSE сервера → локальный EventHub → UI; прокси
    стриминга ответов.
11. **Publish / Fork** — операции переноса проектов между мирами.
12. **Offline-деградация** — недоступность сервера: удалённые сессии неактивны,
    локальные работают, статус в UI.

### P4 — документация и тесты
13. **Документация** — README, ARCHITECTURE.md, AGENTS.md; возврат SPEC/plan
    в `synth/` с разделом гибрида.
14. **Интеграционные тесты** — локальный core + поднятый backend: удалённая
    сессия, локальная сессия с LLM через сервер, события, offline.

## Статус реализации (2026-08-31)

Ветка `feat/hybrid-mode`. Все части — без коммитов (ожидают решения).

| Часть | Статус | Что сделано |
|---|---|---|
| T1 — конфиг + remote-клиент + device flow | ✅ | `remoteConfigSchema`, `RemoteBackendClient`, `DeviceFlowClient`, credentials store (0600, атомарно) |
| T2 — CLI | ✅ | `synth serve --connect`, `synth connect|disconnect`, `--oidc-issuer/--oidc-client-id/--token`, `RemoteSession.getToken()` (авто-refresh) |
| T3 — агрегация миров | ✅ | `origin` в DTO, `remote:<id>` namespace, merge списков, маршрутизация по миру, форвардинг prompt/fs/messages/queue |
| T4 — UI | ✅ | `OriginBadge`, `HybridStatusIndicator` (polling 30с), подтверждение удалённых мутаций, селектор «где создать», статус-эндпоинт `/api/v2/hybrid/status` |
| T5 — LLM Proxy | ✅ | `POST /api/v2/llm/chat/completions` (OpenAI-совместимый, stream/non-stream), Gateway AD-036, аудит, rate limit |
| T6 — RemoteProvider | ✅ | `RemoteProvider` в core, инъекция `synth-remote` in-memory, политика запрета локальных провайдеров (`remote.llm=server`), слияние моделей |
| T7 — RemoteEventBridge | ✅ | `EventBus.subscribeAll`, SSE-мост backend → локальный EventBus → UI, реконнект с backoff, переписывание id в `remote:<id>` |
| T8 — publish/fork | ✅ | `synth project publish/fork`, backend export/import сессий, прямая синхронизация файлов (walk + fsWrite/fsUpload/fsDownload), e2e подтверждён |
| T9 — offline-деградация | ⏳ | Частично: списки деградируют (локальный мир + warn), статус-индикатор в UI; полная доработка/политика — остаётся |
| T10 — документация | ⏳ | HYBRID.md (этот файл); README/ARCHITECTURE/AGENTS — остаётся |
| T11 — интеграционные тесты | ⏳ | Unit/route-тесты по каждой части есть; отдельный интеграционный сценарий «core+backend» — остаётся |

## Открытые вопросы → решено (2026-08-31)

| № | Вопрос | Решение |
|---|--------|---------|
| 1 | Какие локальные провайдеры разрешены в гибриде (локальный ollama — да/нет)? | **Никаких локальных провайдеров.** Только централизованные (через сервер) |
| 2 | Переносятся ли сессии при publish/fork (или только проект + файлы)? | **Переносятся** (проект + файлы + сессии) |
| 3 | Механика заливки/скачивания workspace-файлов при publish/fork | **Прямая синхронизация файлов** (не git) |
| 4 | Нужен ли exec/shell API на backend для удалённых сессий | **Не требуется** (Модель A: сервер исполняет сам in-process) |
