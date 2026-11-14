# Интеграция с Keycloak (OIDC)

> 🌐 [English](./en/KEYCLOAK.md) · **Русский**

Инструкция для оператора: как настроить Keycloak и какие параметры указать в Synth, чтобы развернуть связку
«Synth + Keycloak» с корректной выдачей ролей. Материал основан на реальной настройке (realm `synth`,
клиент `synth`, FreeIPA в качестве хранилища пользователей).

## 1. Как Synth работает с Keycloak

Backend выступает OIDC-клиентом (confidential, аутентификация по `client_secret`). Поддерживаются два способа входа:

| Способ | Эндпоинт | Когда используется |
|--------|----------|--------------------|
| Authorization Code | `GET /auth/login` → редирект на Keycloak → `GET /auth/callback` | Стандартный браузерный flow |
| ROPC (логин/пароль) | `POST /auth/login` (JSON: `username`, `password`) | Вход по логину/паролю прямо в UI, без редиректа |

После обмена кода/пароля backend верифицирует `id_token` и `access_token` через JWKS провайдера и извлекает роли.

**Как извлекаются роли** (`packages/backend/src/auth/oidc.ts`):

1. Роли берутся из `realm_access.roles` (realm-роли) и `resource_access.<clientId>.roles` (client-роли) — из `id_token`;
2. Если в `id_token` ролей нет — берутся из `access_token`;
3. Роли нормализуются в верхний регистр и фильтруются по списку известных: `ADMIN`, `USER`, `LEAD`, `AUDITOR`;
4. Если известных ролей нет вообще — пользователь получает дефолтную роль `USER`.

От этих ролей зависит доступ: `ADMIN` — админские разделы UI и админ-эндпоинты, `AUDITOR` — аудит и логи,
`LEAD` — дашборд и управление сессиями/проектами, `USER` — обычная работа.

## 2. Настройка Keycloak

### 2.1 Realm

Заведите отдельный realm (например `synth`). Идентификатор issuer для Synth:

```
https://<keycloak-host>/realms/<realm>
```

### 2.2 Клиент

Создайте клиент с параметрами:

| Параметр | Значение | Зачем |
|----------|----------|-------|
| Client ID | `synth` | Должен совпадать с `clientId` в конфиге Synth |
| Client authentication | **ON** (confidential) | Аутентификация по `client_secret` |
| Standard flow | **ON** | Для `GET /auth/callback` (authorization code) |
| Direct Access Grants | **ON** | Для `POST /auth/login` (ROPC) |
| Valid redirect URIs | `https://<synth-host>/auth/callback` | Куда Keycloak редиректит после входа |
| Web origins | `https://<synth-host>` | Разрешённые CORS-источники |

### 2.3 Роли

Создайте realm-роли с точными именами: `admin`, `user`, `lead`, `auditor` (в нижнем регистре — backend сам
приведёт к `ADMIN/USER/LEAD/AUDITOR`).

> **Важно.** Имена ролей должны быть именно из списка известных. Роль `administrator`, `synth_admin`,
> `admins` и т.п. будет **отброшена** фильтром, и пользователь получит `USER`.

Выдать роль можно напрямую пользователю или через группу (рекомендуется для FreeIPA):

1. Группа из FreeIPA синхронизируется в Keycloak как группа (например `synth_admins`);
2. В Keycloak: группа → **Role mapping** → назначить realm-роль `admin`;
3. Пользователи группы получают роль автоматически (composite role).

Проверить: в Keycloak Admin console у пользователя в **Role mapping** должны отображаться эффективные роли.

### 2.4 Client scopes и мапперы ролей — на что обратить внимание

Роли попадают в токены через протокольные мапперы в client scopes (обычно скоуп `roles`):
мапперы **realm roles** (`realm_access.roles`) и **client roles** (`resource_access.<clientId>.roles`).

У обоих мапперов должны быть включены:

| Опция маппера | Значение | Эффект |
|---------------|----------|--------|
| `id.token.claim` | `true` | Роли попадают в `id_token` |
| `access.token.claim` | `true` | Роли попадают в `access_token` |
| `multivalued` | `true` | Роли как массив |

**Типовая проблема:** если у маппера выключен `id.token.claim`, роли есть только в `access_token`.
Backend по fallback возьмёт их из `access_token`, но до этого поведения (и при выключенном `access.token.claim`)
пользователь всегда получал дефолт `USER` — админские разделы в UI не появлялись, даже если роль выдана корректно.

