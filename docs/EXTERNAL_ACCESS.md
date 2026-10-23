# Внешние доступы (OAuth-коннекторы) — устройство подсистемы

> **Спецификация** — «как устроено сейчас»: формат записей, порты, реализации, OAuth-клиент, правила
> секретов и явная граница «реализовано / план».
> Решение — [ADR-105](./arch_decisions/adr-105-external-credentials.md) «Внешние доступы — единый слой
> доступа к внешним сервисам (OAuth-коннекторы)». Правила ведения документов — [ARCH_DECISIONS.md](./ARCH_DECISIONS.md).
> **Состояние:** Ф0–Ф3 (контракты, хранилище, OAuth-клиент, MCP-транспорт) — **реализованы**; Ф4 — **план**,
> перечислен в §10 и нигде не выдаётся за работающий.

## 1. Назначение

**Внешний доступ** (`ExternalCredential`) — сущность слоя доступа к внешним сервисам: она хранит
OAuth-креды (access/refresh-токен) внешнего провайдера и отдаёт их **транспорту** коннектора.

Ключевые свойства:

- доступ — **ресурс с временем жизни** (срок, статус, отзыв), а не «ещё один ключ»;
- токен нужен **в исходном виде** (его подставляет транспорт), поэтому at-rest он **зашифрован**, а не
  захеширован;
- **наружу (API/UI) секрет не отдаётся никогда** — только метаданные с маской;
- **агент и модель токен не видят**: доступ используется системой, а не промптом.

## 2. Модель записи

### 2.1 Внутренняя форма — `ExternalCredential`

`packages/shared/src/types/external-credentials.ts` (zod: `externalCredentialSchema`).

| Поле | Тип | Смысл |
|---|---|---|
| `id` | `string` | id записи, префикс `extc_` (генерирует хранилище) |
| `provider` | `string` | ключ описания OAuth-провайдера |
| `connectorId?` | `string` | id записи реестра MCP (ADR-071), если доступ привязан к коннектору |
| `clientId` | `string` | `client_id` приложения/коннектора (публичное значение, не секрет) |
| `scopes` | `string[]` | запрошенные scope'ы |
| `owner` | `{ kind: 'user' \| 'instance' \| 'local'; id: string }` | владелец доступа (часть записи) |
| `projectId?` | `string` | опциональная привязка к проекту |
| `secretEnc` | `string` | **зашифрованный** access-токен, формат `enc:v1:…` |
| `refreshEnc?` | `string` | **зашифрованный** refresh-токен, формат `enc:v1:…` |
| `status` | `'active' \| 'expired' \| 'revoked' \| 'error'` | состояние доступа |
| `expiresAt?` | ISO-8601 | срок действия access-токена |
| `revokedAt?` | ISO-8601 | отзыв доступа (необратимый) |
| `createdBy` | `string` | кто выдал доступ (id пользователя инстанса) |
| `createdAt` | ISO-8601 | создание |
| `lastUsedAt?` | ISO-8601 | последнее использование (best-effort) |
| `scopesGranted?` | `string[]` | фактически выданные провайдером scope'ы |

### 2.2 Публичная форма — `ExternalCredentialMeta`

Единственная форма, которая отдаётся наружу: те же метаданные **без** `secretEnc`/`refreshEnc`, плюс
`secretMask` (маска `mask:<16 hex>` — необратимая сводка шифротекста) и `hasRefreshToken` (признак
наличия refresh-токена). Маппер — `toExternalCredentialMeta`, маска — `maskExternalSecret`
(считается по **зашифрованному** значению, поэтому plaintext из маски не восстановить).

### 2.3 Статусы

| Статус | Смысл | Как наступает |
|---|---|---|
| `active` | доступ рабочий | создание или успешный refresh |
| `expired` | срок access-токена истёк | провайдер не выдал срок / истёк, требуется refresh |
| `revoked` | доступ отозван | `revoke()` — идемпотентно и **необратимо**: обновление токенов его не «оживляет» |
| `error` | провайдер отказал | `invalid_grant` (refresh-токен отозван/истёк) → нужна явная переавторизация; молчаливый отказ коннектора недопустим |

## 3. Правила: открыто / зашифровано / маскировано

