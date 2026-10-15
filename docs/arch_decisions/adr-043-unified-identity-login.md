# ADR-043: Единая идентичность в гибриде — вход в UI без Keycloak-ритуала

> **Статус:** ✅ Реализовано (0.4.2)
> **Дата:** 2026-09-04

**Решение:** локальный core в гибриде больше не требует интерактивного
OIDC device flow при старте. Сервер поднимается «холодным» (без блокировок и
ссылок в консоли); подключение к серверу и аутентификация выполняются в
**рантайме** — через форму входа в локальном UI (адрес сервера опционален +
логин/пароль, ROPC «за кулисами»). Локальная **личность = серверная**:
username и роли приходят с сервера, профиль/настройки/тема — из серверного
`/auth/profile`, админ-возможности (audit/users/admin/settings/…)
проксируются на сервер. Пользователь **никогда не взаимодействует с Keycloak**
напрямую.

**Контекст:** в ADR-042 вход был OIDC device flow: `serve --connect` при старте
печатал verification URI + user_code в консоль и блокировался до подтверждения
в браузере Keycloak. Это плохой UX («открой ссылку, скопируй код»), и он
требовал знания issuer/client_id в конфиге. Продуктовое требование: запустил →
открыл UI → ввёл адрес сервера (если не задан), логин и пароль → работаешь.

## Ключевые решения

| № | Вопрос | Решение |
|---|--------|---------|
| 1 | Аутентификация пользователя | **ROPC** (`grant_type=password`) из формы UI; пароль не хранится — только токены в `~/.config/synth/credentials.json` (0600) |
| 2 | Дискавери IdP | Локальный core сам спрашивает у сервера `GET {server}/auth/oidc-meta` (публичный: issuer + public client_id, без секрета); fallback — `--oidc-issuer`/`--oidc-client-id` |
| 3 | Клиент в Keycloak | **public-клиент `synth-cli`** (device grant + direct access grants); confidential `synth` (веб) не тронут; клиентский секрет пользователям не раздаётся |
| 4 | Когда подключаться | **runtime**: сервер стартует без подключения; connect на логине (`connectByPassword`) или тихий `connectFromSaved` при старте; `--token` — для автоматизации (api_key) |
| 5 | Локальная личность | cookie v2 `synth_session` несёт подписанный JSON `{v:2, kind:'server'\|'local', user}`; `getCurrentUser` возвращает серверного пользователя → RBAC работает по серверным ролям |
| 6 | Профиль/настройки | `GET/PUT /auth/profile` проксируются на сервер (единый источник: тема, язык, предпочтения) |
| 7 | Админ-возможности | серверные роуты `/api/v2/{audit,users,admin,logs,gateway,context,llm,providers,models}` проксируются на backend с токеном пользователя |
| 8 | UX адреса сервера | адрес задан параметром/env → поле в форме скрыто; не задан → показывается поле «Адрес сервера» |
| 9 | Device flow | остаётся только для CLI `synth connect` и автоматизации; из пользовательского UI-пути убран |
| 10 | Offline | локальный мир живёт, серверные операции 502 + баннер (как ADR-042) |

## Механика runtime-подключения

- **`RemoteConnection`** (`packages/core/src/remote/connection.ts`) — менеджер
  состояния подключения: `{connected, backendUrl, client, getToken, user}`;
  операции: `discoverOidc(serverUrl)` (GET `/auth/oidc-meta`),
  `connectByPassword(serverUrl, user, pass)` (дискавери → ROPC → credentials →
  `/auth/status`), `connectFromSaved(backendUrl?)` (без device flow),
  `connectWithApiKey(serverUrl, apiKey)`, `disconnect()`.
- **app.ts**: `createStandaloneApp` создаёт `RemoteConnection`; на connect —
  инъекция remote-провайдера (модели с сервера), старт `RemoteEventBridge`,
  политика «локальные провайдеры запрещены» (`remote.llm: server`); на
  disconnect — остановка bridge и очистка кешей. Роуты/прокси/hybrid-status
  читают **текущее** состояние (геттеры `() => connection.client`), а не
  зафиксированный при старте клиент.
- **Старт без блокировки**: `cli.ts`/`main.ts` не вызывают
  `ensureAuthenticated` (device flow); после `server.listen` — тихий
  `connectFromSaved`/`connectWithApiKey`; если credentials нет — UI показывает
  форму логина.
- **Логин**: `POST /auth/login {server?, username, password}` → сервер берётся
  из body → иначе `defaultBackendUrl` → `connectRemote(...)` → server-cookie.
  Авто-логин: `GET /auth/session|status` при отсутствии cookie пытается
  `connectRemoteFromSaved()` и ставит cookie с серверной личностью.
- **Статус для UI**: `/api/v2/hybrid/status` отдаёт `serverConfigured`
  (адрес задан при старте) и `serverLoginAvailable` — по ним форма логина
  показывает/скрывает поле адреса.
- **WS**: upgrade `/ws/events` принимает cookie-сессию v2 (не только
  `Bearer == apiKey`) — UI подключается по WS без SSE-fallback.

## Ключевые файлы

- `packages/core/src/remote/connection.ts` — RemoteConnection (+ тесты).
- `packages/core/src/server/app.ts` — создание connection, applyConnected/disconnectRemote, возвращаемый handle `{connection, connectRemote, connectRemoteFromSaved, connectRemoteWithApiKey, disconnectRemote, getHybridStatus}`.
- `packages/core/src/server/routes/auth.ts` — `POST /auth/login` (ROPC), авто-логин в `/session`/`/status`, прокси `/auth/profile`.
- `packages/core/src/server/routes/hybrid.ts` — статус (serverConfigured/serverLoginAvailable).
- `packages/core/src/server/proxy.ts` — прокси серверных роутов (динамический клиент).
- `packages/core/src/auth/local.ts` — cookie v2 (server/local identity).
- `packages/backend/src/routes/auth.ts` — `GET /auth/oidc-meta`.
- `packages/ui/src/components/auth/LoginForm.tsx` — форма адрес+логин+пароль (адрес по условию).
- CLI: `packages/core/src/main.ts`, `packages/synth/src/cli.ts`, `scripts/hybrid.sh`.

## Расширяет ADR-042

Заменяет интерактивный вход (device flow при старте) на runtime-подключение
через форму UI и вводит единую личность/дискавери IdP. ADR-042 остаётся основой:
миры с `origin`, прокси remote-сущностей, LLM Proxy, RemoteEventBridge,
publish/fork. Device flow сохранён для CLI `synth connect`/автоматизации.
Детальные требования и статус — в `docs/HYBRID.md`.

> **Уточнено ADR-045 (2026-09-07):** поле «Сервер» в форме гибрида теперь
> показывается всегда (редактируемое), а не скрывается при известном адресе;
> введены профили-метареестр и единый dataDir.

---
