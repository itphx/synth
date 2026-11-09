# PROP-064: Браузер под управлением агента — серверный headless и пользовательский headed

> **Статус:** 🧩 Предложение — серверный headless-браузер уже есть; пользовательский headed-браузер на машине пользователя (local/hybrid)
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D19, «Встроенные в UI браузер и терминал»; идея пользователя 2026-09-16). 2026-11-09 — терминал выделен в [PROP-132](./prop-132-ui-terminal.md), документ сужен до браузера.
> **Связано:** [ADR-019](./adr-019-react-spa.md), [ADR-024](./adr-024-eventhub-transport.md), [ADR-029](./adr-029-granular-permissions.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-042](./adr-042-hybrid-mode.md), [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md), [ADR-045](./adr-045-hybrid-server-profiles.md), [ADR-075](./adr-075-project-workspace-provisioning.md), [ADR-077](./adr-077-runtime-toolchain.md), [ADR-099](./adr-099-egress-tls-trust.md), [ADR-115](./adr-115-multimodal-input.md), [ADR-116](./adr-116-instance-state-and-blob-ports.md), [PROP-132](./prop-132-ui-terminal.md)
> **Обновлено:** 2026-11-09 — зафиксировано разделение на два браузера, режимная матрица, headed-окно и постоянный профиль, attach по открытому окну.

## Решение (предложение)

Два разных браузера, а не один:

1. **Серверный headless** — Playwright MCP внутри исполнителя (ADR-077). Без человека и общего экрана, доступен на сервере и в managed, уже работает. Остаётся отдельным путём и в этом предложении не меняется.
2. **Пользовательский headed** — Chromium на машине пользователя, видимое окно, постоянный профиль, управление агентом по CDP. Только `local` и `hybrid`. В `managed`, на standalone-сервере и для `remote:`-сессий — **недоступен** (fail-closed, без тихого фоллбека в headless).

Гейт — не название режима, а **место исполнения сессии**: тулы доступны, только если локальный browser host существует для этой сессии и окно открыто.

## Решения владельца

| № | Вопрос | Решение |
|---|---|---|
| 1 | Два браузера или один | Серверный headless (Playwright MCP) остаётся; пользовательский — отдельный путь |
| 2 | Где работает пользовательский браузер | Только `local` и `hybrid`, на машине пользователя; в managed и на standalone-сервере — нет |
| 3 | Форма | Видимое окно Chromium (headed), не headless и не iframe/webview |
| 4 | Профиль | Отдельный постоянный профиль под `{dataDir}` |
| 5 | Зависимость для запуска | Не решено: `playwright-core` либо чистый CDP |

## Контекст

### Что уже есть

- `web_fetch`/`web_search` (`packages/core/src/engine/tools/web.ts`) — read-only HTTP без JS, cookies и сессии; SPA определяется, но не исполняется.
- **Серверный браузер уже работает через MCP.** Образ исполнителя flavor `browser`/`full` (`docker/install-tier-3.sh`, `docker/Dockerfile.executor:265–325`), дефолт `SYNTH_EXECUTOR_MCP_SERVERS` с `playwright-mcp --headless --no-sandbox --executable-path /opt/synth/browser/chrome`; по проверке в контейнере — 25 инструментов, `browser_navigate`/`browser_evaluate` работают (`docs/arch_decisions/adr-077-runtime-toolchain.md:145–162`). Скриншоты приходят MCP-вложениями (ADR-115, протокол исполнителя 5).
- Ограничения серверного пути: нужен flavor `browser`/`full`; при `replicaCount > 1` обязателен `sessionAffinity: ClientIP` (иначе `navigate` и `evaluate` попадают в разные поды); `NetworkPolicy` по умолчанию разрешает только DNS, для интернета нужен `executor.networkPolicy.allowedEgress`; Chrome в образе нет — только Chromium, поэтому обязателен `--executable-path`.
- Встроенных browser-тулов в core нет; UI-панели браузера нет; Code Mode нет (`task` — единственная оркестрация).

### Что изменилось в документе

Изначально PROP-064 описывал «встроенные браузер и терминал» одной идеей (D19). 2026-11-09 терминал вынесен в [PROP-132](./prop-132-ui-terminal.md); здесь остаётся только браузер.

## Режимная матрица

| Режим / сессия | Где исполняются тулы | Серверный headless (MCP) | Пользовательский headed |
|---|---|---|---|
| `local` (`synth serve` на машине пользователя) | локально | да, если настроен executor/MCP | **да** |
| `local` + remote executor | shell/файлы на исполнителе | да | **да** (хост на машине пользователя, не в исполнителе) |
| `hybrid`, локальная сессия | локальный core | да (локальный/удалённый MCP, ADR-125) | **да** |
| `hybrid`, `remote:`-сессия | сервер | да | **нет** |
| standalone-сервер (общий) | сервер | да | **нет** |
| `managed` (multi-user) | сервер/executor | да | **нет** |

Условия доступности пользовательского браузера: локальный core запущен в графической сессии пользователя (есть дисплей), окно открыто, профиль не занят. Иначе — `unavailable` с причиной (`dependency`/`mode`), тулы не появляются в промпте. Мобильный/PWA-клиент получает только статус и снимки: окно находится на десктопе.

