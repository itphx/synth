# PROP-100: SSRF и TOCTOU/DNS-rebinding — привязка проверенного адреса к соединению

> **Статус:** 🧩 Предложение — соединяться с **тем же** адресом, который прошёл policy-проверку (пиннинг),
> а не перепроверять DNS при коннекте. Дефекты 1–3 (отсутствие DNS-проверки, редиректы webhooks,
> `fetch-icon`) **закрыты 2026-10-17**; прокси реализован (ADR-099 D1+D2, proxied-режим);
> остаток — пиннинг/TOCTOU для direct и `noProxy`-хостов, наблюдаемость.
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-15
> **Класс:** предложение ([ARCH_DECISIONS.md](../ARCH_DECISIONS.md) §1–2): решения по пиннингу нет — есть
> гипотеза; выбор варианта (A/B/C) не сделан, кода пиннинга нет. Уже сделанная часть (единая нормализация
> адреса, расширенный список запрещённых CIDR, единый guard и адресная политика
> [ADR-099](./adr-099-egress-tls-trust.md) п. 8–11) — обычный коммит, отдельного ADR не требует.
> **Связано:** [ADR-099](./adr-099-egress-tls-trust.md) (единый egress-слой: адресная политика, аудит,
> журнал), [ADR-071](./adr-071-mcp-servers-prompt.md) §2.3.1 (сетевой доступ MCP), [ADR-052](./adr-052-public-api-platform.md)
> (webhooks), [ADR-099](./adr-099-egress-tls-trust.md) (прокси-часть egress-слоя), [ADR-041](./adr-041-llm-error-taxonomy.md)
> (ключи ошибок), [ADR-036](./adr-036-llm-gateway.md), [ADR-094](./adr-094-observability-metrics.md)
> (детект ребиндинга как метрика), [AUDIT-CHECKLIST](../security/AUDIT-CHECKLIST.md) §3 п.4 «SSRF / egress».

## Контекст

### Что уже закрыто (предмет документа — не это)

Обход SSRF-политики через IPv4-mapped IPv6 закрыт: введена единая нормализация адреса (`normalizeIp`/`mappedIpv4`,
`packages/core/src/engine/mcp/network-policy.ts`), расширен `DEFAULT_MCP_PRIVATE_CIDRS`
(`packages/shared/src/types/mcp.ts`: `0.0.0.0/8`, `100.64.0.0/10`, `::/128`, `::ffff:0:0/96`, …), все
потребители ходят через один хелпер (`engine/tools/web.ts`, `engine/net/fetch.ts`,
`engine/webhooks/network.ts`, `engine/mcp/manager.ts`, backend `routes/providers.ts`). Запись
`::ffff:127.0.0.1`/`::ffff:169.254.169.254` теперь блокируется.

Редиректы прикрыты: `web_fetch` и `fetchText` идут с `redirect: 'manual'` и проверяют каждый хоп
(`engine/tools/web.ts`, `engine/net/fetch.ts` — через `fetchWithEgressGuard`).

**Соседние дефекты того же класса (1–3) закрыты 2026-10-17** — единым guard'ом
`packages/core/src/engine/net/egress-guard.ts` (`checkEgressUrl`/`fetchWithEgressGuard`,
`redirect: 'manual'`, проверка каждого хопа):

| # | Дефект (был) | Где закрыт | Подтверждение |
|---|---|---|---|
| 1 | Нет DNS-проверки: `isBlockedHost` проверял только IP-литералы и шаблоны `localhost`/`*.local`/`*.internal`, поэтому `evil.example → 127.0.0.1` **проходил** | `engine/net/fetch.ts` — `validateRemoteUrl` резолвит все A/AAAA через `checkEgressUrl` (потребители — remote-скиллы, URL-источники инструкций) | `packages/core/src/engine/net/fetch.ts:44–52` |
| 2 | Webhooks следовали редиректам (`redirect` не задан → `follow`), per-hop проверки не было | `engine/webhooks/service.ts` — доставка через `fetchWithEgressGuard` (`redirect: 'manual'`, `maxHops`), проверка на каждую попытку | `packages/core/src/engine/webhooks/service.ts:244–300` |
| 3 | `fetch-icon`: политика применялась к `origin`, а запросы шли по `origin + /favicon.ico` и по `resolved` — абсолютному URL из HTML, без policy-проверки | `packages/backend/src/routes/providers.ts` — `origin`, favicon, HTML и `resolved` идут через `checkEgressUrl`/`fetchWithEgressGuard` | `packages/backend/src/routes/providers.ts:53,63,80,98`; тест `packages/backend/src/routes/providers.test.ts:259` |

