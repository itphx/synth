# ADR-099: Единый egress-слой — доверие TLS/CA (mTLS), адресная политика и прокси

> **Статус:** ⚠️ Частично — реализовано: **(1) доверие TLS/CA** — секция `security.tls`
> (`caFile`/`caPem`/`certFile`/`keyFile`/`rejectUnauthorized`), единый транспорт
> (`buildTlsTrust`/`applyGlobalTlsTrust`/`egressFetch`, глобальный undici-dispatcher), перевод всех
> исходящих точек (провайдеры, MCP, webhooks, гибрид, инструкции/скиллы, `web_fetch`/`web_search`,
> update-checker, OIDC+JWKS, иконки провайдеров), git-CA (`http.sslCAInfo`), PostgreSQL
> `storage.postgres.sslmode` + запрет TLS-параметров в DSN; **(2) адресная политика** — `egress.tools`/
> `egress.webhooks` (`mode`/`list`/`exceptions`, `off` только у webhooks), `mcp.networkPolicy` в том же
> формате, live per-request, аудит изменений политики (`audit/security.jsonl`) и журнал внешних запросов
> (`audit/egress.jsonl`), удаление `webhooks.allowPrivateTargets`; **(3) HTTP/HTTPS/SOCKS5-прокси** —
> секция `proxy` (URL-поля, `noProxy`, Basic-аутентификация, TLS/mTLS к https-прокси), `EgressDispatcher`
> с per-origin маршрутом direct/proxy, fail-closed `EGRESS_PROXY_UNAVAILABLE`, proxied-режим адресной
> политики, `via` в журнале, git через child-env, прокси-env для `stdio`-MCP, API статуса/редактирования
> и проверки коннекта, админ-секция UI; **runtime-настройка прокси из админ-UI** — оверрайд в
> `RuntimeSettings.proxy` (`settings.json`/PG, `settings migrate`), сохранение без live-применения,
> `restartRequired`, write-only пароль (файл/env), аудит `scope:'proxy'`; **(4) TLS runtime/UI** —
> bootstrap `{dataDir}/security-tls.json` (читается до PG), CA-бандл, `rejectUnauthorized`, default
> mTLS-клиент и per-host `mappings` (exact/`*.suffix`/`*`, первое совпадение), тот же профиль для PG,
> API `settings/tls*`, раздел «Сеть» (Прокси + Доверенные CA), read-only параметры config/env, аудит
> `scope:'tls'`, применение при старте (`restartRequired`); **(5) профили и host-правила прокси** —
> `proxy.mode`/`proxy.profiles`/`proxy.rules` (first match, `noProxy` важнее, CIDR по IP-литералу),
> per-profile `auth`/`tls`, пароли профилей (`SYNTH_PROXY_<NAME>_PASSWORD` / `secrets/proxy/<name>.password`),
> TLS-материалы профилей (`secrets/proxy/<name>/`), API `/settings/proxy/profiles/:name/*`,
> `POST /settings/proxy/test` (target-check с маршрутом), UI «профили/правила/проверка цели», legacy-
> совместимость (п. 27). **Вне scope (2026-10-18):** доменная
> аутентификация прокси (NTLM/Negotiate/Kerberos) **не реализуется в приложении** — делегируется
> промежуточному egress-прокси/шлюзу (Squid/px, п. 25); SOCKS5 — **best-effort** (п. 26). **Остаток:**
> runtime-reload прокси/TLS без рестарта, CA к цели через SOCKS5, per-host CA и несколько
> default-клиентских сертов, пиннинг проверенного
> адреса ([PROP-100](./prop-100-ssrf-dns-rebinding.md)), метрики/наблюдаемость
> ([PROP-094](./prop-094-observability-metrics.md)), перепроверка покрытия встроенного `fetch` на Node 22.
> Политика — **не граница безопасности**, когда доступны shell, `stdio`-MCP или внешние движки (см.
> «Последствия»).
> **Дата:** 2026-10-16 (адресная политика — 2026-10-17; прокси D1+D2 — 2026-10-17; runtime-UI — 2026-10-18;
> профили и host-правила — 2026-10-18)
> **Обновлено:** 2026-10-17 — адресная egress-политика как часть того же слоя: `egress.tools`/
> `egress.webhooks`, `mcp.networkPolicy` с `exceptions`, live per-request, аудит изменений и журнал
> внешних запросов, удаление `webhooks.allowPrivateTargets`.
> **Обновлено:** 2026-10-17 — HTTP/HTTPS/SOCKS5-прокси (этапы D1+D2): секция `proxy`, `EgressDispatcher`,
> Basic и mTLS к прокси, `noProxy`, proxied-режим адресной политики, `via` в журнале, git/MCP через env,
> API `settings/proxy*`, UI; NTLM/Negotiate/Kerberos тогда отнесены к остатку (пересмотрено 2026-10-18, п. 25).
> **Обновлено:** 2026-10-18 — прокси настраивается из админ-UI: runtime-override в сторе (file/PG),
> приоритет `SYNTH_PROXY_*` > runtime > config.yaml, применение при следующем старте (`restartRequired`),
> write-only пароль (`secrets/proxy-password`, env приоритетнее), аудит `scope:'proxy'`, `check` по saved.
> **Обновлено:** 2026-10-18 — TLS настраивается из админ-UI (раздел «Сеть»): bootstrap
> `security-tls.json` (до PG), приоритет `SYNTH_TLS_*` > runtime > config, CA-бандл, default mTLS-клиент
> и per-host `mappings`, тот же профиль для PostgreSQL, API `settings/tls*`, аудит `scope:'tls'`.
> **Обновлено:** 2026-10-18 — доменная аутентификация прокси (NTLM/Negotiate/Kerberos) вынесена из
> scope: делегируется промежуточному egress-прокси (Squid/px); SOCKS5 — best-effort; см. п. 25–26.
> **Обновлено:** 2026-10-18 — профили и host-правила прокси (п. 27): `proxy.mode`
> (`all`/`selected`), `proxy.profiles` (per-profile URL/auth/TLS), `proxy.rules` (порядок = приоритет,
> первое совпадение; `noProxy` важнее правил; CIDR — только по IP-литералу), пароли и TLS-материалы
> профилей в `secrets/proxy/`, API `settings/proxy/profiles/:name/*` и `POST settings/proxy/test`,
> UI-редактор профилей/правил и target-check, legacy-совместимость.
> **Связано:** [PROP-088](./prop-088-http-proxy.md) (заменён/надстроен), [PROP-100](./prop-100-ssrf-dns-rebinding.md),
> [ADR-071](./adr-071-mcp-servers-prompt.md) §2.3.1 (сетевой доступ MCP), [ADR-052](./adr-052-public-api-platform.md)
> (webhooks), [ADR-041](./adr-041-llm-error-taxonomy.md) (ключи ошибок), [ADR-036](./adr-036-llm-gateway.md),
> [PROP-094](./prop-094-observability-metrics.md), [ADR-023](./adr-023-configuration.md),
> [ADR-076](./adr-076-git-repo-registry-ssh.md), [ADR-078](./adr-078-runtime-dependency-availability.md),
> [ADR-096](./adr-096-storage-layer.md), [PROP-032](./prop-032-history-storage-postgresql.md);
> конфиг — [docs/CONFIGURATION.md](../CONFIGURATION.md).

## Контекст

Корпоративные инсталляции стоят за прокси/шлюзом с собственным (часто self-signed) CA. Нативный
`fetch` (undici) доверяет **только системным** CA Node, поэтому за таким контуром каждый исходящий
запрос либо падал с `self-signed certificate in certificate chain`, либо подсистемы точечно отключали
проверку (`NODE_TLS_REJECT_UNAUTHORIZED`, локальные агенты) — открывая MITM. Единого механизма доверия
не было: каждая точка (провайдеры LLM, MCP HTTP, `web_fetch`/`web_search`, webhooks, гибридный backend,
инструкции/скиллы по URL, update-checker, OIDC, загрузка иконок, git, PostgreSQL) решала вопрос сама.