## Архитектура

- **Порт `BrowserHost`** в core; реализация — опциональный in-tree пакет `@itphx/synth-browser` (по образцу `storage-postgres`/`executor`: peer-dep core, динамический `import()`, fail-closed). В managed пакет не подключается.
- **Запуск**: headed Chromium (системный Chrome/Chromium/Edge) с `--user-data-dir={dataDir}/browser/profile` и `--remote-debugging-port=0`; управление по CDP. Альтернатива — `playwright-core` для запуска и контекстов.
- **Окно = attach.** Пока окно открыто, `browser_*` доступны и права `browser` выданы; закрытие (человеком или агентом) отзывает права, незавершённые вызовы падают `browser.disconnected` без автоповтора. Открытие окна — согласие пользователя.
- **Вкладки**: один Chromium и один профиль; изоляция сессий — по вкладкам и явному `tabID`, не по профилю. Одна активная сессия-владелец окна, остальные ждут или получают отказ. Рефы истекают на навигации и на новом snapshot.
- **Контракт тулов (MVP)**: `browser_navigate`, `browser_snapshot` (AX-дерево, рефы `@eN`), `browser_click`, `browser_fill`, `browser_screenshot`, `browser_tabs_*`, `browser_close`. Далее: `find`, `select`, `check`, `press`, `scroll`, `wait`, `console`, `network` (read-only), `preview`.
- **Панель UI — вторична**: статус, список вкладок, «показать окно», «закрыть», последний снимок. Живой screencast не нужен — окно видно само.
- **Файлы**: upload из workspace (containment), download и скриншот — в blob через `AttachmentService`, модель получает ссылку (ADR-115/116).
- **`preview`**: открыть артефакт в окне или вкладке; `file://` — только внутри разрешённых корней.

## Права и безопасность

- Новый `ToolCapability.BROWSER` и группа `PERMISSION_GROUPS.browser`; plan-режим: чтение разрешено, мутации (`navigate`/`click`/`fill`) — нет.
- Первый attach/навигация — `ask`; далее по общим правилам ADR-029.
- URL-политика: только `http/https`, без credentials; `file://` — только через `preview` и в пределах workspace.
- Страница, консоль, сеть — untrusted; модель не следует инструкциям со страницы.
- HITL на необратимые действия (отправить, оплатить, удалить).
- Проверка устаревшей цели: `generation` и отпечаток цели перед исполнением одобренного `ask`.
- Локальный браузер ходит сетью пользователя и **не проходит** egress-слой ADR-099 — осознанное исключение; опционально `--proxy-server` из конфига прокси.
- Профиль — отдельный, не профиль пользователя; `{dataDir}/browser/profile` (0700), блокировка вторым инстансом; скриншоты могут содержать секреты — не отправлять без необходимости.

## Открытые вопросы

- Зависимость: `playwright-core` (запуск и контексты) либо чистый CDP (ноль зависимостей, больше кода).
- Обнаружение Chrome/Chromium/Edge по платформам и минимальные версии.
- Владение окном при нескольких сессиях: очередь, lock или отдельные окна на сессию.
- TTL профиля и UX очистки сайта/профиля.
- Политика по хостам (allow/ask) и классы HITL.
- Поведение при закрытии окна посреди задачи и при перехвате управления человеком.
- Нужен ли `preview` в UI Synth или только в окне браузера.

## Статус в коде

- **Серверный headless — есть.** Playwright MCP в исполнителе (см. «Что уже есть»); встроенных тулов в core нет, всё через MCP.
- **Пользовательский headed — нет.** Нет порта `BrowserHost`, пакета, capability `browser`, группы прав и UI-панели.
- **Code Mode — нет**, это отдельное предложение и к браузеру не привязано.

## Связи

- [ADR-019](./adr-019-react-spa.md) — SPA-архитектура UI.
- [ADR-024](./adr-024-eventhub-transport.md) — единый транспорт событий, без новых каналов.
- [ADR-029](./adr-029-granular-permissions.md) — permissions и режимы.
- [ADR-036](./adr-036-llm-gateway.md) — LLM только через gateway, guard/обфускация.
- [ADR-042](./adr-042-hybrid-mode.md), [ADR-045](./adr-045-hybrid-server-profiles.md) — гибрид и профили.
- [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md) — мобильный адаптив и PWA.
- [ADR-075](./adr-075-project-workspace-provisioning.md) — workspace и containment.
- [ADR-077](./adr-077-runtime-toolchain.md) — исполнитель и серверный Playwright MCP.
- [ADR-099](./adr-099-egress-tls-trust.md) — egress, TLS/CA, прокси.
- [ADR-115](./adr-115-multimodal-input.md), [ADR-116](./adr-116-instance-state-and-blob-ports.md) — вложения и blob-порты.
- [PROP-132](./prop-132-ui-terminal.md) — встроенный терминал (выделен из этого документа).

## История

- 2026-09-16 — документ создан (D19, браузер и терминал).
- 2026-11-09 — терминал вынесен в PROP-132; зафиксировано разделение серверного headless и пользовательского headed, режимная матрица, профиль и attach.