Уточнение: **MCP-SDK управляем** — `StreamableHTTPClientTransportOptions`
(`@modelcontextprotocol/sdk@1.29.0`; проверено повторно на `1.32.1`) принимает `fetch?: FetchLike`
(«Custom fetch implementation used for all network requests»), значит MCP-транспорт покрывается тем же
пиннинг-хелпером, что и остальное (в исходной оценке он считался неохватываемым).

### Остаток: TOCTOU / DNS-rebinding

**Угроза.** Проверка адреса и установка соединения — это **два независимых DNS-резолва**:

1. policy-проверка: `checkEgressUrl` → `evaluateMcpNetworkAccess(...)` →
   `dns.lookup(host, { all: true })` (`engine/mcp/network-policy.ts`) → адреса → сверка с CIDR;
2. собственно запрос: `fetchWithEgressGuard` → транспорт `egressFetch` → рантайм (undici внутри Node)
   резолвит **тот же hostname заново** и коннектится к ответу второго резолва.

Если между (1) и (2) DNS отдаёт другой ответ (TTL≈0, round-robin flip-flop, атакующий авторитативный
сервер, чередующий публичный и приватный адрес), соединение уйдёт на адрес, который policy не проверяла.
Это классический **check-then-use (TOCTOU) / DNS-rebinding**.

**Почему перепроверка редиректов это не закрывает.** Каждый хоп редиректа повторяет ту же пару
«проверка → запрос»: окно существует **на каждом хопе, включая последний**. Повторная проверка сужает
множество достижимых имён (нельзя уйти по редиректу на приватный адрес, если он разрешился в приватный),
но не устраняет разрыв между проверкой и коннектом. Формально: инвариант «адрес соединения ∈ множество
проверенных адресов» не выполняется ни на одном шаге.

**Что важно для честной оценки.** Multi-A-ответ (публичный + приватный адрес в одном ответе) политикой
уже отклоняется: в режиме `deny` достаточно одного запрещённого адреса среди resolved. Остаток — именно
**разные ответы в разные моменты**, а не «несколько записей в одном ответе». Наиболее чувствителен режим
`allow` (белый список): под него можно «провалиться» проверкой и подключиться в другое место.

## Детали

### Точки «проверили → подключились»

| Точка | Проверка | Соединение |
|---|---|---|
| `web_fetch` | `engine/tools/web.ts` — `fetchWithEgressGuard` (per-hop) | `fetchWithEgressGuard` → `egressFetch` (`engine/net/egress-guard.ts`) |
| webhooks (доставка) | `engine/webhooks/network.ts` (pre-check) + `fetchWithEgressGuard` на каждую попытку (`engine/webhooks/service.ts:244–300`) | то же; по умолчанию `egressFetch`, ретраи — с повторной проверкой |
| MCP HTTP/SSE | `engine/mcp/manager.ts` (при подключении), backend-роут реестра (`routes/mcp-registry.ts`, при записи) | `StreamableHTTPClientTransport` (SDK) со своим `fetch`; адресная проверка — **до** коннекта |
| Backend `providers/fetch-icon` | `packages/backend/src/routes/providers.ts:53` (`origin`) + guard на favicon/HTML/`resolved` | `fetchWithEgressGuard` |
| Remote-скиллы | `validateRemoteUrl` (`engine/net/fetch.ts:44–52`) — DNS-проверка | `fetchText` → `fetchWithEgressGuard` |
| URL-источники инструкций | там же | `fetchText` → `fetchWithEgressGuard` |

## Варианты