[PROP-088](./prop-088-http-proxy.md) проектировал единый **egress-слой целиком** (прокси + `no_proxy` +
доверенные CA + аутентификация прокси/Kerberos). Прокси-часть реализована; **доменная аутентификация
прокси осознанно не входит в приложение** — делегируется промежуточному egress-прокси/шлюзу (п. 25),
PROP-088 закрыт как заменённый. Доверие TLS/CA зафиксировано отдельным решением в этом же ADR.

Адресная (SSRF) политика при этом оставалась рассыпанной: у MCP — собственный `mcp.networkPolicy`, у
webhooks — зашитый `allowPrivateTargets` плюс отдельный `evaluateWebhookTarget`, у `web_fetch`/
`web_search`, remote-скиллов и URL-инструкций — литеральные проверки хоста. Один и тот же вопрос
(«можно ли идти на этот адрес?») решался тремя разными способами: без админского управления одними и
теми же правилами, без аудита изменений и без журнала фактических запросов. Поэтому адресная политика
введена в тот же egress-слой (пункты 8–15).

## Решение

Ввести **единый egress-слой**: один источник доверия TLS/CA и одна адресная политика для всех исходящих
соединений Synth.

1. **Источник доверия один — `security.tls`** (ADR-023: env > config.yaml > defaults): `caFile` /
   `caPem` (взаимоисключающи), `certFile` + `keyFile` (mTLS), `rejectUnauthorized` (по умолчанию `true`).
   **Инвариант: подсистемы не создают собственных агентов/диспетчеров/CA-пулов** — иначе политика
   доверия расходится по точкам, а точечное отключение проверки снова открывает MITM.
2. **Один транспорт.** `buildTlsTrust` читает PEM, `applyGlobalTlsTrust` ставит глобальный
   `undici`-dispatcher (`setGlobalDispatcher(new Agent({ connect }))`) — покрывает обычный `fetch` по
   всему процессу; `egressFetch` — `fetch` с **явным** dispatcher (детерминированно, для тестов и точек
   вне глобального состояния). Инициализация — `initTlsTrust` при старте, **до** первого исходящего
   запроса (в т.ч. для `syncProvidersFromEnv`, update-checker, дискавери OIDC). Пустая конфигурация —
   системное доверие, поведение не меняется.
3. **Fail-closed на явной конфигурации.** `caFile`+`caPem` одновременно → ошибка; заданный
   отсутствующий/нечитаемый/не-PEM файл → внятная ошибка (никакого тихого фоллбэка на системное
   доверие — опечатка в пути не должна молча ломать доверие к корпоративному CA). Заданное доверие без
   `undici` → внятная ошибка (`TlsDependencyUnavailableError`, в духе [ADR-078](./adr-078-runtime-dependency-availability.md));
   прямая зависимость `undici@^7` (ранее — транзитивная).
4. **Git — отдельный канал, но тот же источник.** Вне общего транспорта git получает CA через
   `simpleGit({ config: ['http.sslCAInfo=<caFile>'] })`; `caPem` без файла git-каналу недоступен —
   для git задавайте `caFile`.
5. **PostgreSQL — через `storage.postgres.sslmode`** (`disable` / `require` / `verify-full`;
   `verify-ca` — алиас `verify-full` с предупреждением). CA/mTLS берутся из `security.tls`;
   `verify-full` без сконфигурированного CA — **fail-closed** (никакого тихого `rejectUnauthorized:false`).
   **TLS-параметры (`sslmode`/`sslrootcert`/`sslcert`/`sslkey`/`ssl`/…) запрещены в DSN**: `pg`
   накладывает распарсенный DSN **поверх** явного конфига (`Object.assign({}, config,
   parse(connectionString))`) и молча перекрывает `ssl`-объект — вплоть до отключения TLS. Нарушение —
   ошибка конфигурации с понятным текстом.
6. **TLS применяется при старте, но настраивается runtime (bootstrap).** `security.tls` **не входит** в
   `RuntimeSettings`/PG: dispatcher процесс-глобальный, изменения применяются при старте и требуют
   рестарта (hot-reload — остаток). При этом у TLS есть **runtime-оверрайд** в bootstrap-файле
   `{dataDir}/security-tls.json` (0600, каталог 0700, атомарная запись tmp→rename), который читается
   **до** подключения к PostgreSQL: TLS нужен, чтобы это подключение вообще стало возможным, поэтому
   настройки не могут жить в БД. Приоритет — env `SYNTH_TLS_*` > runtime (bootstrap/UI) > `config.yaml` >
   defaults. Адресная политика (пункты 8–11) — наоборот, **live**: резолвится из стора на каждый
   исходящий запрос, рестарт не нужен.
7. **`NODE_EXTRA_CA_CERTS` — только совместимость**, не конфигурируемый механизм: он наследуется
   дочерними процессами (MCP stdio, git) и используется как провиз-совместимый слой в Helm, но
   управляемый источник доверия — `security.tls`.

### Адресная политика (часть того же слоя)

8. **Адресная политика — часть egress-слоя, а не локальная проверка подсистемы.** Админские настройки:
   `egress.tools` (встроенные инструменты `web_fetch`/`web_search` и внутренние потребители
   `net/fetch` — URL-скиллы, URL-источники инструкций, иконки провайдеров), `egress.webhooks`
   (исходящие webhooks) и `mcp.networkPolicy` (пользовательские HTTP/SSE MCP-серверы,
   [ADR-071](./adr-071-mcp-servers-prompt.md) §2.3.1). Runtime API:
   `GET/PUT/DELETE /api/v2/settings/egress/tools`, `GET/PUT/DELETE /api/v2/settings/egress/webhooks`,
   `GET/PUT/DELETE /api/v2/settings/mcp-network-policy` (путь сохранён, добавлены `exceptions`) и
   `POST /api/v2/settings/egress/check` `{scope:'tools'|'webhooks'|'mcp', url}` →
   `{allowed, reason?, matchedRule?, addresses?, policy}` (только разбор/DNS/сверка, запрос **не**
   выполняется). RBAC: мутации — ADMIN (managed) / `requireAuth` (core).
9. **Единый формат.** `{mode: 'deny'|'allow', list: string[], exceptions: string[]}` для всех трёх
   скоупов; `mode: 'off'` — только `egress.webhooks` (dev: снимает и требование `https`). `exceptions` —
   allow-правила, проверяются **первыми**: точный hostname, `*.suffix`, IP/CIDR. `deny` — блок, если хотя
   бы один resolved-адрес попал в `list`; `allow` — разрешено, только если **все** resolved-адреса в
   `list` либо сработало исключение. Литеральные `localhost`/`*.localhost`/`*.local`/`*.internal` и
   приватные адреса блокируются самой политикой (проверка локальных имён + дефолтный `list`), а не
   отдельным зашитым списком подсистемы; исключения их разрешают. Невалидная запись → 400 `VALIDATION_ERROR`. Env — только скаляры
   (`SYNTH_EGRESS_TOOLS_MODE`, `SYNTH_EGRESS_WEBHOOKS_MODE`, `SYNTH_EGRESS_LOG_ENABLED`,
   `SYNTH_EGRESS_LOG_RETENTION_DAYS`); списки (`list`/`exceptions`) — только config.yaml.
10. **Независимые экземпляры политики.** `tools` и `webhooks` не смешиваются: у них разная граница
    доверия (webhooks — админский исходящий канал, `tools` — поверхность, управляемая содержимым и
    моделью); MCP — третий экземпляр. Изменение одной политики не влияет на остальные.
