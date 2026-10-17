# ADR-071: MCP-серверы — уровни, скоуп и представление в промпте

> **Статус:** ✅ Реализовано
> **Дата:** 2026-09-20
> **Реализация:** Ф1 — слои `tools`/`mcp.tools` и per-session выборка (фикс кросс-сессионной утечки); Ф2 — блоки `mcp.servers`/`mcp.status` (`description` + `instructions`); Ф3 — политики `tools.policy`/`mcp.policy` (`consistency`/`available`/`auto`, дефолт `auto` + per-session override); Ф4 — единый PostgreSQL-ready реестр MCP, уровни `system`/`project`/`session`, RBAC, сетевой доступ; Ф5 — таблицы «Встроенные инструменты»/«MCP» и UI управления (сессия/проект/админка).
> **Дополнение (2026-09-20):** §2.6, §2.8, §2.9 — вкладки правой панели, оценка/калибровка токенов инструментов, admin-отключение встроенных инструментов (`tools.disabled`), разделение настроек MCP на пользовательские и админские (Ф6).
> **Дополнение (2026-09-21):** §2.3 — политика разделена на две независимые: `tools.policy` (только встроенные, default `auto`) и `mcp.policy` (только MCP, default `auto`); MCP-блоки (`mcp.servers`/`mcp.tools`/`mcp.status`) — **всегда `volatile`**; порядок `tools → mcp.servers → mcp.tools → mcp.status`.
> **Дополнение (2026-09-30):** §2.2/§2.4/§2.5 — единая per-item модель включения: `McpRegistryEntry.enabled` (мастер hard-gate), `enabledByDefault` = «дефолт для НОВЫХ проектов», `project.enabled` — hard-gate (в т.ч. для системных серверов), дефолты — snapshot (`session.settings.mcpDefaultOn`), причина `system_disabled`; ту же модель переиспользуют скиллы (ADR-046 §4.5).
> **Дополнение (2026-10-17):** §2.3.1 — `mcp.networkPolicy` стал экземпляром общей адресной egress-политики
> ([ADR-099](./adr-099-egress-tls-trust.md) п. 8–11): формат `{mode, list, exceptions}`, live per-request,
> проверка только `origin:'user'` HTTP/SSE, аудит изменений.
> **Парные документы:**
> - [ADR-070](./adr-070-system-prompt-composer.md) «SystemPromptComposer» — тиры `stable`/`context`/`volatile`, манифест промпта, CachePolicy; ADR-071 добавляет слои `mcp.tools`/`mcp.servers` и уточняет правило «tools всегда `stable`»;
> - [ADR-029](./adr-029-granular-permissions.md) «Гранулярные permissions» — `mcpToolSettings` (доступность MCP-тулов по режимам plan/act) сохраняется и учитывается политикой включения;
> - [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — обфускация/деобфускация аргументов MCP-вызовов без изменений;
> - [ADR-014](./adr-014-project-container.md) «Проект как контейнер» и [ADR-040](./adr-040-sessions-without-project.md) «Сессии без проекта» — носители проектного и сессионного скоупа;
> - [PROP-068](./prop-068-skills-agents-registry.md) «Реестр скиллов и агентов» — модель trust/guard/install-policy, переиспользуемая для реестра MCP-серверов;
> - [ADR-005](./adr-005-json-storage.md) «JSON-хранилище» — хранение реестра MCP-серверов через `FileStore` (атомарная запись);
> - [PROP-032](./prop-032-history-storage-postgresql.md) «Миграция хранения на PostgreSQL» — логическая модель реестра проектируется сразу под будущую миграцию.

**Решение:** отделить MCP от встроенных инструментов на всех уровнях (промпт, реестр, UI) и ввести явную модель уровней/скоупа и политику включения инструментов:

1. **Разделить слои инструментов:** встроенные — `tools` (`stable`), MCP — `mcp.tools`/`mcp.servers`/`mcp.status` (**всегда `volatile`**); в запросе встроенные идут первыми, кэш-брейкпоинт ставится после них.
2. **Добавить блок `mcp.servers`** с описаниями серверов (имя, `description`, `instructions` из MCP, тулы, статус, уровень); блок всегда `volatile` (MCP не кэшируется).
3. **Ввести две независимые глобальные админские политики:** `tools.policy` (только встроенные, default `auto`) и `mcp.policy` (только MCP, default `auto`); обе — `consistency` | `available` | `auto`, per-session override разрешён (`toolsPolicy`/`mcpPolicy`).
4. **Три уровня MCP:** `system` (admin, instance), `project` (owner/lead), `session` (пользователь); merge с приоритетом `system > project > session`.
5. **Реестр MCP-серверов:** любой пользователь может добавить HTTP-сервер (с фиксацией автора); `stdio` — только admin на уровне инстанса; включение «по умолчанию для проекта» — только owner/lead.
6. **Безопасность:** `stdio` (RCE) — только admin; пользовательские HTTP-серверы — `community`/unverified, project-wide включение проходит через человека (owner/lead).
7. **UI:** рядом с «Составом промпта» — таблицы «Встроенные инструменты» и «MCP»; управление уровнями в админке/настройках проекта/сессии.

---

## 1. Контекст и проблема

1. **Смешение слоёв.** MCP-тулы регистрируются как обычные (`ToolCapability.MCP`, имя `{server}_{tool}`) и уходят в тот же `tools`-слой, который ADR-070 §2.9 объявляет постоянным (`stable`). Но состав MCP динамичен: сервер может быть недоступен, включён/выключен в сессии, ограничен `mcpToolSettings` по режимам. Это противоречит допущению о консистентности кэшируемого префикса.
2. **Кросс-сессионная утечка.** `McpManager.registerTools` пишет в **глобальный** `ToolRegistry`, `AgentRegistry.getToolsForAgent()` возвращает **весь** реестр (`toLLMFormat()`), а активация серверов — per-session (`session.settings.mcpServers`), при этом diff add/remove ведётся по полю синглтона (`orchestrator._loadedMcpServers`). Включение сервера в одной сессии регистрирует его тулы для всех; выключение в одной снимает у остальных.
3. **Нет серверного уровня в промпте.** Модель видит только тул-описания; отсутствуют имя/описание сервера, `instructions` (MCP initialize), статус подключения, группировка. `mcpServerConfigSchema` не имеет поля `description`, `McpClient` не сохраняет `serverInfo`/`instructions`.
4. **Нет проектного скоупа и политики контекста.** Есть только глобальный конфиг (admin) и `session.settings.mcpServers`. Нет способа отдавать локальным моделям только доступные тулы ради экономии контекстного окна.
5. **Эталон.** Прототип `~/dev/aic/t11` (`context_builder.py:57-123`, `scheduler.py:20-58`) добавляет MCP-тулы текстовым блоком `# Доступные инструменты (MCP Tools)` в system prompt наряду с `tools`-параметром — намеренное дублирование ради моделей, которые плохо используют function calling.

---

## 2. Решения

### 2.1. Разделение слоёв инструментов

- **`tools`** — только встроенные инструменты; состав определяется агентом/ролью и постоянен → тир `stable`.
- **`mcp.tools`** — MCP-инструменты; состав зависит от активных серверов, их доступности и `mcpToolSettings` → тир `volatile`.
- **Порядок в запросе:** встроенные → кэш-брейкпоинт → MCP. Изменение MCP не инвалидирует кэш встроенного префикса (бюджет брейкпоинтов ADR-070 — до 4, сейчас используется 2).
- **Манифест:** отдельные записи `tools`, `mcp.tools`, `mcp.servers` (с `source`/`provenance`), чтобы состав был наблюдаемым и разделяемым в статистике.
- **Реестр тулов:** каждый тул тегируется источником (`built-in` / `mcp:<server>`); выборка тулов для сессии — **per-session** (не глобальная регистрация/дерегистрация). Кросс-сессионная утечка устраняется by design.

### 2.2. Блок `mcp.servers`

Содержимое по каждому активному серверу:

- имя и `description` (поле конфига, заполняется человеком);
- `instructions` — текст, который отдаёт сам MCP-сервер при initialize (если есть);
- список инструментов: имена + краткие описания (полные схемы параметров остаются в `tools`/`mcp.tools`, не дублируются);
- статус: `connected` / `error` / `disabled` / `circuit-open`;
- уровень: `system` / `project` / `session`.

**Показываются все серверы, включая неактивные.** Отключённый сервер присутствует в блоке и в списках с пометкой `disabled` и причиной, а не исчезает из выдачи. Причины (приоритет, §2.4): `system_disabled` (мастер-флаг реестра), `project_disabled` (не разрешён проектом), `session_optout`, `not_default` (нет в снапшоте сессии и не включён явно).

**Тир блока не зависит от политики (§2.3):** `mcp.servers`, `mcp.tools` и `mcp.status` — **всегда `volatile`** и не входят в `staticPrefixChars`. MCP динамичен (серверы включаются/выключаются, статус меняется), поэтому в prompt-cache не участвует. Порядок блоков в запросе/манифесте: встроенные `tools` → `mcp.servers` → `mcp.tools` → `mcp.status` (MCP-регион не идёт выше «Инструментов»).

### 2.3. Политики включения инструментов (`tools.policy` / `mcp.policy`)

Две **независимые** глобальные админские настройки (config.yaml + admin UI), с возможностью per-session override:

- **`tools.policy`** — только **встроенные** инструменты (слой `tools`); per-session override — `session.settings.toolsPolicy`;
- **`mcp.policy`** — только **MCP**-инструменты (слои `mcp.tools`/`mcp.servers`/`mcp.status`); per-session override — `session.settings.mcpPolicy`.

Обе принимают одно из значений:

| Значение | Поведение |
|---|---|
| `consistency` | в запрос идут все определения; недоступность кодируется permission-слоем (`unavailable(mode\|role)`); приоритет — валидность кэша |
| `available` | в запрос идут только доступные агенту/режиму/роли инструменты **своего слоя**; инструкция по инструментам переписывается (без подсказок о недоступных); приоритет — экономия контекстного окна |
| `auto` (**дефолт обеих**) | выбор по модели/провайдеру: локальные (`ollama`) → `available`, облачные → `consistency` |

- **Дефолт — `auto`** для обеих политик (config.yaml и runtime-настройки).
- **Независимость слоёв:** в `available` для встроенных MCP-слой **не** фильтруется, и наоборот. `tools.guide` добавляется, если **любая** из политик `available`; текст учитывает, что ограничение может касаться встроенных и/или MCP.
- **Тир `tools`:** `stable` в `consistency`, `context` в `available` (состав зависит от режима/роли). MCP-блоки всегда `volatile`.
- В `available` режиме `mcpToolSettings` (ADR-029) влияет на **состав** MCP-слоя запроса, а не только на permission-вердикт.
- **Манифест:** `manifest.toolsPolicy` и `manifest.mcpPolicy` несут фактически применённые (уже разрешённые из `auto`) политики; `mcp.servers`/`mcp.tools`/`mcp.status` не входят в `staticPrefixChars`.
- **Runtime API:** `GET/PUT /api/v2/settings/tools-policy` (встроенные) и `GET/PUT /api/v2/settings/mcp-policy` (MCP).
- **Сетевой доступ — отдельно от политик включения:** адресная политика MCP-серверов —
  `mcp.networkPolicy` (§2.3.1), экземпляр общей egress-политики ([ADR-099](./adr-099-egress-tls-trust.md)
  п. 8–11); `tools.policy`/`mcp.policy` отвечают только за **состав** инструментов в промпте.

#### 2.3.1. Сетевой доступ пользовательских MCP (admin-настройка)

**Экземпляр общей egress-политики** ([ADR-099](./adr-099-egress-tls-trust.md), п. 8–11): ключ
`mcp.networkPolicy` (`config.yaml` + admin UI) с тем же форматом, что у `egress.*` —
`{mode: 'deny'|'allow', list: string[], exceptions: string[]}`. `exceptions` — allow-правила, проверяются
первыми: точный hostname, `*.suffix`, IP/CIDR. `deny` — блок, если хотя бы один resolved-адрес попал в
`list`; `allow` — разрешено, только если **все** resolved-адреса в `list` либо сработало исключение.
Дефолт — `deny` приватных/служебных диапазонов (`DEFAULT_MCP_PRIVATE_CIDRS`: `10/8`, `172.16/12`,
`192.168/16`, `127/8`, link-local, CGNAT, metadata-endpoints). Невалидная запись → 400
`VALIDATION_ERROR`. `mode: 'off'` для MCP **не** поддерживается (только у `egress.webhooks`).

Runtime: `GET/PUT/DELETE /api/v2/settings/mcp-network-policy` (путь сохранён) — live per-request:
политика резолвится из стора при каждой операции (runtime → config → встроенный дефолт), без рестарта
и без фонового опроса; в рамках одного подключения — один снимок. Мутации — ADMIN (managed) /
`requireAuth` (core), изменения пишутся в аудит `{dataDir}/audit/security.jsonl`
(`GET /api/v2/audit/security`). Проверка «до коннекта» доступна через
`POST /api/v2/settings/egress/check` `{scope:'mcp', url}`.

**Что именно проверяется (as-built).** Политика применяется только к **пользовательским** HTTP/SSE
серверам (`origin: 'user'`) — при записи в реестр и при подключении (`engine/mcp/manager.ts`); записи
`origin: 'instance'` и `stdio`-серверы **не проверяются** (последние ходят в сеть сами, дочерним
процессом). Per-project политики **нет** — ключ инстанс-уровневый. Пиннинга проверенного адреса нет:
между проверкой и соединением возможен TOCTOU/DNS-rebinding — остаток
[PROP-100](./prop-100-ssrf-dns-rebinding.md).

**При включённом прокси (ADR-099 п. 18).** Для пользовательских HTTP/SSE-серверов применяется
**proxied-семантика**: проверяются схема и hostname-правила/`exceptions` (`deny`/`allow` по имени), а
DNS-резолв и CIDR-сверка **не выполняются** — адрес назначения резолвит прокси. Хосты из `proxy.noProxy`
идут напрямую и проверяются полностью (DNS/CIDR каждого адреса). В `allow`-режиме политика, состоящая
только из CIDR, через прокси непроверяема → отказ (`proxied-allow-unverifiable`). Диагностика
`POST /api/v2/settings/egress/check` `{scope:'mcp'}` отдаёт `proxied`/`addressChecksActive`, фактический
маршрут — поле `via` в журнале egress.

### 2.4. Уровни и скоуп MCP

| Уровень | Кто управляет | Скоуп | Hard-gate (`enabled`) и дефолт |
|---|---|---|---|
| **System** | admin (instance) | все сессии и проекты | мастер-флаг `enabled` реестра (дефолт `true`): `false` → сервер недоступен нигде и никогда (включая старые сессии/проекты); `enabledByDefault` — «включать в новых проектах» (сид) |
| **Project** | owner/lead | все сессии проекта | `project.mcp.enabled[]` — hard-gate (не разрешённый сервер недоступен и в старых сессиях проекта); `project.mcp.defaultOn[]` — сид «по умолчанию для новых сессий» |
| **Session** | пользователь | одна сессия | один тумблер: `mcpServers` (вкл) / `mcpDisabledServers` (opt-out, включая системные); личные/разовые серверы; снапшот дефолта — `settings.mcpDefaultOn` |

- **Merge:** `system ∪ project ∪ session`; при конфликте имён приоритет `system > project > session` (жёстко, без переименования/алиасов).
- **Резолвинг (per-item):** `enabled = systemOn && projectOn && !sessionOff && (snapshotOn || sessionOn)`, где `systemOn` — мастер-флаг (реестровый `enabled`), `projectOn` — имя в `project.mcp.enabled` (гейт не задан, если нет `project.mcp`), `sessionOff` — явный opt-out, `snapshotOn`/`sessionOn` — имя в `settings.mcpDefaultOn`/`mcpServers`. `config.enabled` в резолвинге **не участвует** — это лишь сид записи реестра при первичном создании (`seedFromConfig`). Дефолт — **opt-in (off)**. Причина (приоритет): `system_disabled` → `project_disabled` → `session_optout` → `not_default`. Единый резолвер — `resolveMcpScope` (`engine/mcp/scope.ts`).
- **Live vs snapshot:** мастер-флаг и проектный гейт — **live hard-gate** (действуют и для старых сессий, включая системные серверы); дефолты (`enabledByDefault`, `project.defaultOn`, `mcpDefaultOn`) — **snapshot** (смена дефолта не влияет на созданные проекты/сессии).
- **Проектный гейт — для всех серверов:** `project.mcp.enabled` применяется и к системным (`origin: 'instance'`) записям (раньше системные проект не гейтил).
- **Хранение:** instance-серверы — единый реестр (+ config); проектные — `Project.mcp`; сессионные — `session.settings.mcpServers`/`mcpDisabledServers` (+ снапшот `mcpDefaultOn`).
- **RBAC:** owner/lead могут включать/выключать серверы на уровне проекта и сессии; пользователь — только на уровне сессии (включая opt-out системных).
- **Отключённые не исчезают:** сервер остаётся в списке с пометкой `disabled` и причиной (см. §2.2).

### 2.5. Реестр MCP-серверов

- **HTTP-серверы (`sse`/`http`):** добавить может **любой пользователь**; запись попадает в **реестр MCP-серверов** с фиксацией автора (`author`, `createdAt`) и признаком доверия (`community`/unverified). URL пользовательского HTTP/SSE-сервера проверяется адресной политикой `mcp.networkPolicy` (§2.3.1, общий формат с `egress.*`, [ADR-099](./adr-099-egress-tls-trust.md)) при записи и при подключении; `origin: 'instance'` и `stdio` не проверяются.
- **`stdio`-серверы:** добавляет **только admin** на уровне инстанса (RCE-риск); admin же выставляет `enabledByDefault`.
- **Включение по умолчанию для проекта:** только owner/lead (человеческий гейт для пользовательских серверов).
- **Единый реестр.** Один реестр MCP-серверов (не разделяем на instance/пользовательский); instance- и пользовательские записи различаются полем `origin`. Логическая модель сразу проектируется под будущую миграцию на PostgreSQL (по образцу PROP-032): плоские записи со стабильным `id`, `schemaVersion`, timestamps, без вложенных структур, которые нельзя разложить в таблицы.
- **Схема записи:** `McpRegistryEntry { schemaVersion, id, name, config, origin: 'instance' | 'user', author: { userId, username } | null, trust: 'builtin' | 'community', enabled: boolean, enabledByDefault: boolean, createdAt, updatedAt }`.
  - `enabled` (дефолт `true`) — системный мастер-флаг (hard-gate): `false` → сервер недоступен нигде и никогда (включая старые сессии/проекты).
  - `enabledByDefault` — переосмыслено: «включать по умолчанию в НОВЫХ проектах» (сид `project.mcp.enabled`/`defaultOn` при создании проекта); снимок — на созданные проекты/сессии не влияет. Config `mcp.servers[name].enabled` — только сид системного мастера при первичном создании записи из config (`seedFromConfig`); после создания мастер-флаг живёт в реестре и редактируется там, `config.enabled` в резолвинге не участвует.
  - Проект ссылается на записи (`Project.mcp = { enabled: string[]; defaultOn: string[] }`), сессия — через явные overrides.
- **Разрешение эффективного набора для сессии:** per-item `enabled = systemOn && projectOn && !sessionOff && (snapshotOn || sessionOn)`; `snapshotOn` — `session.settings.mcpDefaultOn` (снимок `project.defaultOn`/системного `enabledByDefault` на момент создания). Динамический `project.defaultOn` в формуле не участвует (дефолты — snapshot, §2.4). Конфликт имён — по приоритету (§2.4).
- **Хранение сейчас:** `FileStore` (JSON + атомарная запись, ADR-005) в `$SYNTH_DATA_DIR`; instance-дефолты (`enabledByDefault`) могут дублироваться в config.yaml. Миграция на PostgreSQL — отдельная задача (ср. PROP-032), модель к ней готова.
- **Провенанс:** кто добавил/включил/выключил и когда — в аудит (ADR-036-совместимо).

### 2.6. UI

**Правая панель — вкладки.** Первый ряд: **«Сессия»**, **«Проект»**, **«Контекст»**, **«Статистика»**. «Контекст» отвечает только за состав и оптимизацию контекста, session-level управление MCP — на вкладке «Сессия», project-level — на «Проекте», метрики и стоимость — на «Статистике».

Рядом с «Составом промпта» (ADR-070) в «Статистике»:
- **«Встроенные инструменты»** — тул, capability, доступность по режиму/роли, `chars`/`estTokens` (см. §2.8);
- **«MCP»** — сервер, уровень, статус, тулы, доступность по режимам, автор, суммарные `chars`/`estTokens` по серверу. Показываются **все** серверы, включая отключённые (пометка `disabled` и причина).
- Обе таблицы **свёрнуты по умолчанию** под блок «Подробнее» / «Скрыть» (не раздувают панель); в шапке — колонка токенов с флагом «оценка / калибровано» (§2.8).

**Вкладка «Контекст».** Отвечает только за состав и оптимизацию контекста (заметки, скользящее окно, суммаризация) — управление MCP здесь не дублируется.

**Вкладка «Сессия».** Переключатели MCP-серверов **вкл/выкл** — session-level управление (эквивалент `PUT /sessions/:id/mcp`), без перехода в настройки; отключённые видны с причиной.

**Настройки MCP разделены на два раздела:**
- **Пользовательские** (настройки/сессия): вкл/выкл серверов в своей сессии, персональные HTTP-серверы, opt-out системных;
- **Отдельная админ-категория** (RBAC `ADMIN`): system MCP и `stdio`, `enabledByDefault`, `tools.policy` + `mcp.policy`, `tools.disabled` (§2.9), сетевой доступ MCP (`mcp.networkPolicy`, §2.3.1), управление единым реестром.

### 2.7. Связь с другими AD

- **ADR-029:** `mcpToolSettings` сохраняется; в `available` влияет на состав запроса.
- **ADR-070:** добавляются `mcp.servers`/`mcp.tools`; правило «tools всегда `stable`» заменяется на «`tools` стабильны, все MCP-блоки (`mcp.servers`/`mcp.tools`/`mcp.status`) — volatile».
- **ADR-014/ADR-040:** проектный и сессионный скоуп.
- **PROP-068:** переиспользование trust/guard/install-policy для реестра MCP.
- **ADR-046/PROP-068 (скиллы):** модель уровней и включения (`system`/`project`/`session`, enable/disable группами и точечно, стабильный каталог vs volatile) переиспользуется для скиллов — ADR-046 §4.5, PROP-068 §8.1.
- **ADR-036:** обфускация MCP-аргументов — без изменений.

---

### 2.8. Оценка токенов инструментов и калибровка

Инструменты — самый ранний слой промпта (`tools → system → messages`, ADR-070), поэтому их вклад в контекст показывается отдельно и точно.

**Единицы наблюдения.**
- по каждому инструменту — `chars` и `estTokens` (встроенные и MCP);
- агрегат по MCP-серверу — сумма тулов сервера (и отдельно блок `mcp.servers`, если он в промпте);
- агрегат по слою — запись `tools` манифеста (ADR-070 §2.5).

`chars` = длина `JSON.stringify` **реально отправляемого** описания тула (`name`/`description`/`parameters`) — та же база, что у записи `tools` манифеста, чтобы статистика не расходилась с запросом.

**Дефолтная оценка.** До калибровки `estTokens = ceil(chars / 4)` (`chars/4`, эвристика как в hermes); значение помечается как **приблизительное** (`estimated: true`, `tokenSource: 'heuristic'`), в UI — «≈».

**Калибровка после первого ответа.** После ответа с фактическим `usage.inputTokens`:
- `ratio = promptChars / usage.inputTokens`, где `promptChars` — суммарная длина символов реально отправленного промпта (system-блоки + `tools` + `messages`; та же база, что у манифеста);
- далее `estTokens = ceil(chars / ratio)`, флаг `estimated: false`, `tokenSource: 'calibrated'`;
- **разумные границы:** ratio зажимается в диапазон `[1.5, 16]` (fallback `4`); выбросы за границами не сохраняются (ошибка провайдера/нестандартный токенайзер). Нижняя граница 1.5 допускает CJK/эффективные BPE (~1–2 символа/токен), верхняя 16 — «эффективные» токенизаторы с запасом (например, `omn.qwen3.8:27b` даёт ratio ≈ 11.7);
- **персистентность per-model:** калиброванный ratio хранится в runtime-настройках (`settings.json`, ADR-005, атомарная запись) в разрезе модели (`provider/model`), переживает рестарт; при смене модели — свой ratio; при отсутствии — fallback `4`; пересчёт по мере новых ответов (сглаживание — деталь реализации);
- **флаг оценки** несёт каждая строка и агрегат: до калибровки — «оценка», после — «калибровано (модель)».

**Где отдаётся.** `toolsDetail` (`GET /sessions/:id/prompt`), `GET /sessions/:id/mcp` (агрегаты по серверам), таблицы статистики (§2.6). Контракт полей — `docs/API_V2.md`.

### 2.9. Отключение встроенных инструментов (admin)

Админская instance-wide настройка `tools.disabled` жёстко исключает встроенные инструменты из запроса **независимо от `tools.policy`** (§2.3).

```yaml
tools:
  policy: "consistency"
  disabled:
    capabilities: [git, web]            # отключить целые группы ToolCapability
    tools: [execute_shell, git_push]    # отключить отдельные тулы
```

- **Семантика:** эффективный набор = доступные агенту/режиму тулы − (все тулы отключённых `capabilities` ∪ явно перечисленные `tools`). Действует и в `consistency`, и в `available`, и в `auto`.
- **Группы и отдельные тулы:** `capabilities` — по `ToolCapability` (`git`, `web`, `file_read`, `file_write`, `shell`, `mcp`, …); `tools` — точечно по имени. Группа и точечное отключение складываются (union).
- **Неотключаемые (`runtime`).** Управление состоянием и маршрутизация не могут быть отключены администратором (иначе ломается инвариант ADR-039): `plan_enter`/`plan_exit`/`plan_read`/`plan_list`/`plan_write`, `todo_write`/`todo_list`/`todo_add`/`todo_update`/`todo_delete`, `get_project_info`/`list_repos`/`project_create`/`project_attach`, `read_session_reference`, `classify_conversation`. Попытка указать их в `tools.disabled` отвергается.
- **Отражение:** отключённые тулы не уходят в запрос и не упоминаются в подсказках/`tools.guide`; в `toolsDetail` и таблицах UI показываются с пометкой `disabled` и причиной `admin` (в отличие от `unavailable(mode|role)` — та причина от режима/роли).
- **Runtime API:** `GET/PUT /api/v2/settings/tools-disabled` → `{ disabled: { capabilities: string[], tools: string[] } }`, RBAC `ADMIN`, live-применение, persist в `settings.json`; `GET` отдаёт эффективный набор и признак override относительно config.yaml.
- **Валидация:** неизвестные capability/имена тулов игнорируются с предупреждением; `runtime`-тулы в списке — ошибка.

---

## 3. Фазы реализации

1. **Разделение и фикс утечки:** тегирование источника тулов, per-session выборка, разделение `tools`/`mcp.tools`, манифест, брейкпоинт после встроенных.
2. **Блок `mcp.servers`:** `description` в конфиге, захват `instructions`/`serverInfo` в `McpClient`, блок и его тир по политике.
3. **Политики `tools.policy`/`mcp.policy`:** `consistency`/`available`/`auto` (дефолт `auto`), независимые слои (встроенные / MCP), per-session override (`toolsPolicy`/`mcpPolicy`), адаптация инструкции по инструментам, admin UI.
4. **Уровни и скоуп:** единый реестр MCP (`McpRegistryEntry`, PostgreSQL-ready), `Project.mcp`, RBAC, `enabledByDefault`, сетевой доступ (§2.3.1), безопасность `stdio`/HTTP, показ отключённых.
5. **UI:** таблицы инструментов/MCP, управление уровнями.
6. **Токены, калибровка и admin-отключение (дополнение, §2.6/§2.8/§2.9):** колонка `chars`/`estTokens` и сворачивание таблиц, калибровка ratio per-model, admin `tools.disabled` (группы + отдельные тулы, runtime API), разделение настроек MCP на пользовательские/админские, таблица MCP с переключателями во вкладке «Сессия», обмен вкладок.

---

## 4. Открытые вопросы

Решённые вопросы внесены в §2:

1. **Реестр** — единый, PostgreSQL-ready (§2.5).
2. **Сетевой доступ пользовательских HTTP-серверов** — `mcp.networkPolicy {mode, list, exceptions}`,
   экземпляр общей egress-политики ([ADR-099](./adr-099-egress-tls-trust.md)), live per-request (§2.3.1).
3. **Approval-флоу** при project-включении — не вводим; гейт — роль owner/lead (§2.5).
4. **Неактивные серверы** — показываем с пометкой (§2.2, §2.4).
5. **Конфликт имён** — приоритет `system > project > session` (§2.4).
6. **Отключение встроенных инструментов (admin)** — `tools.disabled { capabilities, tools }`, `runtime` неотключаем (§2.9).
7. **Оценка токенов** — `chars/4` с калибровкой per-model по фактическому `usage.inputTokens` (§2.8).
8. **Раскладка UI** — верхний ряд: «Сессия», «Проект», «Контекст», «Статистика»; таблицы сворачиваются, MCP-тумблеры — во вкладке «Сессия» (§2.6).

Остаётся уточнить на этапе реализации:

- миграция существующих `session.settings.mcpServers` в новую модель (backfill `origin`/`enabledByDefault`, маппинг на реестр);
- границы калибровочного ratio и место персистентности (per-model или per provider/model), способ сглаживания — §2.8;
- канонический список неотключаемых `runtime`-тулов и их группировка — §2.9.

## 5. Что НЕ делаем

- Не даём обычным пользователям добавлять `stdio`-серверы.
- Не вводим отдельный approval-флоу для project-включения (достаточно роли owner/lead).
- Не разделяем реестр на instance/пользовательский — один реестр с полем `origin`.
- Не дублируем полные JSON-схемы параметров в текстовом блоке (они в `tools`/`mcp.tools`).
- Не отказываемся от `unavailable(mode|role)` в режиме `consistency` — он остаётся основным механизмом подсказок.

## Последствия

- **Плюс:** корректный prompt-cache для встроенных инструментов, отсутствие кросс-сессионной утечки, управляемая экономия контекста для локальных моделей, прозрачность состава, безопасное управление MCP по уровням.
- **Минус/риски:** усложнение модели (уровни × политика × тиры), необходимость UI для админки/проекта/сессии, миграция существующих `session.settings.mcpServers` в новую модель, риск SSRF для пользовательских HTTP-серверов.
