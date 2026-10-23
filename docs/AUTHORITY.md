# Authority-слой (полномочия как контент) — устройство подсистемы

> **Спецификация** — «как устроено сейчас»: модель, резолвер, принуждение в permission-слое, подтверждения,
> журнал решений, метрика и явная граница «реализовано / план».
> Решение — [ADR-106](./arch_decisions/adr-106-authority-layer.md) «Authority-слой — полномочия пользователей
> и агентов как контент». Правила ведения документов — [ARCH_DECISIONS.md](./ARCH_DECISIONS.md).
> **Состояние:** Ф0–Ф5 (контракты, резолвер, принуждение, подтверждения, многопользовательские
> сессии, контент и дистрибуция) — **реализованы**; остаток — flavor-роли (PROP-082), перечислены в §11
> и нигде не выдаются за работающие.

## 1. Назначение

**Authority-слой** — доменно-нейтральная модель полномочий, где право выражается не «какой инструмент
разрешён», а **грантом «действие × цель»**. Слой — надстройка над permission-слоем (ADR-029): он считает
решение по той же паре «действие × цель» и может его **применять**, но только **сужая** решение
permission-слоя.

Ключевые свойства:

- **нет гранта — нет права**: `allow` не выводится из отсутствия запрета, неизвестное действие или цель —
  `deny` (fail-closed);
- **цель — типизированный ресурс**, а не текст команды, промпт или имя тула;
- **права только сужаются**: пересечение осей, а не объединение; ни одна ось не добавляет право;
- **принципал фиксируется при приёме ввода** — автор хода не меняется оттого, что ход исполнился позже;
- **подтверждение одноразовое и адресное**: его принимает носитель покрывающего гранта, а не «кто-то из
  читателей сессии»;
- **доменные роли/действия/цели — контент**, а не код ядра; ядро знает только форму записи.

## 2. Модель

Контракты — `packages/shared/src/types/authority.ts` (zod, **строгие** схемы `.strict()`; неизвестное поле —
ошибка разбора, а не «проскочивший» passthrough).

| Сущность | Смысл | Ключевые поля |
|---|---|---|
| `Principal` | от чьего имени исполняется ход | `kind: 'user'\|'agent'\|'service'\|'scheduler'\|'event'`, `id`, `roles[]` |
| `Action` | доменный глагол | `id` (`read`/`write`/`execute`/`commit`/`publish`/`approve`/`sign`/`delegate`), `mutating`, `requires[]` |
| `Target` | типизированный ресурс | `kind` (`project`/`path`/`session`/`mcp`/`external`/`workspace`/`outside`), `ref`, `scope?` |
| `Grant` | разрешение «действие × цель» | `action`, `targetPattern` (`<вид>:<шаблон>`), `effect: 'allow'\|'ask'\|'deny'`, `constraints?` (`once`, `ttlMs`, `maxCount`, `requireConfirm`) |
| `Role` | именованный набор грантов | `id`, `displayName?`, `domain`, `grants[]` |
| `Ceiling` | верхняя граница активных прав | `grants[]`, `source: 'user'\|'session'\|'pack'\|'instance'` |
| `Turn` | единица исполнения | `id`, `sessionId`, `principal`, `agentId?`, `ceiling[]`, `startedAt` |
| `Approval` | запрос подтверждения | `id`, `turnId`, `principal`, `action`, `target`, `digest`, `once`, `expiresAt?` |

Тонкости:

- **идентификатор принципала** — `<вид>:<идентификатор>` (`user:local`, `agent:assistant`, `service:<keyId>`,
  `scheduler`, `event:<source>`); вид и id — данные, не код ядра;
- **пустой потолок запрещает всё** (ось применима, грантов нет → «нет гранта — нет права»); **отсутствие**
  потолка означает, что ось не применима;
- **вид цели — идентификатор строки**, а не закрытое перечисление: доменные виды (`record:*`, `invoice:*`)
  объявляются контентом; ядро знает только базовый набор (§2.1);