### A. `node:http`/`node:https` + собственный `lookup` (без новых зависимостей)

Заменить `global fetch` в защищённых путях на запрос через `node:https`/`node:http` с кастомным `lookup` (или `createConnection` к уже проверенному IP при `servername`/`Host` = исходный hostname, чтобы TLS валидировался по имени, а не по IP).

- **Плюсы:** новых зависимостей нет; полный контроль над моментом резолва — проверка и коннект неразделимы **по построению**; доступен дешёвый дополнительный слой: после `connect` сверить `socket.remoteAddress` с политикой и оборвать запрос до отправки тела (закрывает и «слепой» коннект); единый транспорт-хелпер можно передать и в MCP-SDK (`fetch`-опция).
- **Минусы:** нужно заново собрать то, что даёт `fetch` бесплатно — декомпрессия (`gzip`/`deflate`/`br` — `node:http` её не делает), charset/декодирование, таймауты и `AbortSignal`, лимиты байт, поведение при редиректах, keep-alive/пул; в `web_fetch`/`fetchText` заменить `FetchLike`-seam на новый интерфейс (правки тестов); адаптер к web-`Response` для MCP-SDK.
- **Объём:** ядро сети + 4 подсистемы (`web.ts`, `net/fetch.ts`, `webhooks/service.ts`, `mcp/client.ts`) + backend `providers.ts`. Риск регрессий средний-высокий (стриминг, таймауты, декомпрессия, аборт).

### B. `undici` `Agent({ connect: { lookup } })` + `fetch(url, { dispatcher })` (новая зависимость)

Тот же принцип «проверка внутри резолвера», но без переписывания транспорта: `lookup`-хук агента сам резолвит, нормализует, сверяет с политикой и **возвращает только проверенные адреса**; undici коннектится ровно по ним.

- **Плюсы:** мало кода, поведение `fetch` (декомпрессия, `AbortSignal`, `redirect: 'manual'`, лимиты) сохраняется; единый хелпер `egressFetch(url, init)` без труда передаётся в MCP-SDK (`fetch`) и в webhooks (`fetchImpl`); предсказуемо тестируется (инъекция `lookup`). Прямая зависимость `undici@^7` уже введена ([ADR-099](./adr-099-egress-tls-trust.md) §3), так что часть риска снята.
- **Минусы:** нужно подтвердить совместимость внешнего `Dispatcher` с глобальным `fetch` Node 22 (разные версии undici внутри Node и в пакете — известный источник поломок) — это спайк до решения; меньше контроля «после коннекта» (проверка `socket.remoteAddress` неудобна); при смене мажорной версии undici — риск тихой несовместимости.
- **Объём:** новый модуль-хелпер + правки точек подключения + тесты. Риск регрессий низкий, риск зависимости — средний (supply-chain, ратчет зависимостей в аудите).

### C. Оставить как есть (компенсирующие меры)

Остаточный риск: окно — миллисекунды между двумя резолвами; атакующему нужен контроль DNS для запрашиваемого имени. Для `web_fetch` это реалистично: URL приходит от модели, а модель управляема содержимым (prompt injection с чужой страницы) — подконтрольный домен с flip-flop DNS даёт SSRF. Эффект: чтение внутренних HTTP-сервисов и — в облачных/управляемых развёртываниях — метаданных (`169.254.169.254`), причём тело ответа возвращается в сессию, то есть уходит провайдеру модели (эксфильтрация). Для локального standalone без metadata-service заметно ограниченнее, но локальные сервисы всё равно достижимы.

Что можно сделать без кода (компенсации, а не замена фиксу): сетевая изоляция процесса (K8s `NetworkPolicy`/egress-allowlist — для многих развёртываний сильнее и дешевле пиннинга); адресная политика `egress.tools`/`egress.webhooks`/`mcp.networkPolicy` в `deny`-режиме ([ADR-099](./adr-099-egress-tls-trust.md)) и журнал `audit/egress.jsonl` для детекта; не возвращать в модель тело ответа при подозрении. Вердикт: как «окончательно» вариант C принимается только для standalone-сценария с сетевой изоляцией; при `web_fetch` в managed/облаке остаточный риск признаётся неприемлемым — именно поэтому предложение заводится со сроком.