11. **Live per-request.** Политика резолвится из стора при каждой исходящей операции (runtime override →
    config.yaml → встроенный дефолт `deny` приватных диапазонов), без фонового опроса и кэша; в рамках
    одного вызова — **один снимок** (проверка и все хопы редиректов). Fail-closed: `undefined` не значит
    «разрешено всё». MCP — при подключении и при записи/проверке реестра.
12. **`webhooks.allowPrivateTargets` удалён.** Замена — `egress.webhooks.mode: 'off'` (dev) либо
    `egress.webhooks.exceptions`. Env `SYNTH_WEBHOOKS_ALLOW_PRIVATE_TARGETS` удалён; легаси-ключ в
    config.yaml **игнорируется с предупреждением** (fail-closed миграция, ADR-023).
13. **Аудит изменений политики.** Append-only `{dataDir}/audit/security.jsonl` (порт
    `SecurityAuditRepository`): запись на каждый PUT/DELETE политик `tools`/`webhooks`/`mcp` —
    `{ts, actor, scope, action, before, after, source:'runtime', version}`; чтение —
    `GET /api/v2/audit/security?limit&scope` (ADMIN/AUDITOR; core — `requireAuth`).
14. **Журнал внешних запросов.** Append-only `{dataDir}/audit/egress.jsonl` (порт
    `EgressRequestLogRepository`): `scope` (`web_fetch`|`web_search`|`skills`|`instructions`|`webhooks`|
    `providers`|`mcp`), `host`, `url` (без query/userinfo), `method?`, `status`
    (`allowed`|`blocked`|`error`), `httpStatus?`, `bytes?`, `durationMs?`, `reason?`, `matchedRule?`,
    `sessionId?`, `projectId?`, `actor?`. Тела и заголовки **не** логируются; retention —
    `egress.log.retentionDays` (`0` — без очистки), prune на старте и раз в 6 ч; чтение —
    `GET /api/v2/audit/egress?limit&scope&status`. **Провайдеры LLM в журнал не входят** — у них свой
    LLM audit/payload-лог ([ADR-036](./adr-036-llm-gateway.md)).
15. **Правило при HTTP-прокси** (реализовано, пункты 16–20; доменный остаток — [PROP-088](./prop-088-http-proxy.md)).
    Если адрес резолвит прокси, адресная проверка на стороне Synth **отключается** (проверять нечего:
    соединение устанавливает прокси), hostname-правила (`list`/`exceptions` по имени) остаются;
    ответственность за адресную политику переходит на прокси и его allowlist. Исключение — хосты из
    `noProxy`: там маршрут direct и проверка полная. Правило действует на каждый хоп редиректа, чтобы
    включение прокси не создавало ложного ощущения защиты.
16. **Прокси — часть egress-слоя, а не транспорт подсистемы.** Top-level секция `proxy`
    (`enabled`, `url`, `httpProxy`/`httpsProxy`/`allProxy`, `noProxy[]`, `fromEnv`, `fallbackDirect`,
    `connectTimeoutMs`, `auth` (Basic), `tls` (CA/mTLS к https-прокси)); та же секция может быть
    сохранена как runtime-override из админ-UI (п. 21). Маршрут выбирается **per-origin**:
    `httpsProxy`/`httpProxy` по схеме цели → `allProxy` → `url`; подсистемы не создают собственных
    прокси-агентов и не читают env напрямую. Транспорт — `EgressDispatcher` поверх `security.tls`:
    TLS к цели (`requestTls`) и к прокси (`proxyTls`) разделены. Прокси применяется **при старте**
    (dispatcher start-only), как `security.tls`.
17. **Приоритет и источники (ADR-023).** Явные `SYNTH_PROXY_*` > runtime-override из админ-UI
    (`RuntimeSettings.proxy`, `settings.json`/PG) > `config.proxy` > стандартные
    `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` (только при `fromEnv`) > defaults; слияние —
    поле-уровневое. То есть UI правит config-уровень, но **не переопределяет явный env деплоя**.
    Стандартные env не применяются, если runtime/config явно задали `enabled: false` (прокси не
    включается «из окружения» вопреки конфигу инстанса). `noProxy`: `SYNTH_PROXY_NO_PROXY` >
    runtime > непустой `noProxy` из config > `NO_PROXY`.
    **Секреты:** пароль Basic — только `SYNTH_PROXY_PASSWORD` или `{dataDir}/secrets/proxy-password`
    (в config.yaml не хранится, инвариант 13); userinfo в URL извлекается в resolved-креды и **не
    попадает** в конфиг, логи, статус и `proxyStatus` (только redacted URL). Ошибка конфигурации
    (битый URL, неизвестная схема, `enabled=true` без URL, Basic без пароля, `ntlm`/`negotiate`) —
    fail-closed на старте (`EGRESS_PROXY_CONFIG_INVALID`).
18. **`noProxy` и адресная политика — per-hop.** Синтаксис `noProxy`: host, `.suffix`, `*.suffix`,
    `host:port`, IP, CIDR (по IP-литералу цели — DNS для исключений не резолвится), `*`. Для
    хостов из `noProxy` маршрут — direct и выполняется **полная** адресная проверка (DNS/CIDR каждого
    хопа). Для запросов через прокси адрес назначения неизвестен: проверяются только схема и
    hostname-правила/`exceptions` (DNS/CIDR пропускаются; в `allow`-режиме CIDR-only политика
    непроверяема → отказ, `proxied-allow-unverifiable`). Правило действует **на каждый хоп**
    редиректа; фактический маршрут (`proxy`/`direct`/`fallback`) пишется в журнал egress (`via`) и
    отдаётся `POST /api/v2/settings/egress/check` (`proxied`, `addressChecksActive`).
19. **Fail-closed транспорта.** Недоступный прокси → `EGRESS_PROXY_UNAVAILABLE` (тихого direct нет);
    `fallbackDirect` — только явный opt-in (warn + `via:'fallback'`). Ошибки аутентификации
    (`407`/SOCKS-отказ) → `EGRESS_PROXY_AUTH_REQUIRED`/`EGRESS_PROXY_AUTH_FAILED`, direct-фоллбек
    запрещён даже при `fallbackDirect`. Basic передаётся `token`'ом (первый CONNECT, без
    407-challenge); SOCKS5/SOCKS5H — `Socks5ProxyAgent` (RFC 1929 user/pass, hostname резолвит прокси;
    экспериментальный в undici). `proxy.tls` несовместим с `socks5://` (ошибка конфигурации).
20. **Точки вне HTTP-транспорта, API и границы.** git получает прокси через child-env
    (`http_proxy`/`https_proxy`/`all_proxy`/`no_proxy`, Basic — в userinfo env-URL, не в argv;
    `no_proxy` применяет libcurl, per-remote настройки нет). `stdio`-MCP получает
    `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` (+ `NODE_EXTRA_CA_CERTS`) без пароля. API —
    `GET/PUT/DELETE /api/v2/settings/proxy` (+ `/proxy/password`, `POST /proxy/check`, п. 21).
    UI — раздел «Сеть» → «Прокси» (редактируемая форма, статус saved/running, плашка рестарта,
    «Проверить соединение»); рядом — «Доверенные CA (TLS)». Прокси — **start-only**: live-переключения нет, изменения требуют
    рестарта. PostgreSQL не проксируется (не HTTP). Прокси с IP-литералом и TLS требует DNS-хоста
    (SNI/servername по IP запрещён в Node), при этом диагностика `check` может показать `reachable`
    (она не ставит servername для IP).