- **Открыто** (видно в UI, в выдаче метаданных и в аудите): `provider`, `clientId`, `scopes`,
  `scopesGranted`, сроки, владелец, статус, `createdBy`/`createdAt`/`lastUsedAt`.
- **Зашифровано**: только токены (`secretEnc`/`refreshEnc`), формат `enc:v1:…` (AES-256-GCM мастер-ключом,
  `packages/core/src/security/crypto.ts`). Хеш здесь неприменим — токен нужен в исходном виде для
  подстановки в заголовок (прецедент — signing-секрет вебхуков, ADR-052).
- **Маскировано**: наружу отдаётся `secretMask`; значение токена не возвращается **ни одним** методом
  публичного API.
- **Единственный путь к plaintext** — `reveal()` порта (`{ accessToken, refreshToken? }`): только для
  подстановки в транспорт, никогда — в UI/логи/промпт.
- **На диске plaintext не появляется никогда**: файл хранилища содержит только `enc:v1:…`.

## 4. Владение и проекция по проекту

| Вид доступа | `owner.kind` | Кто выдаёт | Кто видит |
|---|---|---|---|
| Пользовательский | `user` (id пользователя инстанса) | сам пользователь | владелец |
| Инстансный | `instance` (id `instance`) | `ADMIN`/`LEAD` | `ADMIN`/`LEAD` |
| Локальный | `local` (standalone, single-user) | владелец инстанса | владелец инстанса |

- `owner` — **часть записи**, а не вычисляемое поле: доступ может быть инстансным и не принадлежать ни
  одному пользователю (например, корпоративный доступ, выданный админом).
- `projectId` — опциональная привязка: доступ уровня проекта виден его участникам, доступ уровня
  пользователя — только владельцу. **Проверки доступа в HTTP-роутах — не реализованы (Ф4)**; сейчас
  слой предоставляет только фильтр `ExternalCredentialFilter` (по владельцу/коннектору/провайдеру/
  проекту/статусу) и правило «доступ проверяется на границе» (инвариант 16).
- В standalone всё нормализуется к `local` (инвариант 19).

## 5. Порт хранилища `ExternalCredentialRepository`

`packages/core/src/storage/ports/external-credential-repository.ts` — доменный порт слоя хранения
(ADR-096). Подключён в `StorageContext.externalCredentials`.

| Метод | Что делает |
|---|---|
| `list(filter?)` | метаданные (без секретов), фильтры — владелец/коннектор/провайдер/проект/статус |
| `get(id)` | метаданные одной записи либо `null` |
| `create(input)` | создать доступ; access/refresh-токены шифруются мастер-ключом **внутри** хранилища |
| `updateTokens(id, patch)` | обновить токены (refresh/ротация) и метаданные; отозванный остаётся отозванным |
| `markError(id)` | перевести в `status:'error'` (после `invalid_grant`) |
| `revoke(id)` | пометить отозванным (идемпотентно, необратимо) |
| `touch(id)` | best-effort отметка использования (`lastUsedAt`) |
| `reveal(id)` | расшифрованные токены — **только** для подстановки в транспорт |
| `listRaw()` | сырые записи (включая `secretEnc`) — только для админских операций хранилища (ротация мастер-ключа, Ф4) и для CAS-сверки `refreshEnc` |

Ошибки — `ExternalCredentialStoreError` с кодами `duplicate_id`, `not_found`, `decrypt_failed`,
`encryption_unavailable`, `invalid`; **секрет в тексте ошибки не фигурирует**.

Деградация хранилища (ADR-098) — общий HTTP-механизм (`server/storage-degraded.ts`: мутирующий метод →
`503 STORAGE_DEGRADED_READONLY`); порт собственных проверок не дублирует.

## 6. Реализации

| Реализация | Где | Особенности |
|---|---|---|
| Файловая | `packages/core/src/storage/external-credential-store.ts` (`ExternalCredentialStore`) | `{dataDir}/secrets/oauth/credentials.json` — каталог `0700`, файл `0600`, атомарная запись (tmp→rename, ADR-005); id `extc_…`; на диске только `enc:v1:…` |
| In-memory | `packages/core/src/storage/memory/external-credentials.ts` (`MemoryExternalCredentialRepository`) | те же поля и маппер метаданных — для герметичных тестов |
| PostgreSQL | `packages/storage-postgres/src/ports/external-credentials.ts` | таблица `external_credentials` (миграция `012-external-credentials.ts`): колонки `secret_enc`/`refresh_enc` (`text`, готовый `enc:v1:…`), индексы по владельцу и коннектору; шифрование — **только** core-хелперами через ленивый `import('@itphx/synth-core')` (как у SSH-ключей) |