- **шаблон цели** — `<вид>:<шаблон>` (`path:src/**`, `mcp:git/*`); вид обязан совпасть, ссылка сравнивается
  glob'ом (`*` — сегмент, `**` — путь); несовпадение вида → не совпадает ничего (fail-closed).

### 2.1 Виды целей ядра и отображение тулов

`AUTHORITY_CORE_TARGET_KINDS` (`packages/shared/src/types/authority.ts`): `project`, `path`, `session`, `mcp`,
`external`, `workspace`, `outside` (путь **вне** рабочего каталога — отдельный вид цели, к нему относятся
правило `external_directory` и его fail-closed дефолт).

Отображение оси тулов на ось действий — `packages/core/src/engine/authority/actions.ts`: явная карта по имени
встроенного тула, иначе — по capability (`ToolCapability` → действие). Отображения нет — действие
**неизвестно**, и решение — `deny('unknown')` (угадывать нельзя).

Вывод цели из вызова тула — `packages/core/src/engine/authority/target.ts`:

| Вид | Ссылка | Правила |
|---|---|---|
| `path` | относительный путь внутри workspace | абсолютный путь в журнал/метрики не попадает |
| `outside` | неразличимый токен (хэш абсолютного пути) | сопоставление с шаблоном — по `altRefs` (абсолютный путь) |
| `workspace` | рабочая область (shell/git) | |
| `session` | id сессии (план, todo, профиль, делегирование) | |
| `external` | `host + path` | query-строка и userinfo URL не попадают в цель (там бывают секреты) |
| `mcp` | `<server>/<tool>` | |

## 3. Резолвер

`AuthorityResolver` — `packages/core/src/engine/authority/resolve.ts`. Единственное место, где право
вычисляется по модели «действие × цель».

### 3.1 Оси и пересечение

`effective(turn)` возвращает применимые оси; итог — конъюнкция прав:

| Ось | Источник грантов | Когда применима |
|---|---|---|
| `user` | права принципала + роли из политики | всегда (нет грантов — нет права) |
| `agent` | роли/гранты агента хода + роли агента из `policy.agents` (контент пакета, §10) | агент объявлен и у него есть гранты |
| `session` | потолок сессии | потолок задан |
| `pack` | потолок пакета (контента) | потолок задан |
| `instance` | политика инстанса | политика или её потолки заданы |

Оси **только сужают**: ни одна не может добавить право, которого нет выше.

### 3.2 Правила решения

`decide(turn, action, target, altRefs?)` — порядок:

| Условие | Решение | Причина |
|---|---|---|
| действие или вид цели неизвестны инстансу | `deny` | `unknown` |
| совпал явный `deny`-грант | `deny` | `explicit` |
| ни одна ось не дала разрешающего гранта | `deny` | `no_grant` |
| совпал `ask`-грант или `allow` c `requireConfirm` | `ask` | — |
| иначе | `allow` | — |

### 3.3 Подтверждение

`approve(approval, principal, { turn?, altRefs? })` — привязка к ходу, одноразовость и носитель гранта:

| Проверка | Причина отказа |
|---|---|
| подтверждение относится к текущему ходу | `turn_mismatch` |
| подтверждение уже использовано | `already_consumed` |
| срок истёк | `expired` |
| отпечаток не совпал | `digest_mismatch` |
| у отвечающего нет покрывающего гранта | `no_grant` |

Отпечаток — `computeAuthorityApprovalDigest({ turnId, action, target })` (sha256 от канонического
представления). Секретов в нём нет: это необратимый хэш.

**Компиляция правил** (`packages/core/src/engine/authority/compile.ts`): правила permission-слоя (по имени
тула → групповое → `*` → дефолт `allow`) читаются как гранты «действие × цель» — мост миграции, а не
источник истины. Матчинг группы `shell` по **тексту команды** сохраняется, но грант — `execute` ×
`workspace` (текст команды целью не является). В режиме `yolo` правила сессии не поднимают `ask`; требование
подтверждения от **потолка** сессии при этом сохраняется (потолок строит guard, а не компиляция).