21. **Runtime-настройка прокси из админ-UI.** Секция `proxy` сохраняется в `RuntimeSettings.proxy`
    (`{dataDir}/settings.json`, PG — таблица `settings`; переносится `synth storage migrate`) и
    **применяется при следующем старте**, а не live: порядок инициализации — ранний `initTlsTrust`
    (TLS/CA и первичный прокси из config/env, нужен для PostgreSQL), затем сборка хранилища, затем
    `applyStartupProxyConfig` (core `server/app.ts` до deps, backend `createBackendStorage`) —
    дочитывает runtime-override и пересобирает `EgressDispatcher` **до** создания провайдеров.
    `GET /api/v2/settings/proxy` отдаёт `saved` (config ← runtime ← env), `running` (текущий
    dispatcher), `defaults`, `isOverridden`, `password` (только `{source:'env'|'file'|'none', set,
    removable}`) и `restartRequired` (отпечаток saved ≠ running); плоские поля оставлены для обратной
    совместимости и равны `saved`. `PUT` валидирует и сохраняет (live не применяет, ответ
    `restartRequired: true`), `DELETE` сбрасывает к config/env. **Пароль** Basic — только
    `SYNTH_PROXY_PASSWORD` (приоритетнее, UI не меняет: `PUT/DELETE /proxy/password` → 409 `CONFLICT`)
    или файл `{dataDir}/secrets/proxy-password` (0600, каталог 0700, tmp→rename); значение не
    отдаётся, не логируется и не попадает в аудит. Статус (`flat`/`saved`/`running`/`defaults`) отдаёт
    безопасные поля `fromEnv`, `auth:{type,username}` и `tls:{caFile?,certFile?,keyFile?,hasCaPem,
    rejectUnauthorized}` — **без** `caPem`/PEM-содержимого, пароля и userinfo. Валидация: `auth.type` только `basic`
    (`ntlm`/`negotiate` → 400 «не поддерживается»); пароль в userinfo URL в сохраняемой секции
    **запрещён** (инвариант 13); `tls` — `caFile`↔`caPem` взаимоисключающи, `certFile`+`keyFile` вместе.
    Изменения пишутся в аудит `{dataDir}/audit/security.jsonl` со `scope:'proxy'` (before/after без
    пароля); `POST /proxy/check` проверяет **saved**-конфигурацию (`usingSaved: true`), чтобы UI видел
    будущее состояние после рестарта.

22. **Runtime-настройки TLS из админ-UI (bootstrap).** `{dataDir}/security-tls.json` —
    `{caFile?, caPem?, rejectUnauthorized?, defaultClient?:{certFile?,keyFile?}, mappings?:[{id, hosts,
    certFile, keyFile, label?}]}`; PEM-материалы лежат в `{dataDir}/secrets/tls/` (`ca.pem`,
    `client.crt`/`client.key`, `<id>.crt`/`<id>.key`; 0600, каталог 0700), в JSON — только пути и
    публичный `caPem`. Bootstrap — **осознанное исключение** из «всё через порты хранилища»: файл
    читается до PG; в `RuntimeSettings`/`settings.json` TLS не хранится. Приоритет поле-уровневый:
    env `SYNTH_TLS_*` > runtime > config.yaml > defaults; `caFile`↔`caPem` взаимоисключающи (конфликт
    между источниками — fail-closed). Параметры из config/env показываются в UI **read-only** с
    пометкой источника; `PUT/DELETE` CA и default-клиента при env/config → 409 `CONFLICT`.
23. **Клиентские TLS-профили (mTLS).** Один **CA-бандл** на весь egress (несколько сертификатов в
    одном PEM допустимы); per-host CA **нет**. Один **default client** (глобальный серт+ключ) и
    `mappings[]` — per-host пары: паттерны `exact`, `*.suffix`, `*` (все хосты), регистронезависимо;
    выбор — **первое совпадение** в порядке маппингов, иначе default; без default и без совпадения —
    без клиентского серта. `mappings` — только runtime (редактируются в UI). PostgreSQL использует
    **тот же резолвер** (`selectTlsClientProfile` по host) — default-серт без маппинга предъявляется
    и БД. TLS **к прокси** (`proxy.tls`) — отдельная секция, в UI только read-only; через SOCKS5
    клиентский серт к цели не передаётся (ограничение `Socks5ProxyAgent`).
24. **API/UI и аудит TLS.** `GET/PUT /api/v2/settings/tls` (CA-путь/`caPem`-бандл/`rejectUnauthorized`),
    `PUT/DELETE /settings/tls/ca` (PEM-бандл, 1+ сертификатов), `PUT/DELETE /settings/tls/client`
    (cert+key, write-only), `POST/PUT/DELETE /settings/tls/mappings[/:id]`, `POST /settings/tls/validate`
    (разбор без записи). Ответы — только метаданные: источники, `ca{count,subjects}`, subject
    клиентских сертов, `hasKey`, `readOnly`, `running/saved`, `restartRequired`; PEM/ключи/пароли
    **не возвращаются**. Валидация: `caFile`↔`caPem`, неполная клиентская пара, битый PEM/ключ,
    неизвестное поле → 400; нет маппинга → 404; read-only из env/config → 409. Изменения — аудит
    `{dataDir}/audit/security.jsonl` со `scope:'tls'` (пути/hosts/subject, без PEM/ключей). UI —
    раздел «Сеть» (ADMIN): «Прокси» и «Доверенные CA (TLS)»; применение — при следующем старте
    (`restartRequired`).

25. **Доменная аутентификация прокси — вне scope приложения (2026-10-18).** NTLM/Negotiate/Kerberos
    **не реализуются** в Synth: `auth.type` — только `basic` (иначе 400 при сохранении из UI /
    `EGRESS_PROXY_CONFIG_INVALID` на старте). Причины: `undici.ProxyAgent` не выполняет 407-challenge —
    нужен собственный CONNECT-цикл; нативная зависимость (`kerberos`/libkrb5) и keytab; KDC/время/
    cross-realm; приёмка возможна только с AD/KDC клиента; рост blast radius (keytab в pod),
    multi-arch/образы, PAC/WPAD. Оценка 4–8 недель + постоянное сопровождение (NTLM отдельно +1–2 недели,
    легаси). **Принятая альтернатива — промежуточный egress-прокси/шлюз:** Synth ходит в него по HTTP
    CONNECT (Basic/mTLS/без auth), а шлюз — в корпоративный прокси по Kerberos/NTLM. Для K8s это
    **целевая схема**: Squid умеет upstream Kerberos (`cache_peer … login=NEGOTIATE[:principal]
    connection-auth=on`, keytab через `KRB5_KTNAME`, `never_direct allow all`); для NTLM/PAC — `px`
    (px-proxy: NTLM/Negotiate/PAC). Keytab — в отдельном Deployment/namespace (лучше, чем sidecar), Secret
    read-only, `krb5.conf` ConfigMap, KDC доступен по NetworkPolicy, NTP; приложение keytab не видит,
    ротация/HA/аудит — на шлюзе. **Следующий шаг (не реализовано):** распознавать `Proxy-Authenticate:
    Negotiate|NTLM` и отдавать отдельный код/подсказку «используйте промежуточный egress-прокси»;
    сейчас `407` → `EGRESS_PROXY_AUTH_REQUIRED`/`EGRESS_PROXY_AUTH_FAILED` без такой подсказки.
26. **SOCKS5 — best-effort, не целевой для K8s.** `Socks5ProxyAgent` (user/pass RFC 1929, remote DNS,
    экспериментальный в undici) уже реализован; **нет** доверия к цели через SOCKS (`requestTls` не
    принимается), `proxy.tls` несовместим с `socks5://`, GSSAPI нет. Для K8s — HTTP CONNECT. Не
    вкладываться в mTLS-over-SOCKS без конкретного клиента: только по требованию (custom dispatcher/
    форк `undici`).

