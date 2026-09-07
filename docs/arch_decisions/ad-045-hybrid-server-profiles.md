# AD-045: Профили серверов и лёгкий runtime-вход в гибриде — единый dataDir

> **Статус:** ✅ Реализовано (0.5.7)
> **Дата:** 2026-09-07

**Решение:** вход в гибриде всегда **лёгкий (runtime)**, без перезапуска
процесса: один локальный core подключается к любому серверу на лету —
`POST /auth/login` выполняет connectRemote/reconnect в applyConnected, а смена
активного сервера — это обычный запрос на другой адрес. Локальные данные
(сессии/проекты/провайдеры/модели/workspace/настройки) лежат в **едином dataDir**
процесса и от сервера не зависят. Серверные «профили» — это **только
мета-реестр для UX** (`~/.config/synth/profiles.json`: knownServers/lastServer
для формы входа и тихого авто-входа при старте). Credentials — **единый
мульти-серверный файл** `~/.config/synth/credentials.json`
(`Record<backendUrl, RemoteCredentials>`). «Выйти» = runtime disconnect + «забыть
токен» (удалить credentials активного сервера) + best-effort revoke refresh-токена
на IdP (RFC 7009) + очистка cookie. Устойчивость — фоновый ConnectionWatcher.

**Контекст:** в AD-043 вход стал runtime, но оставалась промежуточная механика
«вход = переход в профиль»: под каждый сервер создавался профильный каталог
`{baseDataDir}/profiles/{id}`, который фиксировался при старте процесса. Войти на
другой сервер значило перезапустить процесс (switchToProfile +
scheduleRestart/exit 77 через обёртку hybrid.sh, restartable
`SYNTH_RESTARTABLE`, ответ `409 PROFILE_SWITCH_REQUIRED`, `{action:'switch-profile'}`
в UI и перезагрузка страницы после логина). UX стал тяжёлым: логин → рестарт →
перезагрузка UI → ещё один тихий вход; изоляция данных по серверам не окупалась.
Реализовано в ветке `feat/hybrid-server-profiles` (2026-09-07).

## Ключевые решения

| № | Вопрос | Решение |
|---|--------|---------|
| 1 | Когда подключаться | **Всегда лёгкий runtime-вход**: `POST /auth/login` подключает процесс на лету (connectRemote/reconnect в applyConnected); смена активного сервера — reconnect по другому адресу; отдельный перезапуск не нужен |
| 2 | Локальные данные | **Единый dataDir** процесса; данные (сессии/проекты/провайдеры/модели/workspace/настройки) от сервера не зависят. Отменены per-server профильные каталоги `{baseDataDir}/profiles/{id}` (изоляция по серверам вела к «двойному входу») |
| 3 | Профили серверов | **Мета-реестр для UX**: `~/.config/synth/profiles.json` (0600, атомарно) `{version, lastProfileId, profiles:[{id,url,label,lastUsedAt,username}]}` → knownServers (варианты формы входа), lastServer (предзаполнение), авто-вход при старте |
| 4 | Credentials | **Единый мульти-серверный файл** `~/.config/synth/credentials.json` = `Record<backendUrl, RemoteCredentials>` (0600); вход сам сохраняет запись для конкретного backendUrl; авто-вход/refresh ищут по url; `api_key` не сохраняется |
| 5 | Адрес при старте (serve) | `--connect <url>` → адрес из флага (+ ensureProfile для реестра); без `--connect` → `lastProfile.url` из реестра (тихий connectFromSaved после listen); `--no-auto-profile` → нейтральный запуск (адрес вводится в форме входа). DataDir всегда базовый, профильные каталоги не создаются |
| 6 | Форма входа (UI) | Поле «Сервер» (адрес) в гибридном режиме (hybridEnabled, есть `/hybrid/status` standalone-core) показывается **всегда**, редактируемое; предзаполняется `lastServer ?? backendUrl`; варианты — datalist из knownServers. На managed-бэкенде (нет `/hybrid/status`) поля нет |
| 7 | Выход (logout) | `POST /auth/logout`: runtime disconnect (disconnectRemote: bridge stop + откат зеркал провайдеров) + удаление credentials активного сервера + best-effort revoke refresh-токена на IdP (RFC 7009; ошибки игнорируются) + очистка cookie. Мета-профиль НЕ удаляется |
| 8 | Устойчивость | ConnectionWatcher каждые ~15 с: health + auth; `/hybrid/status.connected` = реальная доступность; авто-подключение по сохранённым credentials при возврате сервера (не чаще 1/30 с); refresh при невалидном токене |

## Механика

- **Вход без рестарта:** `POST /auth/login {server?, username, password}` →
  `connectRemote(...)`/reconnect в applyConnected — соединение с сервером
  поднимается «на лету» в уже запущенном процессе; cookie v2 выставляется с
  серверной личностью. После успеха best-effort обновляется мета-профиль в
  реестре (username/lastUsedAt).