## 4. Конфигурация и режимы

```yaml
authority:
  enabled: false   # мастер-выключатель слоя
  shadow: true     # наблюдение: решение считается и пишется, но не применяется
```

- Секция — `authorityConfigSchema` (`packages/shared/src/config/types.ts`), дефолты — `config/defaults.ts`;
  env-оверрайды — `SYNTH_AUTHORITY_ENABLED` / `SYNTH_AUTHORITY_SHADOW` (правило `SYNTH_<SECTION>_<KEY>`).
  Runtime-настроек (UI) у секции нет.
- `enabled: false` — слой выключен: ни решений, ни записей; поведение прав прежнее.
- `enabled: true` + `shadow: true` — **наблюдение**: решение считается и пишется в журнал, но **не
  применяется** (права не меняются). Это режим миграции: расхождение shadow-решения с текущим — дефект
  миграции, а не повод «подкрутить» политику.
- `enabled: true` + `shadow: false` — **enforced**: решение применяется (сужая решение permission-слоя),
  а реестр подтверждений включается (см. §6).

## 5. Принудение в permission-слое

Точка принуждения — `PermissionEvaluator` (`packages/core/src/engine/permission/evaluator.ts`), а не тулы и не
обработчики. Слой подключается двумя швами: `authorityGate` (решение) и `authorityShadow` (наблюдение);
если задан `authorityGate`, шов наблюдения не используется (журнал ведёт сам guard).

Правила применения (enforced-режим):

1. `deny` слоя → `deny` (`matchedRule: 'authority.deny'`) — запрет сильнее всего;
2. `ask` слоя → `ask` (`matchedRule: 'authority.ask'`) — это требование **потолка/политики**, и `yolo` его
   **не снимает** (ось ≠ «пользователь»);
3. `allow` слоя → действует решение permission-слоя: слой **ничего не разрешает** сверх него (жёсткие слои —
   защищённые пути, shell-policy, зависимости окружения — в резолвер не попадают);
4. **тул без маппинга** в «действие × цель» → `deny('unknown')`, а не «пропустить»;
5. **ошибка слоя не ломает ход**: решение permission-слоя остаётся в силе (слой не может «разрешить»).

Потолок сессии строит guard (`packages/core/src/engine/authority/guard.ts`): режим `plan` (или strict без
утверждённого плана) — **только чтение**; обычный режим — «разрешено всё, кроме подтверждённого выхода за
рабочий каталог» (fail-closed дефолт `external_directory` → `ask`, который `yolo` не снимает).

## 6. Подтверждения

### 6.1 Реестр

`ApprovalRegistry` (`packages/core/src/engine/permission/approval.ts`) — **единственное** место, где решается,
можно ли принять ответ на запрос подтверждения. Привязка — `ApprovalBinding`:

```ts
{ principal, turnId, action, target, digest }
```

Методы: `open(approvalId, binding)` (регистрация запроса), `close(approvalId)` (снятие — ответ получен или
таймаут), `get(approvalId)`, `claim(approvalId, sessionId, responder, { turnId?, digest? })`.

`ApprovalClaimResult.reason` — `ApprovalClaimReason`: `ok`, `unknown_approval`, `already_consumed`,
`turn_mismatch`, `digest_mismatch`, `no_grant`.

Инварианты: **одноразовость** (принятое подтверждение списывается), **привязка к ходу** (чужой
`turn_id`/`digest` — отказ), **носитель покрывающего гранта** (ответ без гранта — отказ). Клиенту доверять
нельзя: привязка всегда берётся из серверного реестра, присланные `turn_id`/`digest` — только сверка.

### 6.2 Покрытие

`packages/core/src/engine/authority/approval.ts`: `createApprovalCoverageResolver` + `buildApprovalResponderProfile`
+ `approvalGrantsForProfile`. Источники полномочий — **серверные**:

| Носитель | Покрытие |
|---|---|
| владелец сессии | все действия на всех видах целей |
| `owner`/`editor` проекта | все действия (может подтвердить то, что способен выполнить) |
| `ADMIN`/`LEAD` | все действия (сквозной доступ) |
| `viewer` проекта, `AUDITOR` | **только чтение** (право чтения не расширяет права на изменение) |
| роли политики инстанса | их доменные гранты |

Резолвер покрытия не задан — **fail-closed**: ни одно подтверждение не принимается.

### 6.3 WS-путь

Ответ на `permission_reply` принимается **только носителем покрывающего гранта**, а не «тем, кто видит
сессию». Проверка — в обоих WS-входах: `packages/core/src/server/app/ws-events.ts` (standalone) и
`packages/backend/src/app/listen.ts` (managed). При отказе клиент получает кадр
`{ type: 'error', data: { code: 'APPROVAL_DENIED' } }`, а в `permission.replied` — `approved: false`,
`action: 'deny'` и `reason` из §6.1.

Событие `permission.asked` несёт аддитивные поля `principal`, `turn_id`, `digest` (Ф0) — старые
потребители продолжают читать прежний набор. Реестр живёт **только** в enforced-режиме; в
shadow/выключенном режиме ответ принимается по-старому (по видимости сессии). Контракт — [API_V2.md](./API_V2.md)
§3.1.

## 7. Журнал решений

- **Порт** `AuthorityDecisionJournal` (ADR-096): `append` / `list` (фильтры `action`/`effect`/`source`,
  `limit` — последние N) / `clear`. Файловая реализация — `{dataDir}/audit/authority.jsonl` (append-only
  JSONL, запись под `AsyncLock`); in-memory — для герметичных тестов.
- **Политика инстанса** — порт `AuthorityPolicyRepository`: `getPolicy` / `savePolicy`; файл
  `{dataDir}/authority/policy.json`.
- **Запись журнала** (`AuthorityDecisionEntry`): `id`, `ts`, `principal` (`<вид>:<id>`), `action`, `target`
  (`<вид>:<ссылка>`), `effect`, `source` (ось, давшая решение), `reason`, `mode` (`shadow`/`enforced`),
  в shadow-режиме — `permissionEffect` (текущее решение permission-слоя; нужно для разбора расхождений
  миграции).
- **Без секретов и без сырых путей**: цель строится относительно workspace, `outside:` — неразличимый токен
  (ADR-094, инвариант 25). Отдельный порт, а не расширение `SECURITY_AUDIT_SCOPES`: security-аудит — про
  изменения политик, журнал решений — про решения о правах.

## 8. Метрика

`synth_authority_decisions_total{action,effect,source}` — коллектор
`packages/core/src/metrics/collectors/authority.ts`. Значения лейблов приводятся к **конечным наборам**
(неизвестное → `other`); id принципалов, сессий и ходов в лейблах нет (ADR-094). Ошибка метрик не влияет на
ход. Каталог — [OBSERVABILITY.md](./OBSERVABILITY.md).

## 9. Порты хранилища и реализации

| Порт | Файл | Файловое | In-memory | PostgreSQL |
|---|---|---|---|---|
| `AuthorityPolicyRepository` | `packages/core/src/storage/ports/authority-policy-repository.ts` | `storage/file-authority-policy-store.ts` | `storage/memory/authority-policy.ts` | `packages/storage-postgres/src/ports/authority.ts` (миграция `014`) |
| `AuthorityDecisionJournal` | `packages/core/src/storage/ports/authority-decision-journal.ts` | `storage/file-authority-decision-journal.ts` | `storage/memory/authority-decision-journal.ts` | `packages/storage-postgres/src/ports/authority.ts` (миграция `014`) |

Подключение — `StorageContext.authorityPolicy` / `StorageContext.authorityDecisions`
(`packages/core/src/storage/storage-context.ts`); guard и реестр собираются в
`packages/core/src/server/app/deps.ts` (standalone) и `packages/backend/src/app/deps.ts` (managed).