27. **Профили и host-правила прокси (2026-10-18).** Один прокси на инсталляцию — недостаточно:
    типовой корпоративный контур требует **разные** прокси для разных направлений (LLM — через
    LLM-egress, внутренние хосты — напрямую, партнёрские — через отдельный шлюз), часто с разными
    кредами и клиентскими сертификатами. Поэтому секция `proxy` расширена до модели «профили +
    правила».

    **Модель.** `mode: all | selected` (default `all`), `defaultProfile` (имя профиля; при `all`
    обязателен — иначе `default`, если он есть), `profiles.<name>` — именованный прокси
    (`label?`, `url` и/или `httpProxy`/`httpsProxy`/`allProxy`, `auth`, `tls`), `rules[]` —
    правила маршрутизации.

    ```yaml
    proxy:
      enabled: true
      mode: all                 # all — default-профиль для всех, кроме noProxy; selected — только rules
      defaultProfile: default
      profiles:
        default:
          label: Corporate
          url: http://proxy.corp:3128
          auth: { type: basic, username: synth }
          tls: { caFile: /etc/synth/tls/proxy-ca.pem, rejectUnauthorized: true }
        llm:
          label: LLM egress
          url: https://llm-proxy:8443
          auth: { type: basic, username: synth-llm }
          tls: { caFile: …, certFile: …, keyFile: … }
      rules:
        - id: r_openai
          label: OpenAI
          hosts: ["api.openai.com", "*.openai.com"]
          action: proxy
          profile: llm
        - hosts: ["*.corp.local", "10.0.0.0/8"]
          action: direct
      noProxy: ["localhost", ".svc"]
    ```

    **Маршрут.** `enabled: false` → всё direct; `noProxy` **всегда важнее** правил; затем правила в
    порядке объявления — **первое совпадение**; затем `mode: all` → `defaultProfile`, `mode: selected` →
    direct (`no-match`). `action: direct` запрещает `profile` (400/ошибка конфигурации); `profile` не
    задан → `defaultProfile`. Один резолвер (`resolveProxyRoute`) используют и транспорт, и диагностика
    — расхождений «проверка показывает одно, трафик идёт иначе» нет.

    **Паттерны `hosts`/`noProxy`.** `exact`, `.suffix` (apex **и** поддомены), `*.suffix` (только
    поддомены), `host:port`, IP-литерал, CIDR, `*`. **CIDR матчится только по IP-литералу цели** (DNS
    для исключений/правил не резолвится — иначе маршрут зависел бы от DNS и становился вектором
    rebinding, ср. [PROP-100](./prop-100-ssrf-dns-rebinding.md)); `*.suffix` **не** матчит apex.

    **Профиль.** Имя — `^[a-z][a-z0-9_-]{0,31}$`, **неизменяемое** (переименование = создать новый и
    перенести правила; иначе «поехали» бы пути секретов и ссылки в правилах). URL-схемы —
    `http`/`https`/`socks5`/`socks5h`; `auth` — только `basic` (NTLM/Negotiate — вне scope, п. 25);
    `tls` — CA/mTLS **к прокси**, независимо от `security.tls` (доверие **к цели**): одно и то же
    соединение имеет два независимых TLS-контекста, и клиентский серт к прокси не подменяет серт к
    цели.

    **Секреты (инвариант 13).** Пароли — не в конфиге: `default` — `SYNTH_PROXY_PASSWORD` >
    `{dataDir}/secrets/proxy-password` (legacy-совместимость), остальные — `SYNTH_PROXY_<NAME>_PASSWORD`
    (`<NAME>` — имя профиля в верхнем регистре, `-` → `_`) > `{dataDir}/secrets/proxy/<name>.password`
    (0600, каталог 0700, атомарная запись). Пароли **write-only**: значения не возвращаются, не
    логируются и не попадают в аудит; при заданном env-пароле UI-мутация → **409** (`CONFLICT`).
    TLS-материалы профиля — `{dataDir}/secrets/proxy/<name>/{ca.pem,client.crt,client.key}` (0600); в
    конфиг пишутся только пути, PEM/ключи наружу не отдаются.

    **API.** `GET/PUT/DELETE /api/v2/settings/proxy` (профили/правила/`mode`/`defaultProfile` в
    `saved`/`running`/`defaults`; статус профилей — redacted: URL без userinfo, username, пути TLS,
    `hasCaPem`), `PUT/DELETE /api/v2/settings/proxy/profiles/:name/password`,
    `PUT/DELETE /api/v2/settings/proxy/profiles/:name/tls/ca`, `PUT/DELETE
    /api/v2/settings/proxy/profiles/:name/tls/client`, `POST /api/v2/settings/proxy/test {url}` —
    target-check: `HEAD` без редиректов и тела, адресная политика проверяется **до** запроса, ответ
    `{route:{action,via,reason,ruleId?,ruleLabel?,profile?,profileLabel?,proxyUrl?}, ok, httpStatus?,
    latencyMs, authChallenge, error?, usingSaved, restartRequired}`. Ошибки: 400 (невалидный URL/
    профиль/правило), 404 (нет профиля), 409 (env-пароль), redaction как выше.

    **UI.** «Сеть» → «Прокси»: режим, таблица профилей (добавить/изменить; имя неизменяемо), правила
    с приоритетом (порядок = first match), write-only пароль и TLS-материалы профиля, target-check
    (показывает сработавшее правило/профиль/прокси и что проверка идёт по **saved**), плашка
    `restartRequired` со ссылкой «Обслуживание → Перезапуск».

    **Legacy.** Без `profiles`/`rules` поведение прежнее: top-level `url`/`httpProxy`/`httpsProxy`/
    `allProxy`/`auth`/`tls` = синтетический профиль `default`; при заданных `profiles` top-level
    URL/auth/tls **запрещены** (fail-closed — иначе два источника истины). UI при сохранении
    конвертирует legacy-форму в `profiles.default`, сохраняя схемные поля (`httpProxy`/`httpsProxy`/
    `allProxy`). Env `SYNTH_PROXY_URL`/`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` в режиме профилей не
    применяются (ошибка конфигурации/400) — профили задаются в config/runtime.

    **Ограничения.** Per-host маршрут работает в HTTP-транспорте (`egressFetch`/`EgressDispatcher`);
    **git** и **stdio-MCP** получают один прокси через child-env и per-host выбирать не умеют — в
    `mode: selected` прокси-env им **не ставится** (иначе молчаливый обход правил). SOCKS5 —
    best-effort (п. 26). Runtime-reload по-прежнему отсутствует: изменения профилей/правил применяются
    после рестарта. Multi-proxy mTLS — есть (у каждого профиля свой `tls`).

## Альтернативы

- **`NODE_EXTRA_CA_CERTS` как основной механизм** — отклонён: процесс-глобальный, вне конфига
  (ADR-023), дочерние процессы/`git` видят его иначе; оставлен только для совместимости.
- **Свой агент/диспетчер в каждой подсистеме** — отклонён: дублирование и расхождение политики
  доверия; точечное `rejectUnauthorized: false` снова открывает MITM.
- **Отключение проверки по умолчанию** — отклонён (MITM); доступно явно (`rejectUnauthorized: false`).
- **Разрешить TLS-параметры в DSN PostgreSQL** — отклонён: `pg` молча применяет их поверх `ssl`.
- **Runtime-переключение TLS-транспорта без рестарта** — отклонено осознанно: dispatcher — процесс-глобальный
  singleton, живая пересборка гонкоопасна (остаток).
- **Адресная политика как runtime-настройка (live), а не стартовый конфиг** — **принято**: правила
  меняются без рестарта, единый формат для tools/webhooks/MCP, аудит изменений и журнал запросов.
  Альтернатива «зашитые списки в каждой подсистеме» отклонена: политики расходятся, админ не видит
  целого, аудита нет.
- **`off` как общий режим для всех скоупов** — отклонён: снятие проверок допустимо только для webhooks в
  dev; для tools/MCP — fail-closed (`off` не принимается, 400).
- **`http.Agent`-библиотеки (`proxy-agent`/`https-proxy-agent`)** — отклонены: они подменяют
  `http(s).Agent` для `node:http` и не применяются к `undici`/`fetch`; пришлось бы переписывать
  транспорт во всех точках и терять единый TLS-слой.