**Почему `{dataDir}/secrets/oauth/`, а не обычный JSON:** бэкап без `--with-secrets` исключает только
каталог `secrets/` — токены в обычном JSON попадали бы в архив всегда.

**Контрактный suite** (паспорт порта, ADR-096) — `packages/core/src/storage/contract/external-credential-repository.contract.ts`
(`describeExternalCredentialRepository`): уникальность id, идемпотентность и необратимость `revoke`,
отсутствие plaintext в выдаче и на диске, статус после ошибки refresh, фильтры, `reveal`. Прогоны —
`contract/file.test.ts`, `contract/memory.test.ts`, `contract/postgres.test.ts` (последний — против живой БД,
задача `test-postgres`).

## 7. OAuth-клиент

`packages/core/src/engine/oauth/` — клиент и сервис слоя доступов.

| Модуль | Что делает |
|---|---|
| `types.ts` | описание провайдера — **данные** (`authorizeUrl`/`tokenUrl`/`revokeUrl?`/`clientId`/`scopes?`/`clientAuth?`/`redirectUri?`), `OAuthTokenSet`, `OAuthError` (коды: `invalid_grant`, `network`, `missing_client_secret`, …) |
| `pkce.ts` | PKCE S256 (RFC 7636): `createPkcePair`, `computeCodeChallenge`, `buildAuthorizationUrl`, `createState` |
| `client-secret.ts` | `client_secret` **только** из env `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` или файла `{dataDir}/secrets/oauth/<provider>.client_secret` (`0600`) — в конфиге его нет, в логах и текстах ошибок он не появляется |
| `client.ts` | `OAuthClient`: `exchangeCode` (RFC 6749 §4.1.3), `refresh` (§6), `revoke` (RFC 7009, best-effort); сеть — **только** `egressFetch` (ADR-099) |
| `service.ts` | `OAuthCredentialService`: `exchangeAndStore`, `refresh`, `revoke` — единственный путь записи — порт `ExternalCredentialRepository` (прямой записи в `{dataDir}` нет) |

**Device flow** не дублируется: обобщён `packages/core/src/remote/device-flow.ts` (`postFormDetailed` —
HTTP-статус + тело, инъекция транспорта для тестов).

**Refresh и гонка.** Параллельный refresh одного доступа даёт **ровно один** сетевой вызов (single-flight в
процессе), а запись защищена **CAS по `refreshEnc`**: перед записью текущее значение перечитывается, и если
его успел изменить другой писатель, запись не выполняется и используются уже записанные токены (refresh-токен
после использования обычно ротируется провайдером). `invalid_grant` → доступ переводится в `status:'error'`
**через порт**.

**Ошибки клиента** машинно-читаемы (`OAuthError.code`), секретов в тексте нет.

## 8. Host-binding секретных заголовков

`packages/core/src/engine/net/egress-guard.ts`: режим `fetchWithEgressGuard(..., { bindSecretHeaders: true })` —
при редиректе на **другой origin** (сравнение scheme+host+port) заголовки `authorization`,
`proxy-authorization`, `x-api-key`, `cookie` **не пересылаются**; остальные заголовки пересылаются как
раньше. Без редиректов поведение не меняется. Режим **выключен по умолчанию** (поведение существующих
потребителей не затронуто) — включают те, кто несёт токен наружу (OAuth-вызовы; в MCP-транспорте токен
добавляется сам — §9.1).

## 9. Биндинг к MCP (коннектор → доступ)

В схеме конфигурации MCP-сервера (`packages/shared/src/config/types.ts`) есть аддитивное поле:

```ts
auth?: { kind: 'credential'; credentialId: string };
```

- `mcpServerAuthSchema` (`z.literal('credential')` + непустой `credentialId`); поле опционально — записи
  без `auth` (все существующие) валидны.