Оба порта покрыты контрактным suite («паспорт порта», ADR-096):
`packages/core/src/storage/contract/authority-policy-repository.contract.ts` — прогоняется в
`storage/contract/{file,memory}.test.ts`. **Драйвер PostgreSQL** (`buildAuthorityPorts`, таблицы
`authority_policy`/`authority_decisions`, миграция `014`) прогоняется на **живой** БД в
`storage/contract/postgres.test.ts` — этот прогон гейтится env `SYNTH_TEST_POSTGRES_DSN`
(задача `test-postgres` в CI), локально без него порты Authority в PG не проверяются (§11).

## 10. Контент `provides.authority`

Доменные роли, действия, цели и агенты поставляются **контентом**: `provides.authority` в манифесте
`synth.pack` (`packages/shared/src/types/pack.ts`, `packAuthorityProvidesSchema` — строгая схема) в виде
`{ roles[], actions[], targets[], agents[] }`. Кросс-ссылки проверяет `validateAuthorityContent`
(`packages/shared/src/types/authority.ts`): неизвестное действие, неизвестный вид цели или неизвестная роль —
**проблема манифеста** → отказ установки (правило 15 `validatePackManifest`).

Контент — **декларация**: он объявляет, но **не выдаёт права сам себе**. В инстанс попадает **только
после одобрения ADMIN** и **пересекается** с политикой инстанса.

### 10.1 Одобрение по существу — `pending_approval`

Пакет с непустым `provides.authority` — наравне с пакетом, выдающим capability-гранты, объявляющим
пайплайны или расписания, — идёт **на одобрение ADMIN**: `POST /api/v2/packs` → **202**
`{installed: false, requiresApproval: true, …}`, фактическая установка **не** выполняется. Администратор
видит **что** пакет приносит, а не только факт «есть гранты»: ответы `GET /packs`,
`GET /packs/:name`, `POST /packs` (202) и `POST /packs/:name/approve` несут сводку `authority`
(`PackAuthoritySummary`, `packages/shared/src/types/pack.ts`):

| Поле | Смысл |
|---|---|
| `roles[]` | id, `displayName`, `domain`, `grants` (число), `mutatingGrants` (число мутирующих) |
| `actions[]` | id, `mutating` (информационный признак) |
| `targets[]` | вид цели (`kind`), `resolver` |
| `agents[]` | id агента, `roles[]`, `ceiling[]` |
| `totals` | `roles`/`actions`/`targets`/`agents`/`grants`/`mutatingGrants` |

### 10.2 Активация в политике инстанса — при `approve`

Активация — `activatePackAuthority` (`packages/core/src/engine/authority/activation.ts`, **чистые
функции**; запись в порт делает вызывающий — `server/routes/packs.ts`). Политика инстанса — порт
`AuthorityPolicyRepository` (`{dataDir}/authority/policy.json`; PostgreSQL — `authority_policy`).

Правила активации:

1. **Пересечение, а не дарование.** Эффективные гранты роли = гранты пакета ∩ гранты, разрешённые
   политикой инстанца. Явный запрет инстанца (`deny`) — сильнее; область, которую инстанс не
   разрешает, — не разрешается и пакетом. Если у инстанса потолок не задан (ось инстанса не
   применима) — ограничений нет, гранты пакета сохраняются.
2. **Trust-floor** (PROP-068 §4.1): мутирующие гранты активируются **только при доверии ≥ `trusted`**;
   пакет уровня `community` **объявляет** роли, но **не получает** их мутирующую часть (только
   чтение). Мутирующим считается **всё, кроме `read`** (fail-closed: признак `mutating` в манифесте
   пакета **не доверяют** — иначе пакет объявил бы своё мутирующее действие «безобидным» и обошёл бы
   trust-floor).
3. **Политика — источник истины**: роль, уже объявленная в политике инстанца, контентом пакета **не
   перезаписывается** (`role_exists`).