- **Единый dataDir:** путь данных — всегда базовый (`--data-dir`/env/config),
  профильные каталоги не создаются. Сессии/проекты/провайдеры/модели живут в
  одном каталоге и переживают смену сервера без копирования.
- **Мета-реестр профилей** (`packages/core/src/profiles.ts`): только метаданные
  для UX — ensureProfile/listProfiles/getLastProfile/findProfileByUrl/removeProfile
  (профильные каталоги и миграция credentials из них удалены).
- **Credentials:** единый файл, ключ записи — backendUrl; вход
  (loginWithPassword) сам пишет запись для конкретного сервера; авто-вход/refresh
  ищут запись по url; API-ключ не сохраняется.
- **Адрес при старте serve:** флаг/профиль → тихий авто-вход после listen;
  нейтральный запуск — форма входа с пустым/последним адресом.
- **Форма входа (UI):** поле «Сервер» показывается всегда в гибридном режиме
  (можно сменить адрес при протухшем токене), предзаполняется
  `lastServer ?? backendUrl`, варианты из knownServers (datalist); на
  managed-бэкенде (нет `/hybrid/status`) поле скрыто. Уточняет п.8 AD-043.
- **Выход:** disconnect (bridge stop + откат зеркал провайдеров), clearCredentials
  активного сервера, best-effort revoke refresh-токена (клиент напрямую в IdP:
  `POST {issuer}/protocol/openid-connect/revoke`, `token_type_hint=refresh_token`,
  public-клиент `synth-cli`; реальный revoke через backend `POST /auth/logout`
  невозможен — тот лишь чистит серверную cookie), очистка cookie. Мета-профиль
  остаётся в реестре → следующий старт предложит сервер в форме.
- **Устойчивость (ConnectionWatcher):** фоновый watcher живости соединения —
  health/auth, авто-переподключение, refresh невалидного токена.

## Ключевые файлы

- `packages/core/src/profiles.ts` — мета-реестр профилей серверов (`~/.config/synth/profiles.json`): ensureProfile/listProfiles/getLastProfile/findProfileByUrl/removeProfile (профильные каталоги и миграция credentials удалены).
- `packages/core/src/server/connection-watcher.ts` — ConnectionWatcher (health/auth ~15 с, авто-подключение по credentials).
- `packages/core/src/remote/connection.ts` — RemoteConnection: runtime connect/disconnect, reconnect, connectFromSaved.
- `packages/core/src/remote/credentials.ts` — единый мульти-серверный `credentials.json` (loadCredentials/saveCredentials/clearCredentials/listCredentials).
- `packages/core/src/remote/device-flow.ts` — `revokeRefreshToken` (RFC 7009, клиент напрямую в IdP).
- `packages/core/src/server/app.ts` — applyConnected/disconnectRemote, handle `{connection, connectRemote, connectRemoteFromSaved, disconnectRemote, ...}`, logout (revoke + clearCredentials).
- `packages/core/src/server/routes/auth.ts` — `POST /auth/login` (runtime, без рестарта), `POST /auth/logout` (disconnect + забыть токен + revoke + cookie).
- `packages/core/src/server/routes/hybrid.ts` — `/hybrid/status`: connected/knownServers/lastServer/serverConfigured/serverLoginAvailable.
- CLI: `packages/core/src/main.ts`, `packages/synth/src/cli.ts` — флаги serve (`--connect`, `--no-auto-profile`, `--token`), авто-вход после listen.
- UI: `packages/ui/src/components/auth/LoginForm.tsx` — поле «Сервер» (всегда в гибриде, datalist knownServers).
- `scripts/hybrid.sh` — запуск локального core в гибриде (сборка + CA + флаги; однократный запуск serve, без обёртки рестарта exit 77).

## Расширяет AD-042 и AD-043

Расширяет/уточняет AD-042 (гибридный режим) и AD-043 (единая идентичность):
механизм входа/профилей уточнён. Конкретное уточнение AD-043 — **п.8 «UX адреса
сервера»**: поле «Сервер» в форме гибрида теперь показывается всегда
(редактируемое), а не скрывается при известном адресе (см. пометку в ad-043).
AD-042/AD-043 остаются основой: миры с `origin`, прокси remote-сущностей,
LLM Proxy, RemoteEventBridge, publish/fork, runtime-подключение и единая личность
не меняются.

### Отменено из промежуточной механики

Ранний (промежуточный, отдельным AD не оформлялся) подход «профильные каталоги
данных + вход = переход в профиль с рестартом» отменён:

- per-server профильные каталоги `{baseDataDir}/profiles/{id}` (изоляция данных
  по серверам) — данные теперь в едином dataDir;
- «вход = переход в профиль»: switchToProfile, scheduleRestart/exit 77 (обёртка
  hybrid.sh), restartable (`SYNTH_RESTARTABLE`), ответ
  `409 PROFILE_SWITCH_REQUIRED`, `{action:'switch-profile'}` в UI, перезагрузка
  страницы после логина — вход всегда runtime;
- миграция/копирование credentials между профильными каталогами — credentials
  единые (мульти-серверный файл).

---
