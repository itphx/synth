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
```

`cliClientId` (default `synth-cli`) — public client_id, который backend отдаёт локальным клиентам через `GET /auth/oidc-meta` (`cliClientId || 'synth-cli'`, `packages/backend/src/routes/auth.ts`). Локальный core использует его для ROPC/device flow при гибридном подключении (см. [HYBRID.md](HYBRID.md)); в Keycloak это отдельный public-клиент с включённым Direct Access Grants (секрета нет).

### 3.2 Переменные окружения

| Переменная | Назначение |
|-----------|------------|
| `SYNTH_OIDC_ENABLED` | `true` — включить OIDC |
| `SYNTH_OIDC_ISSUER` | Issuer: `https://<keycloak-host>/realms/<realm>` |
| `SYNTH_OIDC_CLIENT_ID` | Client ID (например `synth`) |
| `SYNTH_OIDC_CLIENT_SECRET` | Секрет клиента (хранить в секретах, не в конфиге) |
| `SYNTH_OIDC_REDIRECT_URI` | Redirect URI: `https://<synth-host>/auth/callback` |
| `SYNTH_OIDC_CLI_CLIENT_ID` | Public client_id для локального CLI/core (ROPC/device flow), default `synth-cli` (`packages/backend/src/lib/app-config.ts`) |

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
- если Keycloak подписан внутренним CA, укажите `backend.extraEnv.NODE_EXTRA_CA_CERTS` с путём к CA-сертификату
  и смонтируйте его (иначе backend не сможет проверить JWT и обращаться к issuer).

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

### Симптомы и причины

| Симптом | Причина | Решение |
|---------|---------|---------|
| Все пользователи получают `USER`, админки нет | Маппер ролей не включает роли в `id_token`/`access_token` | Включить `id.token.claim` и `access.token.claim` у мапперов realm roles / client roles (см. 2.4) |
| Роль есть в Keycloak, но в UI её нет | Роль называется не из списка известных (`ADMIN/USER/LEAD/AUDITOR`) | Переименовать роль или добавить её в `KNOWN_ROLES` |
| Роль выдана, но как client-роль другому клиенту | `resource_access.<clientId>` не совпадает с `clientId` Synth | Выдавать роль клиенту `synth` или назначить realm-роль |
| Backend не может проверить JWT / 401 при входе | Backend не доверяет CA Keycloak | Настроить `NODE_EXTRA_CA_CERTS` (см. 3.3) |

## 5. Учётные записи тестового окружения

- Тестовая УЗ (realm `synth`, роль `user`) и временная админская УЗ (realm `master`) — в файле
  `secrets/keycloak-accounts.md` в корне проекта, **вне** git-репозитория `synth/`.
- Временная админская УЗ используется для admin API Keycloak (`admin-cli`) — например, для диагностики
  ролей и мапперов.
- Client secret клиента `synth` — в SealedSecret `synth-secrets` (namespace `synth`, ключ
  `SYNTH_OIDC_CLIENT_SECRET`).