4. **Валидация, а не каст**: неизвестное действие/цель/роль — отказ на разборе манифеста
   (`validateAuthorityContent`), до активации дело не доходит.
5. **Ось `agent`**: контент `provides.authority.agents[]` связывает агента с ролями и потолком;
   активация пишет связь в `policy.agents[]`, а ось `agent` резолвера берёт роли агента **из политики
   инстанса** (они уже прошли пересечение и trust-floor). Привязка к неактивированной роли
   пропускается (`unknown_role`).

Ответ `POST /packs/:name/approve` несёт `authorityActivation` — что активировано и что нет:

```json
{ "activated": { "actions": [], "roles": [], "targets": [], "agents": [] },
  "skipped": [ { "kind": "grant", "id": "write", "reason": "trust_floor", "detail": "…" } ] }
```

Причины пропуска (машиночитаемые): `trust_floor`, `instance_deny`, `instance_not_allowed`,
`role_exists`, `unknown_role`.

### 10.3 Снятие пакета

`DELETE /api/v2/packs/:name` убирает из политики **роли и привязки агентов**, принесённые пакетом
(`deactivatePackAuthority`): **идемпотентно** (снятие отсутствующего пакета/роли — пустая операция);
роли и агенты, которые приносит **другой** установленный пакет, остаются. Объявления действий и видов
целей остаются: они не дают прав, а их удаление сломало бы ссылки из других пакетов (и уже
активированных ролей).

### 10.4 Ограничение: политика — снимок при старте

Политика читается **снимком при старте процесса** (`getPolicy()` при сборке guard'а —
`server/app/deps.ts` / `backend/app/deps.ts`). Изменение после старта не применяется к уже
собранному резолверу: **активация становится видна после рестарта** (инвариант 24).

## 11. Что не реализовано (остаток) и известные ограничения

| Что | Статус |
|---|---|
| UI-раздел «Полномочия» — read-only: роли и гранты из `provides.authority` пакетов, привязки агентов, статус режима. **Реализован**; ограничение: сама политика инстанса и фактический режим слоя в API не отдаются — раздел показывает конфиг и честную пометку | ✅ |
| Flavor-роли — доменные роли в flavor-образах (`synth-backend:<v>-<flavor>`, PROP-082) | **план** |

Ограничения as-built (не остаток функционала, а свойства текущей реализации):

- **Политика читается снимком при старте процесса.** Резолвер собирается на старте
  (`server/app/deps.ts` / `backend/app/deps.ts`) из политики, прочитанной в тот момент; изменение
  политики после старта (в т.ч. активация контента пакета) не применяется к уже собранному
  резолверу — **эффект виден после рестарта** (инвариант 24).
- **PG-контракт портов Authority прогоняется только в CI.** Драйвер PostgreSQL
  (`packages/storage-postgres/src/ports/authority.ts`, миграция `014`) проверяется контрактным suite
  на **живой** БД (`storage/contract/postgres.test.ts`), прогон гейтится env
  `SYNTH_TEST_POSTGRES_DSN` — локальный `pnpm test` без этой переменной порты Authority в PG не
  проверяет (файловое и in-memory хранилища проверяются всегда).

## 12. Ключевые файлы