- Коннектор ссылается на доступ **по id**; сам токен в реестре/конфиге не лежит.

### 9.1 Подстановка токена в транспорт (Ф3)

`packages/core/src/engine/mcp/credential-auth.ts`:

- **Источник токена** — `McpCredentialSource` (`getAccessToken`/`refreshAccessToken`): узкая абстракция, порт
  и провайдер в транспорт не заглядывают. Реализация поверх порта — `reveal()` (только чтение секрета,
  наружу токен не отдаётся) и refresh через `OAuthCredentialService`.
- **Каждый HTTP-запрос** коннектора с `auth.kind='credential'` несёт заголовок `Authorization: Bearer <token>`;
  значение токена не попадает в конфиг/реестр MCP, не логируется и не фигурирует в текстах ошибок.
- **Refresh по `401`**: ответ `401` один раз обновляет токен (refresh через `OAuthCredentialService`, CAS
  внутри) и запрос повторяется. **Ровно один refresh на запрос**: если и после обновления токена сервер
  отвечает `401`, запрос возвращается как есть.
- Ошибки доступа машинно-читаемы (`McpCredentialError.code`): `not_found`, `revoked`,
  `reauthorization_required` (провайдер отозвал refresh-токен — доступ переведён в `status:'error'`),
  `no_refresh`, `unavailable`.
- `POST /api/v2/mcp/probe` использует тот же источник доступа — коннектор с `auth` проверяется так же,
  как и в бою.

### 9.2 Запрет plaintext-заголовков (Ф3)

`authorization`, `proxy-authorization`, `x-api-key`, `cookie` в `headers` MCP-коннектора **запрещены**:

- запись реестра (`POST/PUT /api/v2/mcp/registry`, `POST/PUT /api/v2/mcp/servers`) → **400**
  `MCP_SECRET_HEADER_FORBIDDEN` (не 500);
- `POST /api/v2/mcp/probe` — тот же код;
- существующие записи реестра с такими заголовками переводятся на новую схему **явной миграцией**
  (`migrateMcpRegistrySecrets`, `storage/mcp-registry-migration.ts`): значение заголовка становится токеном
  доступа (через порт), заголовок удаляется, коннектор получает ссылку
  `auth: { kind: 'credential', credentialId }`; миграция одноразовая и идемпотентная, значение заголовка в
  отчёт не попадает (только имена коннекторов и id созданных доступов);
- сид из `config.yaml` (`seedFromConfig`) такой заголовок в реестр **не переносит** — он отбрасывается с
  предупреждением в лог (только имя заголовка).

### 9.3 Право привязки (Ф3)

Привязка выдаёт коннектору право действовать от имени доступа, поэтому она проверяется **на границе**
(инвариант 16): правило — в core (`engine/oauth/credential-binding.ts`), сбор актора и маппинг решения в
код ответа — в `server/credential-bind-guard.ts`.

| Доступ | Кто может привязать |
|---|---|
| свой (`owner.kind='user'`/`'local'`) | владелец доступа |
| инстансный (`owner.kind='instance'`) | `ADMIN`/`LEAD` |
| уровня проекта (`projectId` задан) | участник проекта с правом **изменения** содержимого (`OWNER`/`EDITOR`, а также `LEAD`/`ADMIN`) |
| остальное | никто (403) |

Доступа нет — **404**; доступ есть, но права нет — **403**. Матрица — `packages/backend/src/routes/mcp-credential-bind.test.ts`.

### 9.4 Каталог OAuth-провайдеров (Ф3)

`oauth.providers` в `config.yaml` (env-оверрайд `SYNTH_OAUTH_PROVIDERS`) — каталог описаний провайдеров
(`authorizeUrl`/`tokenUrl`/`revokeUrl?`/`clientId`/`scopes?`/`clientAuth?`/`redirectUri?`). Описание —
**данные**: кода провайдера в ядре нет. На старте описания регистрируются в
`OAuthProviderRegistry` (`engine/oauth/registry.ts`) — это то, из чего `OAuthCredentialService` строит
клиент для **refresh**. `client_secret` в каталоге нет — только env `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET`
или файл `{dataDir}/secrets/oauth/<provider>.client_secret` (§7).

## 10. Статус реализации (Ф4)