Проверка: декодируйте `id_token` (например на https://jwt.io) — в payload должен быть блок:

```json
{
  "realm_access": {
    "roles": ["user", "admin", "..."]
  }
}
```

### 2.5 Группы → доступ к проектам (ADR-140)

Группы — **отдельная ось** от ролей. Роль (`ADMIN`/`USER`/`LEAD`/`AUDITOR`) — глобальные
права инстанса; группа (`synth-devs`, `synth-admins`) — источник грантов **на проект**
(«участники через группы», `group_members`). Роли фильтруются списком известных и
приводятся к верхнему регистру; группы — **регистрозависимые**, имена сверяются точно.

#### В Keycloak: маппер членства в группах

Группы приезжают отдельным claim'ом `groups` — его кладёт **маппер членства в группах**
(не маппер ролей из 2.4). Порядок: **Realm → Groups** — создайте группы и назначьте
пользователям; затем в client scope клиента `synth` добавьте маппер **Group membership**
с такими опциями:

| Опция маппера | Значение | Эффект |
|---------------|----------|--------|
| `Claim name` | `groups` | Имя claim'а (по умолчанию у Keycloak — `groups`) |
| `id.token.claim` | `true` | Группы попадают в `id_token` |
| `access.token.claim` | `true` | Группы попадают в `access_token` |
| `multivalued` | `true` | Группы как массив |
| `Full group path` | `false` | Только имя группы (`synth-devs`), а не путь (`/synth-devs`) |

> **Внимание на `Full group path`.** Значения claim'а — это ровно то, что Synth сверяет
> с allowlist'ом. При `Full group path: true` в claim'е будет `/synth-devs`, и в allowlist
> надо писать именно `/synth-devs`; при `false` — `synth-devs`. Разница в одном слеше
> означает, что группа не совпадёт.

Проверка: в декодированном `id_token` должен быть блок:

```json
{
  "groups": ["synth-devs", "synth-admins"]
}
```

#### В Synth: allowlist имён групп

Из claim'а принимаются **не все** группы, а только перечисленные в allowlist'е:

```yaml
auth:
  oidc:
    groups:
      claim: groups          # имя claim'а с группами (по умолчанию groups)
      allow:                 # allowlist имён групп; пусто — групп нет
        - synth-devs
        - synth-admins
```

или через env (csv, приоритетнее `config.yaml`):

```bash
SYNTH_OIDC_GROUPS_CLAIM=groups
SYNTH_OIDC_GROUPS_ALLOW=synth-devs,synth-admins
```

**Без allowlist групп нет** (fail-closed): «принять все» невозможно — claim из IdP не
является доверенным входом, а список имён групп задаёт оператор. Пустой allowlist →
у пользователя нет ни одной группы → гранты по группам не дают доступа.

Разбор claim'а: имя — **верхнего уровня** (вложенные пути не разбираются), значения —
только строки (обрезка пробелов, дедуп, порядок claim'а сохраняется); claim отсутствует
или это не массив → групп нет. Fallback: если в `id_token` групп нет, берутся из
`access_token`.

#### Типовые проблемы

| Симптом | Причина | Решение |
|---------|---------|---------|
| Групп нет, грант по группе не даёт доступа | Маппер членства в группах выключен — claim `groups` в токене отсутствует | Включить маппер (см. выше) и **перезайти**: группы — снимок на момент логина |
| Группа в allowlist есть, но не сматчилась | Сверка **точная и регистрозависимая**: `Synth-Devs` ≠ `synth-devs`; путь `/synth-devs` ≠ `synth-devs` | Привести allowlist к тому, что реально в claim'е (посмотреть `id_token`) |
| Изменил состав групп в IdP — изменения не видны | Группы — **снимок на момент логина** (cookie-сессия), обновляются только при повторном входе | Выйти и войти заново; либо дождаться истечения cookie-сессии (`auth.sessionMaxAgeMinutes`, по умолчанию 1440 мин = 24 ч) |

## 3. Параметры Synth

### 3.1 config.yaml

```yaml
auth:
  oidc:
    enabled: true
    issuer: "https://keycloak.example.com/realms/synth"
    clientId: "synth"
    clientSecret: "<client-secret>"
    redirectUri: "https://synth.example.com/auth/callback"
    cliClientId: "synth-cli"      # public client для локального CLI/core (ROPC/device flow), не секрет
    groups:                        # ADR-140: источник групп для доступа к проектам
      claim: "groups"              # имя claim'а с группами (по умолчанию groups)
      allow:                       # allowlist имён групп; пусто — групп нет (fail-closed)
        - "synth-devs"
        - "synth-admins"
```

`cliClientId` (default `synth-cli`) — public client_id, который backend отдаёт локальным клиентам через `GET /auth/oidc-meta` (`cliClientId || 'synth-cli'`, `packages/backend/src/routes/auth.ts`). Локальный core использует его для ROPC/device flow при гибридном подключении (см. [HYBRID.md](HYBRID.md)); в Keycloak это отдельный public-клиент с включённым Direct Access Grants (секрета нет).

Секция `groups` — **необязательная** (старые конфиги без неё валидны). Подробности — в разделе [2.5](#25-группы--доступ-к-проектам-adr-140) и в [CONFIGURATION.md](CONFIGURATION.md).

### 3.1.1 Offline-токен для гибрида (длинные сессии)

Гибридный вход запрашивает `offline_access` (ROPC: `openid offline_access`, device flow: `openid profile offline_access`) — иначе refresh-токен живёт в рамках SSO-сессии и умирает по `ssoSessionMaxLifespan`/`ssoSessionIdleTimeout` посреди длинного хода или саб-агента (см. [HYBRID.md](HYBRID.md) §3.1). Если scope недоступен, клиент сам откатывается на обычный токен — вход не ломается.

Для клиента `synth-cli` должен быть доступен client scope **`offline_access`**: в Keycloak Admin console → **Clients → synth-cli → Client scopes** добавить `offline_access` (или разрешить его на уровне realm: **Client scopes → offline_access → Scope**). Проверка: ROPC-ответ содержит `refresh_token`, а его JWT payload — `"typ": "Offline"` и `refresh_expires_in: 0`.

Realm-настройки, задающие срок жизни:

| Настройка | Где | Смысл |
|-----------|-----|-------|
| `ssoSessionIdleTimeout` | Realm settings → Sessions | idle обычной SSO-сессии (test — 1800 с) |
| `ssoSessionMaxLifespan` | Realm settings → Sessions | максимум обычной SSO-сессии (test — 36000 с = 10 ч); refresh его **не** продлевает |
| `offlineSessionIdleTimeout` | Realm settings → Sessions | idle offline-сессии (test — 30 дней) |
| `offlineSessionMaxLifespan` | Realm settings → Sessions | максимум offline-сессии (test — 60 дней) |
| `revokeRefreshToken` | Realm settings → Tokens | `false` — refresh-токен не ротируется на каждый refresh (совместимо) |

**Как отключить долгие сессии:** убрать `offline_access` из client scopes клиента `synth-cli`. Клиент получит `invalid_scope` и автоматически повторит вход без offline — останутся ограничения обычной OIDC-сессии (`ssoSessionIdleTimeout`/`ssoSessionMaxLifespan`), и длинные прогоны будут требовать повторного входа.

### 3.2 Переменные окружения

| Переменная | Назначение |
|-----------|------------|
| `SYNTH_OIDC_ENABLED` | `true` — включить OIDC |
| `SYNTH_OIDC_ISSUER` | Issuer: `https://<keycloak-host>/realms/<realm>` |
| `SYNTH_OIDC_CLIENT_ID` | Client ID (например `synth`) |
| `SYNTH_OIDC_CLIENT_SECRET` | Секрет клиента (хранить в секретах, не в конфиге) |
| `SYNTH_OIDC_REDIRECT_URI` | Redirect URI: `https://<synth-host>/auth/callback` |
| `SYNTH_OIDC_CLI_CLIENT_ID` | Public client_id для локального CLI/core (ROPC/device flow), default `synth-cli` (`packages/backend/src/lib/app-config.ts`) |
| `SYNTH_OIDC_GROUPS_CLAIM` | Имя claim'а с группами (ADR-140), default `groups` |
| `SYNTH_OIDC_GROUPS_ALLOW` | Allowlist имён групп (ADR-140) — csv (`synth-devs,synth-admins`), пробелы обрезаются, пустые элементы отброшены; приоритетнее `config.yaml`; **пустое значение — групп нет** (fail-closed) |

Приоритет: env vars > config.yaml (см. [CONFIGURATION.md](CONFIGURATION.md)).

### 3.3 Helm-деплой (synth-deploy)

```yaml
backend:
  oidc:
    enabled: true
    issuer: "https://keycloak.example.com/realms/synth"
    clientId: "synth"
    redirectUri: "https://synth.example.com/auth/callback"
```

- `clientSecret` не указывается в values — кладётся в SealedSecret как `SYNTH_OIDC_CLIENT_SECRET`;
- если Keycloak подписан внутренним CA, задайте доверие **штатным путём** — секция `security.tls`
  (`caFile`/`caPem`) или env `SYNTH_TLS_CA_FILE` (иначе backend не сможет проверить JWT и обратиться к issuer):

  ```yaml
  security:
    tls:
      caFile: /etc/synth/tls/ca.crt    # или caPem — сам PEM; SYNTH_TLS_CA_FILE / SYNTH_TLS_CA_PEM
  ```

  В Helm CA удобно положить в Secret и смонтировать (`security.tls.existingSecret` + `caKey`) —
  см. `charts/synth/README.md`. `backend.extraEnv.NODE_EXTRA_CA_CERTS` оставлен лишь как
  совместимость для дочерних процессов и **не** является конфигурацией Synth (при заданном
  `security.tls` Synth ставит собственный глобальный TLS-dispatcher и эту переменную не учитывает).

## 4. Проверка и диагностика

### Проверить доступность issuer

```bash
curl -s https://<keycloak-host>/realms/synth/.well-known/openid-configuration | jq .issuer
```

### Проверить, что роли попадают в id_token

```bash
curl -s -X POST "https://<keycloak-host>/realms/synth/protocol/openid-connect/token" \
  --data-urlencode "grant_type=password" \
  --data-urlencode "client_id=synth" \
  --data-urlencode "client_secret=<client-secret>" \
  --data-urlencode "username=<user>" \
  --data-urlencode "password=<password>" \
  --data-urlencode "scope=openid" \
  | jq -r .id_token | cut -d. -f2 | base64 -d 2>/dev/null | jq .
```

В декодированном `id_token` должны быть `realm_access.roles` с ожидаемой ролью (`admin` и т.п.).

### Проверить, что группы попадают в id_token

Та же команда, но в payload ищем блок `groups`:

```json
{
  "groups": ["synth-devs", "synth-admins"]
}
```

Значения сверяются с allowlist'ом **точно и регистрозависимо** — сверьте их буквально
(см. [2.5](#25-группы--доступ-к-проектам-adr-140)).

### Симптомы и причины

| Симптом | Причина | Решение |
|---------|---------|---------|
| Все пользователи получают `USER`, админки нет | Маппер ролей не включает роли в `id_token`/`access_token` | Включить `id.token.claim` и `access.token.claim` у мапперов realm roles / client roles (см. 2.4) |
| Роль есть в Keycloak, но в UI её нет | Роль называется не из списка известных (`ADMIN/USER/LEAD/AUDITOR`) | Переименовать роль или добавить её в `KNOWN_ROLES` |
| Роль выдана, но как client-роль другому клиенту | `resource_access.<clientId>` не совпадает с `clientId` Synth | Выдавать роль клиенту `synth` или назначить realm-роль |
| Групп нет, грант по группе не даёт доступа | Не задан allowlist (`auth.oidc.groups.allow` / `SYNTH_OIDC_GROUPS_ALLOW`) либо выключен маппер членства в группах | Задать allowlist, включить маппер и перезайти (см. 2.5) |
| Группа в allowlist есть, но не совпала | Сверка точная и регистрозависимая; путь `/synth-devs` ≠ `synth-devs` | Привести allowlist к значениям из `id_token` |
| Backend не может проверить JWT / 401 при входе | Backend не доверяет CA Keycloak | Настроить `security.tls.caFile`/`caPem` (env `SYNTH_TLS_CA_FILE`, см. 3.3) |

## 5. Учётные записи тестового окружения

- Тестовая УЗ (realm `synth`, роль `user`) и временная админская УЗ (realm `master`) — в файле
  `secrets/keycloak-accounts.md` в корне проекта, **вне** git-репозитория `synth/`.
- Временная админская УЗ используется для admin API Keycloak (`admin-cli`) — например, для диагностики
  ролей и мапперов.
- Client secret клиента `synth` — в SealedSecret `synth-secrets` (namespace `synth`, ключ
  `SYNTH_OIDC_CLIENT_SECRET`).