## Предложение

1. **Пиннинг резолвом-в-резолвере.** Соединяться только с адресом, прошедшим policy-проверку **в том же вызове**: `lookup(host, opts, cb)` → resolve → `normalizeIp` → CIDR-сверка → вернуть только допущенные адреса (иначе — ошибка резолва). Проверка и коннект сливаются в одну операцию, окно исчезает по построению.
2. **Первый шаг — B со спайком.** Спайк подтверждает совместимость `undici`-`Dispatcher` с глобальным `fetch` на Node 22 (заявленный `engines`: `node >= 22.0.0`). Спайк успешен → B (мало кода, покрывает и MCP через `fetch`-опцию SDK). Спайк провалился → A (без новых зависимостей), либо B2 — работа через `undici.request` напрямую, а не через глобальный `fetch`.
3. **Единая точка.** Один модуль-хелпер (~`engine/net/pinned-fetch.ts`) — все защищённые пути ходят только через него (принцип «новых каналов не плодить»); MCP-SDK получает его через `fetch`-опцию.
4. **Сопутствующее — выполнено 2026-10-17:** DNS-проверка в `validateRemoteUrl` (дефект 1), `redirect: 'manual'` + per-hop для webhooks (дефект 2), policy-проверка `origin`/`resolved` в `fetch-icon` (дефект 3) — единым guard'ом `engine/net/egress-guard.ts`.
5. **Политика и конфиг не меняются по умолчанию:** пиннинг — безопасное поведение без флага (обратной совместимости не ломает). Флаг (если понадобится) — в `egress.*` (см. открытые вопросы).
6. **Наблюдаемость:** фиксировать в логе случай, когда резолв по тому же имени дал другой ответ, чем предыдущий (детектор попытки ребиндинга); в перспективе — счётчик в [ADR-094](./adr-094-observability-metrics.md); базовый след уже есть в журнале `audit/egress.jsonl` ([ADR-099](./adr-099-egress-tls-trust.md) п. 14).

## Влияние на подсистемы

| Подсистема | Что меняется | Риск |
|---|---|---|
| `web_fetch` (`engine/tools/web.ts`) | `fetchWithEgressGuard` переходит на пиннинг-транспорт; `FetchLike`-seam → интерфейс транспорта | декомпрессия/таймаут/аборт, 5 URL за раз |
| `fetchText` (`engine/net/fetch.ts`) | то же (DNS-проверка уже есть — дефект 1 закрыт) | имена, резолвящиеся в приватные адреса, уже отклоняются (ожидаемое поведение) |
| Webhooks (`engine/webhooks/service.ts`) | пиннинг + проверка перед каждой попыткой ретрая (`redirect: 'manual'` уже есть) | смена поведения при редиректах (по ТЗ — отклонять, а не следовать) |
| MCP-транспорт (`engine/mcp/client.ts`) | `fetch`-опция `StreamableHTTPClientTransport` → пиннинг-хелпер. Сейчас опция несёт `egressFetch` (доверие TLS/CA + прокси), адресная проверка выполняется **до** коннекта (`manager.ts`) и остаётся непривязанной к соединению; при прокси — proxied-режим (hostname-правила, без DNS/CIDR); `stdio`-серверы вне зоны контроля | HTTP/SSE-режимы MCP, `requestInit.headers` (ADR-090) не должны пострадать |
| Backend `providers/fetch-icon` (`packages/backend/src/routes/providers.ts`) | пиннинг для `origin`/favicon/HTML/`resolved` (проверка уже есть — дефект 3) | admin-роут, rate limit 10/мин |
| Провайдеры LLM / OIDC / hybrid-клиент | вне объёма: URL задаёт администратор, домен доверенный | — |
| Политика/конфиг | состав CIDR и режимы не меняются; возможный флаг — в `egress.*` (`egress.tools.pinDns`), не `network.*` | прокси реализован ([ADR-099](./adr-099-egress-tls-trust.md) п. 15/18): при egress через прокси адрес резолвит прокси, адресная проверка отключается (`proxied`); для direct и `noProxy`-хостов пиннинг остаётся актуальным |
| i18n | новый ключ ошибки «адрес запрещён/изменился при подключении» ([ADR-041](./adr-041-llm-error-taxonomy.md)) | — |
| Permission-слой | не затрагивается (транспорт, не тул — [ADR-029](./adr-029-granular-permissions.md)) | — |