| Этап | Что | Статус |
|---|---|---|
| Ф3 | подстановка токена в MCP-транспорт; запрет plaintext-`Authorization` в `headers` (+ валидация и миграция существующих записей реестра); refresh пересоздаёт транспорт; `probe` использует доступ; каталог `oauth.providers`; право привязки доступа к коннектору | **✅ закрыт (2026-10-23)** |
| Ф4 | HTTP-роуты `createOAuthRoutes` (`POST/GET /api/v2/oauth/credentials`, `POST …/:id/refresh`, `DELETE …/:id`, `POST …/:id/bind`) и монтирование в backend/core; журнал credential-операций (отдельный append-only, `SECURITY_AUDIT_SCOPES` в `shared` **не расширяется**); включение порта в `synth secrets rotate` (preflight, `--dry-run`, счётчики); правила бэкапа и переноса проекта (доступы инстанс-локальны, как binding-key) | **✅ закрыт (2026-10-24)** |

**Остаток Ф4 — только UI «Доступы».** HTTP-контур, журнал операций, ротация мастер-ключа и
правила бэкапа/переноса сделаны; пользовательского интерфейса управления доступами пока нет —
доступ заводится и обновляется через HTTP-контур (`docs/API_V2.md` §5.37) либо кодом (через
порт). Коннекторы привязывают уже заведённые доступы по `credentialId` (см. §9.3).

### 10.1 Ротация мастер-ключа покрывает и вебхуки

`synth secrets rotate` перешифровывает **три** точки at-rest (ADR-076 / ADR-105 / ADR-052):
SSH-ключи агентов, access/refresh-токены внешних доступов и **signing-секреты подписок
исходящих webhooks** (`WebhookStore.rotateMasterKey`). До этого подписки вебхуков после ротации
падали с «Секрет недоступен»: HMAC-подпись доставки требует исходный секрет, а он оставался
зашифрованным прежним мастер-ключом.

Порядок: **preflight всех трёх точек** (запись, которая не расшифровывается ни старым, ни новым
ключом, → отказ **до** первой записи) → перешифровка (счётчики `rotated`/`upgraded`/`skipped`)
→ перезапись `{dataDir}/secrets/master.key` (0600). `--dry-run` считает план и ничего не пишет.

### 10.2 Журнал операций со слоем доступов

Отдельный **append-only** порт `CredentialAuditRepository`
(`storage/ports/credential-audit-repository.ts`) — не расширение `SECURITY_AUDIT_SCOPES`
(`packages/shared/src/types/egress.ts`): security-аудит — про изменения политик, журнал
доступов — про операции с OAuth-кредой. Файловая реализация —
`{dataDir}/audit/credentials.jsonl` (`FileCredentialAuditStore`), in-memory —
`MemoryCredentialAuditRepository`, БД — драйвер `@itphx/synth-storage-postgres` (миграция
`014`). Запись (`issue`/`refresh`/`revoke`/`bind`/`use`) **не содержит** ни значения токена, ни
`secretEnc`/`refreshEnc`, ни `code_verifier`/`client_secret`, ни id пользователей/сессий — только
id доступа, провайдера, операцию, исход и машинный код ошибки. Запись — best-effort: сбой
журналирования не ломает саму операцию. Журнал **не является публичным API** — эндпоинта
чтения нет.

## 11. Ключевые файлы