- **`EnvHttpProxyAgent` (undici) как готовый прокси-слой** — отклонён: не покрывает SOCKS5, CIDR и
  IP/портовые исключения `noProxy`, не даёт per-origin выбора direct/proxy и proxied-семантики
  адресной политики; оставлен только `ProxyAgent`/`Socks5ProxyAgent` как транспорт.
- **Один прокси на инсталляцию (только top-level `proxy`)** — отклонён как недостаточный: разные
  направления требуют разных кредов/сертификатов (LLM-egress ≠ партнёрский шлюз), а плоский `noProxy`
  не выражает «через какой прокси»; приняты именованные профили + правила first-match (п. 27).
- **NTLM/Negotiate/Kerberos в приложении** — **окончательно отклонено** (2026-10-18): `undici.ProxyAgent`
  не выполняет 407-challenge, нужен собственный CONNECT-цикл, нативная зависимость (`kerberos`/libkrb5),
  keytab/KDC/время/cross-realm, приёмка только с AD/KDC, рост blast radius (keytab в pod) и поддержки
  multi-arch/образов. **Принято:** промежуточный egress-прокси/шлюз (Squid `login=NEGOTIATE`, `px` для
  NTLM/PAC) — п. 25. Вариант `curl --proxy-negotiate` (внешний процесс вместо транспорта) отклонён:
  ломает streaming, аудит, mTLS и адресную политику.

## Последствия

- (+) Единый источник доверия: корпоративные CA и mTLS работают во всех исходящих точках, включая
  git и PostgreSQL; поведение тестируемо (инъекция `fetchImpl`/`dispatcher`).
- (+) Fail-closed: неверная конфигурация не уводит канал молча на недоверенный транспорт; «забыли
  CA» ловится на старте, а не на первом запросе.
- (+) Адресная политика управляется одинаково для tools/webhooks/MCP и применяется live; аудит
  (`audit/security.jsonl`) отвечает «кто и что изменил», журнал (`audit/egress.jsonl`) — «куда ходили
  и что заблокировали» (без тел и заголовков).
- (+) Корпоративный egress работает: LLM-провайдеры, MCP HTTP, `web_fetch`/`web_search`, webhooks,
  гибрид, OIDC и git ходят через HTTP/HTTPS/SOCKS5-прокси; недоступный прокси не «проваливается» в
  direct, `noProxy` соблюдается на каждом хопе, адресная политика в proxied-режиме честно сообщает,
  что DNS/CIDR не проверяются; креды и userinfo не попадают в логи/статус.
- (+) Прокси управляется из админ-UI без правки config.yaml: runtime-override хранится в
  `settings.json`/PG, переносится `storage migrate`, валидируется на записи, изменения аудируются
  (`scope:'proxy'`), пароль — write-only (файл/env), а `restartRequired` честно показывает расхождение
  saved/running.
- (+) Профили и правила закрывают многопрокси-контур: разные прокси/креды/mTLS на разные направления,
  «напрямую» для внутренних хостов, приоритет и `noProxy` выражены явно; маршрут и его причина
  (`rule`/`default`/`no-proxy`/`no-match`) видны в target-check и журнале egress, так что
  «почему этот запрос пошёл не туда» разбирается без догадок.
- (+) Доверие TLS и mTLS настраиваются из UI (раздел «Сеть»): CA-бандл, `rejectUnauthorized`, default
  клиентский серт и per-host маппинги; параметры config/env видны read-only с источником, изменения
  аудируются (`scope:'tls'`) без PEM/ключей, `restartRequired` показывает необходимость рестарта.
  PostgreSQL использует тот же профиль, поэтому «серт для БД» не настраивается отдельно.
- (−) Появилась прямая зависимость `undici@^7`; git-CA ограничен файлом (`caFile`).
- (−) Политика — **не граница безопасности**: при доступном `execute_shell`, `stdio`-MCP или внешних
  движках ([PROP-050](./prop-050-external-engines-runner.md)) исходящий трафик идёт мимо guard;
  пиннинга проверенного адреса нет (TOCTOU/DNS-rebinding — [PROP-100](./prop-100-ssrf-dns-rebinding.md));
  при прокси адресную проверку выполняет прокси (п. 15).
- (+) Доменная аутентификация прокси изолирована в egress-шлюзе: keytab не попадает в pod приложения,
  ротация/HA/аудит — на шлюзе, приложение остаётся с простым HTTP CONNECT и Basic/mTLS до шлюза (п. 25).
- (−) Принятый trade-off: NTLM/Negotiate/Kerberos **не поддерживаются в приложении** (`auth.type` кроме
  `basic` → ошибка конфигурации) — нужен промежуточный egress-прокси/шлюз (Squid/px), это лишний хоп и
  дополнительная эксплуатация. `security.tls` (CA/mTLS к цели) не применяется через SOCKS5
  (`Socks5ProxyAgent` не принимает `requestTls`) — только системное доверие; https-прокси/SOCKS по
  IP-литералу требуют DNS-хоста (SNI); SOCKS5 в undici экспериментален и всегда резолвит hostname на
  прокси (best-effort, не целевой для K8s).
- (−) Профили/правила действуют в HTTP-транспорте: git и stdio-MCP получают один прокси-env и per-host
  маршрут не поддерживают (в `mode: selected` прокси им не ставится); CIDR-правила матчатся только по
  IP-литералу (DNS для правил не резолвится) — для хостов по имени используйте `.suffix`/`*.suffix`.
- (−) TLS-модель ограничена: один CA-бандл на весь egress (per-host CA нет), один default-клиент
  (несколько default-сертов нельзя), default-серт без маппинга предъявляется всем целям, включая
  PostgreSQL; TLS к прокси (`proxy.tls`) задаётся отдельно и в UI только read-only. Bootstrap
  `security-tls.json` — осознанное исключение из «всё через порты хранилища» (читается до PG).