## Критерии готовности и способ проверки

1. **Структурный тест-страж:** для защищённых путей DNS-резолв происходит **только** внутри policy-хука — spy на `dns.lookup` фиксирует, что второй резолв (вне проверки) не выполняется.
2. **Тест с подменой DNS (flip-flop).** Инъекция `lookup`/`resolveHost`, возвращающего по очереди `93.184.216.34` (разрешён) и `127.0.0.1` (запрещён): ожидание — соединение идёт на **проверенный** адрес, ни одного коннекта на запрещённый (spy на `net.connect` + локальный сервер-ловушка на `127.0.0.1`, который не должен получить запрос). Тест детерминированный, реальный DNS не нужен.
3. **Policy-deny внутри резолвера:** адрес из `DEFAULT_MCP_PRIVATE_CIDRS` → отказ соединения без HTTP-запроса (для `web_fetch` — ошибка политики, для webhooks — `status:'failed'` с причиной).
4. **TLS-инвариант:** сертификат валидируется по **hostname** (`servername`/`checkServerIdentity`), а не по IP — тест: подключение к IP с самоподписанным сертификатом на другое имя должно падать; на совпадающее имя — проходить.
5. **Регрессии (функциональный паритет):** `gzip`/`deflate`/`br`, charset, `AbortSignal`/таймаут, цепочка редиректов, лимит байт, 5 URL за раз, webhook retry/backoff/дедуп/подпись, MCP connect/`tools/call` (HTTP и SSE), `web_search`.
6. **Существующие SSRF-тесты зелёные:** `network-policy.test.ts`, `webhooks/network.test.ts`, `skills/remote.test.ts`, `engine/net/egress-guard.test.ts`, `backend/src/routes/providers.test.ts` + тесты `web_fetch`.
7. **Аудит:** строка негативной матрицы по §3 п.4 [AUDIT-CHECKLIST](../security/AUDIT-CHECKLIST.md) с форматом «команда → вывод» и запись в `docs/security/releases/<version>.json`; прогон `pnpm typecheck && pnpm lint && pnpm test`, для доков — `node scripts/adr-check.mjs`.
8. **Интеграционный прогон в dev:** `web_fetch` по публичному URL (ожидаемо — успех) и по URL, резолвящемуся в приватный адрес (ожидаемо — отказ политики).

## Этапы

1. **Спайк B** (совместимость `Dispatcher` ↔ глобальный `fetch` на Node 22) + решение A/B. ~0,5 дня. — **остаётся**.
2. Пиннинг-хелпер + `web_fetch` и `fetchText` + тесты flip-flop. ~1–2 дня. — **частично**: DNS-проверка
   (дефект 1) ✅ 2026-10-17; пиннинг — остаётся.
3. Webhooks и MCP-транспорт через `fetch`-опцию. ~1 день. — **частично**: `redirect: 'manual'` + per-hop
   для webhooks (дефект 2) ✅ 2026-10-17; пиннинг и передача хелпера в MCP — остаётся.
4. Backend `fetch-icon` (дефект 3) + запись аудита и негативная матрица. ~0,5 дня. — **частично**: guard на
   `origin`/favicon/HTML/`resolved` ✅ 2026-10-17 (`providers.test.ts:259`); пиннинг — остаётся.

## Открытые вопросы