| Файл | Роль |
|---|---|
| `packages/shared/src/types/external-credentials.ts` | контракты `ExternalCredential`/`ExternalCredentialMeta`, zod-схемы, `maskExternalSecret`, `toExternalCredentialMeta` |
| `packages/shared/src/config/types.ts` | `mcpServerAuthSchema` и поле `auth` в `mcpServerConfigSchema` |
| `packages/core/src/storage/ports/external-credential-repository.ts` | доменный порт |
| `packages/core/src/storage/external-credential-store.ts` | файловая реализация (`{dataDir}/secrets/oauth/credentials.json`) |
| `packages/core/src/storage/mcp-registry-migration.ts` | миграция существующих записей реестра: plaintext-заголовок → внешний доступ (одноразовая, идемпотентная) |
| `packages/core/src/storage/memory/external-credentials.ts` | in-memory реализация |
| `packages/core/src/storage/contract/external-credential-repository.contract.ts` | контрактный suite (паспорт порта) |
| `packages/core/src/storage/storage-context.ts` | подключение `StorageContext.externalCredentials` |
| `packages/core/src/server/routes/oauth.ts` | HTTP-контур слоя доступов (`createOAuthRoutes`) — общий для core и backend |
| `packages/core/src/engine/oauth/pending-flows.ts` | незавершённые выдачи (PKCE/device) — `state`, код верификатора, срок |
| `packages/core/src/engine/oauth/bind-connector.ts` | привязка доступа к MCP-коннектору (запись реестра) |
| `packages/core/src/storage/ports/credential-audit-repository.ts` | порт append-only журнала операций со слоем доступов |
| `packages/core/src/engine/oauth/audit.ts` | единая точка записи в журнал (`recordCredentialAudit`, best-effort) |
| `packages/core/src/storage/file-credential-audit-store.ts` | файловая реализация журнала (`{dataDir}/audit/credentials.jsonl`) |
| `packages/core/src/storage/memory/credential-audit.ts` | in-memory реализация журнала |
| `packages/core/src/storage/contract/credential-audit-repository.contract.ts` | контрактный suite журнала |
| `packages/core/src/engine/oauth/*` | OAuth-клиент и сервис слоя доступов |
| `packages/core/src/engine/oauth/registry.ts` | реестр описаний OAuth-провайдеров (каталог `oauth.providers`) |
| `packages/core/src/engine/mcp/credential-auth.ts` | источник токена для MCP-транспорта (`McpCredentialSource`) и `createCredentialFetch` (подстановка + refresh по 401) |
| `packages/core/src/engine/oauth/credential-binding.ts` | правило права привязки доступа к коннектору (ADR-105 Ф3) |
| `packages/core/src/server/credential-bind-guard.ts` | guard привязки на границе (инвариант 16) |
| `packages/core/src/remote/device-flow.ts` | обобщённый device flow (`postFormDetailed`) |
| `packages/core/src/engine/net/egress-guard.ts` | `bindSecretHeaders` — host-binding секретных заголовков |
| `packages/core/src/security/crypto.ts` | `encryptSecret`/`decryptSecret`, формат `enc:v1:…` |
| `packages/core/src/security/rotate.ts` | `synth secrets rotate` — общий preflight/запись для SSH-ключей, доступов и вебхуков |
| `packages/storage-postgres/src/ports/external-credentials.ts` + `src/migrations/012-external-credentials.ts` | PG-порт доступов и миграция `012` |
| `packages/storage-postgres/src/ports/credential-audit.ts` + `src/migrations/014-credential-audit.ts` | PG-порт журнала доступов и миграция `014` |

## 12. Связи

- [ADR-105](./arch_decisions/adr-105-external-credentials.md) — решение (внешние доступы).
- [ADR-071](./arch_decisions/adr-071-mcp-servers-prompt.md) — реестр MCP, уровни `system`/`project`/`session`,
  сетевая политика: коннектор, к которому привязывается доступ.
- [ADR-076](./arch_decisions/adr-076-git-repo-registry-ssh.md) — образец секрета at-rest (шифрование
  мастер-ключом, ротация).
- [ADR-096](./arch_decisions/adr-096-storage-layer.md) / [ADR-097](./arch_decisions/adr-097-storage-provider-class.md) —
  порты хранилища, БД-драйвер и контрактный suite.
- [ADR-098](./arch_decisions/adr-098-storage-degraded-recovery.md) — деградированный режим (read-only фоллбек).
- [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md) — единый egress-слой (`egressFetch`, TLS/CA, прокси).
- [ADR-052](./arch_decisions/adr-052-public-api-platform.md) — service-key (хешируемый секрет) и вебхуки
  (нехешируемый) — два прецедента модели секретов.
- [ADR-091](./arch_decisions/adr-091-backup-restore-transfer.md) — бэкап/перенос и режим «без секретов».
- [docs/CONFIGURATION.md](./CONFIGURATION.md) — раздел `mcp.servers` (`auth: { kind: 'credential', credentialId }`).
- [docs/API_V2.md](./API_V2.md) — §5.16 (`config.auth` у MCP-сервера), §5.37 (HTTP-контур внешних доступов).