| Файл | Роль |
|---|---|
| `packages/shared/src/types/authority.ts` | модель (`Principal`/`Action`/`Target`/`Grant`/`Role`/`Ceiling`/`Turn`/`Approval`), строгие схемы, `validateAuthorityContent` |
| `packages/shared/src/types/pack.ts` | `provides.authority` в манифесте пакета, правило 15 `validatePackManifest` |
| `packages/shared/src/config/types.ts`, `config/defaults.ts` | секция `authority` (`enabled`/`shadow`) и дефолты |
| `packages/core/src/engine/authority/actions.ts` | отображение тулов на действия и виды целей |
| `packages/core/src/engine/authority/target.ts` | вывод цели из вызова тула (относительные пути, без секретов) |
| `packages/core/src/engine/authority/compile.ts` | компиляция правил permission-слоя в гранты «действие × цель» |
| `packages/core/src/engine/authority/resolve.ts` | резолвер: `effective`/`decide`/`approve`, отпечаток привязки |
| `packages/core/src/engine/authority/guard.ts` | guard: решение, журнал, потолок сессии, режимы shadow/enforced |
| `packages/core/src/engine/authority/hook.ts` | шов `authorityGate`/`authorityShadow` (типы, без побочных эффектов) |
| `packages/core/src/engine/authority/approval.ts` | покрытие подтверждения: профиль носителя и гранты |
| `packages/core/src/engine/authority/activation.ts` | активация/снятие контента `provides.authority` в политику инстанса (ADR-106 Ф5) |
| `packages/core/src/engine/permission/approval.ts` | `ApprovalRegistry`, `ApprovalBinding`, `ApprovalClaimReason` |
| `packages/core/src/engine/permission/evaluator.ts` | принуждение: `_applyAuthority`, `_yoloLift`, швы решения/наблюдения |
| `packages/core/src/storage/ports/authority-*.ts` | порты политики и журнала решений (ADR-096) |
| `packages/core/src/storage/file-authority-*.ts`, `storage/memory/authority-*.ts` | файловые и in-memory реализации |
| `packages/storage-postgres/src/ports/authority.ts` | порты Authority в PostgreSQL (`authority_policy`/`authority_decisions`, миграция `014`) |
| `packages/core/src/metrics/collectors/authority.ts` | `synth_authority_decisions_total{action,effect,source}` |
| `packages/core/src/server/app/deps.ts`, `packages/backend/src/app/deps.ts` | сборка guard'а и реестра подтверждений |
| `packages/core/src/server/app/ws-events.ts`, `packages/backend/src/app/listen.ts` | WS-приём `permission_reply` с проверкой покрытия |
| `packages/core/src/engine/authority/*.test.ts`, `packages/core/src/engine/permission/approval-registry.test.ts`, `packages/backend/src/app/approval-ws.test.ts` | тесты: резолвер, guard, покрытие, одноразовость, WS-контракт |

## 13. Связи

- [ADR-106](./arch_decisions/adr-106-authority-layer.md) — решение (Authority-слой).
- [ADR-025](./arch_decisions/adr-025-plan-act-toggle.md) — режимы как потолок; [ADR-028](./arch_decisions/adr-028-plan-build-strictness.md) — где уместен `ask`.
- [ADR-029](./arch_decisions/adr-029-granular-permissions.md) — существующая ось allow/deny/ask, остаётся.
- [ADR-089](./arch_decisions/adr-089-external-events-automation.md) — владелец, идентичности, роли внешнего отправителя (прецедент «сужение, не повышение»).
- [ADR-052](./arch_decisions/adr-052-public-api-platform.md) — service-key и scopes (точечный гейт, не ось Authority-слоя).
- [ADR-094](./arch_decisions/adr-094-observability-metrics.md) — контракт метрик и запрет id в лейблах.
- [ADR-096](./arch_decisions/adr-096-storage-layer.md) — порты слоя хранения.
- [ADR-100](./arch_decisions/adr-100-extension-packs-pipelines.md) / [PROP-068](./arch_decisions/prop-068-skills-agents-registry.md) / [PROP-082](./arch_decisions/prop-082-full-images-deployment.md) — доставка контента, каталог и flavor-образы (Ф5).
- [ADR-104](./arch_decisions/adr-104-mid-turn-steering.md) — смена ввода посреди хода (принципал, Ф4).
- [docs/API_V2.md](./API_V2.md) — §3.1 (подтверждения по WS), §5.5 (`PATCH /sessions/:id`, режим).
- [docs/OBSERVABILITY.md](./OBSERVABILITY.md) — каталог метрик.
- Секция `authority` в `docs/CONFIGURATION.md` пока **не описана** — канон раздела — §4 этого документа.