- (−) Прокси — start-only: сохранение из UI не применяется на лету, нужен рестарт (runtime-reload
  dispatcher'а — остаток); явные `SYNTH_PROXY_*` деплоя приоритетнее UI, поэтому часть настроек
  инстанса UI не переопределит. Встроенный глобальный `fetch` не гарантирован:
  spike на Node 26 показал, что npm-`setGlobalDispatcher` не влияет на встроенный fetch; покрыты
  пути через `egressFetch` (все защищённые), сторонний код/SDK — вне scope (на Node 22 — перепроверить
  в CI). PostgreSQL не проксируется; git применяет `no_proxy` средствами libcurl, per-remote
  настройки нет; `stdio`-MCP получает env без пароля.
- (−) TLS инициализируется при старте (без hot-reload); hot-reload прокси/TLS — остаток
  ([PROP-088](./prop-088-http-proxy.md)).

## Статус в коде

- **Конфиг/резолверы (shared):** `packages/shared/src/config/tls.ts` (`resolveTlsConfig`/`resolveTlsTrust`/`TLS_ENV`,
  `isPemContent`, PG-билдер `buildPostgresSslOptions`/`normalizePostgresSslMode`/`findDsnTlsParams`/`DSN_TLS_PARAMS`);
  схемы `securityTlsConfigSchema` и `storage.postgres.sslmode` (`packages/shared/src/config/types.ts`);
  env `SYNTH_POSTGRES_SSLMODE` (`packages/shared/src/config/resolve.ts`).
- **Транспорт доверия (core):** `packages/core/src/security/tls.ts` (`buildTlsTrust`,
  `applyGlobalTlsTrust` через `setGlobalDispatcher`, `egressFetch`, `initTlsTrust` с `tlsRuntime`,
  `getTlsStatus` — статус без секретов, `gitCaConfig`/`getTlsCaPath`, `TlsDependencyUnavailableError`).
- **TLS runtime/bootstrap (shared):** `packages/shared/src/config/tls-runtime.ts`
  (`readTlsRuntimeSettings`/`writeTlsRuntimeSettings`, `writeTlsSecretFile`, `tlsSecretsDir`,
  `TLS_RUNTIME_FILENAME`, `TLS_MATERIAL_NAMES`), `packages/shared/src/config/tls.ts`
  (`TlsRuntimeSettings`/`TlsMappingSettings`, `resolveTlsProfiles`, `selectTlsClientProfile`,
  `matchTlsHostPattern`, приоритет env > runtime > config, read-only-источники); `resolveTlsTrust`/
  `buildPostgresSslOptions` принимают `runtime`.
- **Профили в транспорте:** `packages/core/src/security/proxy-dispatcher.ts` (`tlsProfiles`,
  `profileFor`/`plannedProfile` — per-origin выбор профиля), `packages/storage-postgres/src/pool.ts`
  (`tlsRuntime` → `selectTlsClientProfile` по host: PostgreSQL использует тот же профиль).
- **Адресная политика (shared):** `packages/shared/src/types/egress.ts` (`EgressPolicy`,
  `WebhooksEgressPolicy`, `EgressPolicyScope`, `EgressLogConfig`, `DEFAULT_EGRESS_TOOLS_POLICY`/
  `DEFAULT_EGRESS_WEBHOOKS_POLICY`/`DEFAULT_EGRESS_LOG`, `EGRESS_REQUEST_SCOPES`/`STATUSES`,
  `SecurityAuditEntry`); схемы `egressConfigSchema`/`egressPolicySchema`/`webhooksEgressPolicySchema`/
  `egressLogConfigSchema` и `mcpNetworkPolicySchema` с `exceptions` (`config/types.ts`); env-оверрайды
  `SYNTH_EGRESS_*` (`config/env-overrides.ts`); предупреждение о легаси-ключе (`config/loader.ts`).
- **Адресная политика (core):** `engine/net/egress-policy.ts` (валидатор записей, live-резолвер
  `createEgressPolicyResolver`), `engine/net/egress-guard.ts` (`checkEgressUrl`/`fetchWithEgressGuard`,
  per-hop редиректы, fail-closed), `engine/net/egress-runtime.ts` (process-level резолвер и журнал),
  `engine/net/egress-log.ts` (`createEgressLogSink`, `startEgressLogPruner`); `engine/mcp/network-policy.ts`
  (общая нормализация адреса, `exceptions`); потребители — `engine/tools/web.ts`, `engine/net/fetch.ts`,
  `engine/skills/remote.ts`, `engine/context/instructions.ts`, `engine/webhooks/*`, `engine/mcp/*`,
  `packages/backend/src/routes/providers.ts`.
- **Прокси (shared):** `packages/shared/src/config/proxy.ts` (`resolveProxyConfig`, `parseProxyUrl`,
  `redactProxyUrl`, `NoProxyMatcher`, `proxyEntryFor`/`proxyUrlFor`/`shouldProxyUrl`, `proxyStatus`,
  `resolveProxyTls`, `validateProxyConfig`, `ProxyConfigError`, `ProxyPasswordStatus`), **профили и
  правила** — `resolveProxyRoute`/`defaultProxyEntry`/`resolveProxyRules`/`profileByName`,
  `mergeProxyConfig` (runtime заменяет `profiles`/`rules` целиком, поле-уровневое — для скаляров),
  валидатор host-паттернов (`exact`/`.suffix`/`*.suffix`/`host:port`/IP/CIDR/`*`), `proxyProfilePasswordEnv`;
  схемы `proxyConfigSchema` (`mode`/`defaultProfile`/`profiles`/`rules`)/`proxyProfileSchema`/
  `proxyRuleSchema`/`proxyAuthConfigSchema`/`proxyTlsConfigSchema` (`PROXY_PROFILE_NAME_RE`,
  `PROXY_MODES`), env `SYNTH_PROXY_*`/`SYNTH_PROXY_PASSWORD`/`SYNTH_PROXY_TLS_*`;
  `EgressRequestLogEntry.via`, `SECURITY_AUDIT_SCOPES` (+`proxy`) (`packages/shared/src/types/egress.ts`).
- **Прокси (core):** `security/proxy-dispatcher.ts` (`EgressDispatcher`, `EgressProxyUnavailableError`,
  `EgressProxyAuthError`; per-origin выбор профиля через `resolveProxyRoute`),
  `security/proxy-state.ts` (активная конфигурация, `gitProxyEnv`,
  `mcpProxyEnv`, `EGRESS_VIA`, `proxyConfigFingerprint`), `security/proxy-check.ts`
  (`checkProxyConnectivity` — коннект к прокси, `checkProxyTarget`/`describeProxyRoute` — проверка
  цели с маршрутом), `security/proxy-password.ts` (файлы `secrets/proxy-password` и
  `secrets/proxy/<name>.password`, `getProxyPasswordStatus`/`getProxyProfilePasswordStatus`, 0600/0700,
  tmp→rename), `security/proxy-tls-secrets.ts` (PEM профилей в `secrets/proxy/<name>/`,
  `proxyProfileTlsFilePath`/`writeProxyProfileTlsFile`/`removeProxyProfileTlsFile`, валидация имени),
  `security/proxy-startup.ts`
  (`applyStartupProxyConfig`); интеграция — `security/tls.ts` (`initTlsTrust` — ранний TLS/CA +
  первичный прокси, `applyEgressProxyConfig`/`configureEgressProxy` — второй шаг),
  `engine/net/egress-guard.ts` (proxied-режим, `via`), `server/routes/settings.ts`.
- **Runtime-override прокси:** `RuntimeSettings.proxy` (`storage/runtime-settings.ts`), порт
  `SettingsRepository.getProxySettings/setProxySettings/clearProxySettings`
  (`storage/ports/settings-repository.ts`), file/memory-реализации, PG
  (`packages/storage-postgres/src/ports/principals-settings.ts`), перенос
  `maintenance/storage-migrate.ts`; применение — `server/app.ts` и `backend/app/deps.ts`
  (`applyStartupProxyConfig` после сборки хранилища, до deps).
- **Перевод исходящих точек (TLS):** `providers/{base,openai,anthropic,ollama,remote,decision}.ts`,
  `engine/mcp/client.ts`, `engine/webhooks/service.ts`, `engine/context/instructions.ts`,
  `engine/skills/remote.ts`, `engine/tools/web.ts`, `engine/net/egress-guard.ts` (иконки провайдеров
  `POST /api/v2/providers/fetch-icon`), `remote/{client,connection,device-flow}.ts`, `update-checker.ts`,
  `packages/backend/src/auth/oidc.ts` (дискавери/токен и JWKS через `customFetch`); инициализация —
  `main.ts`, `server/app.ts`, `backend/app/deps.ts`.
- **Хранилище:** порты `storage/ports/security-audit-repository.ts` и
  `storage/ports/egress-request-log-repository.ts`; файловые реализации
  `storage/security-audit-store.ts` (`{dataDir}/audit/security.jsonl`) и
  `storage/egress-request-log-store.ts` (`{dataDir}/audit/egress.jsonl`); `storage/memory/*`; порты
  `SettingsRepository` (`getEgressPolicy`/`setEgressPolicy`/`clearEgressPolicy`); PG-драйвер —
  `packages/storage-postgres/src/ports/audit.ts` (`securityAudit`/`egressRequests`) и миграция
  `002-egress-audit` (таблицы `security_audit`, `egress_requests`).
- **API:** `packages/core/src/server/routes/settings.ts` (egress и proxy: `/settings/egress/*`,
  `/settings/proxy*`, `/settings/proxy/profiles/:name/{password,tls/ca,tls/client}`,
  `/settings/proxy/test` — target-check), `packages/core/src/server/routes/settings-tls.ts` (`/settings/tls`,
  `/settings/tls/ca`, `/settings/tls/client`, `/settings/tls/mappings[/:id]`, `/settings/tls/validate`),
  `packages/core/src/server/routes/audit.ts` (`GET /api/v2/audit/security`, `GET /api/v2/audit/egress`).
- **UI:** `components/settings/EgressPolicySection.tsx` — режим/список/исключения и «Проверить URL»;
  встроена в «Встроенные инструменты» (`ToolsDisabledSettings`), «Webhooks» (`WebhooksSettings`,
  `off` с предупреждением) и MCP (`NetworkPolicySection` — исключения и проверка); журналы —
  вкладки «Безопасность (политики)» и «Внешние запросы» в «Логах и аудите»
  (`SecurityAuditPanel`/`EgressLogPanel`); i18n `egress.*`/`logs.security.*`/`logs.egress.*` (ru/en).
  Прокси — `components/settings/ProxyStatusSection.tsx` (+ `ProxyProfilesSection.tsx`,
  `ProxyRulesSection.tsx`, `ProxyRouteCheck.tsx`, `proxy-draft.ts`; `lib/api/proxy.ts`), встроена в
  раздел «Сеть» (`NetworkSettings`): «Прокси» — режим (`all`/`selected`), профили (URL/`label`/Basic/
  TLS-пути, write-only пароль и PEM профиля, имя неизменяемо), правила с приоритетом (порядок = first
  match), `noProxy`, `fromEnv`, `fallbackDirect`, таймаут, статус saved/running, плашка «изменения
  после рестарта» со ссылкой на «Обслуживание → Перезапуск», «Проверить соединение» (коннект к прокси)
  и target-check (`POST /settings/proxy/test`: маршрут/правило/профиль/HTTP-статус);
  «Доверенные CA (TLS)» — `TrustedCaSection` (CA-бандл вставкой/файлом + validate, read-only параметры
  config/env с источником, default client upload, таблица маппингов, `rejectUnauthorized`, read-only
  TLS к прокси); i18n `network.*`/`proxy.*`/`tls.*`.
- **git:** `packages/core/src/git/git-service.ts` — `simpleGit({ config: gitCaConfig(), env: gitProxyEnv() })`
  (`http.sslCAInfo`; прокси/`no_proxy`/Basic — child-env, не argv). **MCP stdio:**
  `engine/mcp/client.ts` — `mcpProxyEnv()` + `NODE_EXTRA_CA_CERTS` в env дочернего процесса.
- **PostgreSQL:** `packages/storage-postgres/src/pool.ts` (`assertNoDsnTlsParams`, `buildPoolConfig` →
  `buildPostgresSslOptions`).
- **Деплой:** Helm `security.tls` (Secret с CA/клиентскими сертификатами, mount `/etc/synth/tls`; в
  ConfigMap только пути, `NODE_EXTRA_CA_CERTS` — для дочерних процессов); docker-compose (`SYNTH_TLS_*`).
- **Тесты:** `packages/shared/src/config/tls.test.ts`, `packages/core/src/security/tls.test.ts`,
  `packages/storage-postgres/src/pool-tls.test.ts`, `packages/core/src/git/git-ca.test.ts`,
  `packages/shared/src/config/resolve.test.ts`, `packages/core/src/engine/net/egress-guard.test.ts`
  (политика/журнал/аудит — тесты уровня подсистем), `packages/shared/src/config/proxy.test.ts`,
  `packages/shared/src/config/proxy-profiles.test.ts` (mode/rules/first-match/`noProxy`/CIDR/legacy/
  валидация профилей), `packages/core/src/security/proxy-dispatcher.test.ts`/`proxy-check.test.ts`/
  `proxy-target-check.test.ts`/`proxy-optin.test.ts`/`proxy-state.test.ts`/`proxy-startup.test.ts`,
  `server/routes/settings-proxy.test.ts`/`settings-proxy-profiles.test.ts`/`settings-tls.test.ts`
  (fake HTTP/HTTPS-прокси, Basic/mTLS, fake SOCKS5, `no_proxy`-таблица, git env, runtime-override,
  saved/running/`restartRequired`, пароль write-only, профильные пароли/PEM, target-check),
  `packages/shared/src/config/tls-runtime.test.ts`, `packages/core/src/security/tls-runtime.test.ts`,
  `packages/storage-postgres/src/pool-tls.test.ts`, UI `NetworkSettings.test.tsx`/
  `TrustedCaSection.test.tsx`/`ProxyStatusSection.test.tsx`/`proxy-draft.test.ts`; фикстуры —
  `packages/core/src/security/__fixtures__/` (self-signed, `TEST ONLY`).
- **Вне scope (не код Synth):** доменная аутентификация прокси (NTLM/Negotiate/Kerberos) —
  делегируется промежуточному egress-прокси/шлюзу (Squid `login=NEGOTIATE`, `px` для NTLM/PAC), п. 25;
  в коде только отказ `auth.type` ≠ `basic` (400/`EGRESS_PROXY_CONFIG_INVALID`). Egress gateway —
  deploy/docs (манифесты/чарт), не код приложения. 407-диагностика `Negotiate|NTLM` — следующий шаг.
- **Нет (остаток):** runtime-reload прокси/TLS без рестарта ([PROP-088](./prop-088-http-proxy.md));
  `security.tls` к **цели** через SOCKS5 (best-effort, п. 26); per-host CA и несколько default-клиентских
  сертов (одна CA-бандл-модель на цель; per-profile TLS — только **к прокси**, п. 27); пиннинг адреса
  (TOCTOU), в т.ч. для direct/`noProxy`-хостов —
  [PROP-100](./prop-100-ssrf-dns-rebinding.md); метрики — [PROP-094](./prop-094-observability-metrics.md);
  перепроверка покрытия встроенного `fetch` на Node 22 в CI.

## История

- 2026-10-16 — ADR заведён: единый egress-слой доверия TLS/CA + mTLS (секция `security.tls`, общий
  транспорт `egressFetch`/`applyGlobalTlsTrust`, перевод всех исходящих точек, git-CA, PostgreSQL
  `sslmode` + запрет TLS-параметров в DSN); прокси-часть PROP-088 не вошла — заменён/надстроен.
- 2026-10-17 — ADR расширен адресной политикой исходящих запросов: `egress.tools`/`egress.webhooks`
  (единый формат `mode`/`list`/`exceptions`, `off` только у webhooks), `mcp.networkPolicy` в том же
  формате, независимые экземпляры, live per-request, аудит изменений и журнал внешних запросов,
  удаление `webhooks.allowPrivateTargets`, правило взаимодействия с прокси.
- 2026-10-17/18 — прокси и TLS настраиваются runtime: HTTP/HTTPS/SOCKS5-прокси (секция `proxy`,
  `EgressDispatcher` с per-origin маршрутом, Basic и TLS/mTLS к https-прокси, `noProxy`, proxied-режим
  адресной политики и `via`, fail-closed/`fallbackDirect`, git/MCP через env; runtime-override в
  `RuntimeSettings.proxy`, применение при старте, `restartRequired`, write-only пароль, аудит
  `scope:'proxy'`, API `settings/proxy*`) и TLS (bootstrap `security-tls.json` до PG, CA-бандл,
  `rejectUnauthorized`, default mTLS-клиент и per-host `mappings`, тот же профиль для PG, API
  `settings/tls*`, раздел «Сеть», read-only config/env, аудит `scope:'tls'`); 2026-10-18 — доменная
  аутентификация прокси (NTLM/Negotiate/Kerberos) вынесена из scope и делегирована egress-шлюзу
  (п. 25), SOCKS5 — best-effort (п. 26); 2026-10-18 — профили и host-правила прокси (п. 27):
  `proxy.mode`/`profiles`/`rules`, first-match и `noProxy`-приоритет, CIDR по IP-литералу,
  per-profile `auth`/`tls`, пароли/TLS-материалы профилей в `secrets/proxy/`, API
  `settings/proxy/profiles/:name/*` и `POST settings/proxy/test` (target-check), UI-редактор
  профилей/правил и проверка цели, legacy-конвертация в `profiles.default`.