1. **MCP-SDK** — вопрос закрыт по факту (`fetch`-опция есть в 1.29.0), но остаётся: покрывать и SSE-переподключения тем же хелпером (`stdio` — вне зоны контроля)? Что делать при мажорном обновлении SDK, если опция исчезнет?
2. **B: совместимость** внешнего `undici`-`Dispatcher` с глобальным `fetch` Node 22 — версия пакета, пиннинг версии, риск расхождения с bundled undici. Если несовместимо — A или B2 (`undici.request`)?
3. **A: объём** — писать декомпрессию/charset/таймауты руками или взять минимальную зависимость? Где граница «минимального фикса»?
4. **Round-robin с health-check:** пиннинг к одному адресу теряет failover. Достаточно ли возвращать **все** проверенные адреса (Happy Eyeballs по списку) и когда это ломает легитимные сайты?
5. **Прокси:** правило **зафиксировано и реализовано** — [ADR-099](./adr-099-egress-tls-trust.md) п. 15/18
   (адрес резолвит прокси → DNS/CIDR не проверяются, hostname-правила и `exceptions` остаются,
   ответственность — на прокси/allowlist); `POST /settings/egress/check` отдаёт `proxied`/
   `addressChecksActive`, журнал — `via`. Остаток пиннинга актуален для запросов **direct** и хостов из
   `proxy.noProxy` (там проверка полная, DNS/CIDR per-hop). Открыто: как это показывать в UI политики и как
   сочетать с политиками гибрида ([ADR-099](./adr-099-egress-tls-trust.md)).
6. **Флаг пиннинга** — нужен ли вообще, или пиннинг безусловен? Если нужен — где: `egress.tools.pinDns`
   (общий формат `egress.*`), а не `network.*`? Кто и как диагностирует «сайт перестал открываться»?
7. **Детект и лимиты:** считать ли flip-flop инцидентом (лог/событие/алерт) и не блокировать ли имя при повторных попытках?
8. **Наблюдаемость:** достаточно ли журнала `audit/egress.jsonl` ([ADR-099](./adr-099-egress-tls-trust.md)
   п. 14 — `status`/`reason`/`matchedRule`) для разбора, или нужна отдельная метрика/алерт в
   [ADR-094](./adr-094-observability-metrics.md) (счётчик flip-flop)?

## Связи

- [ADR-099](./adr-099-egress-tls-trust.md) — единый egress-слой: адресная политика (`egress.*`/`mcp.networkPolicy`), аудит изменений, журнал запросов, правило при прокси.
- [ADR-071](./adr-071-mcp-servers-prompt.md) §2.3.1 — дом сетевой политики MCP и её применение к HTTP-транспортам.
- [ADR-052](./adr-052-public-api-platform.md) этап II — webhooks, политика egress цели доставки (`egress.webhooks`).
- [ADR-099](./adr-099-egress-tls-trust.md) — прокси реализован (D1+D2); доменная аутентификация (NTLM/Negotiate/Kerberos) — вне scope приложения (egress-шлюз, п. 25); в proxied-режиме адресную проверку выполняет прокси.
- [ADR-041](./adr-041-llm-error-taxonomy.md) — ключи ошибок отказа политики.
- [ADR-094](./adr-094-observability-metrics.md) — детект ребиндинга как метрика/алерт.
- [AUDIT-CHECKLIST](../security/AUDIT-CHECKLIST.md) §3 п.4 «SSRF / egress», [docs/security/README.md](../security/README.md) — класс уязвимостей и запись аудита.

## История

- 2026-10-15 — документ создан: зафиксирован остаток SSRF (TOCTOU/DNS-rebinding) после закрытия обхода через IPv4-mapped IPv6; варианты A/B/C, критерии проверки и открытые вопросы.
- 2026-10-17 — соседние дефекты 1–3 перенесены в «Что уже закрыто» (единый guard `engine/net/egress-guard.ts`:
  DNS в `validateRemoteUrl`, per-hop для webhooks, guard на `origin`/`resolved` в `fetch-icon`); этапы 2–4
  отмечены частично выполненными; вопрос о `mcp.networkPolicy` снят (остаётся отдельным ключом, формат общий
  с `egress.*`), правило при прокси — по ADR-099 п. 15; добавлен вопрос о наблюдаемости.
- 2026-10-17 — прокси реализован (ADR-099 D1+D2): правило при прокси зафиксировано и работает
  (`proxied`/`addressChecksActive`, `via`); остаток пиннинга сужен до direct/`noProxy`-хостов.
