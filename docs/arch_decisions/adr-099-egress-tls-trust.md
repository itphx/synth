# ADR-099: Единый egress-слой — доверие TLS/CA (mTLS) и адресная политика исходящих запросов

> **Статус:** ⚠️ Частично — реализовано: **(1) доверие TLS/CA** — секция `security.tls`
> (`caFile`/`caPem`/`certFile`/`keyFile`/`rejectUnauthorized`), единый транспорт
> (`buildTlsTrust`/`applyGlobalTlsTrust`/`egressFetch`, глобальный undici-dispatcher), перевод всех
> исходящих точек (провайдеры, MCP, webhooks, гибрид, инструкции/скиллы, `web_fetch`/`web_search`,
> update-checker, OIDC+JWKS, иконки провайдеров), git-CA (`http.sslCAInfo`), PostgreSQL
> `storage.postgres.sslmode` + запрет TLS-параметров в DSN; **(2) адресная политика** — `egress.tools`/
> `egress.webhooks` (`mode`/`list`/`exceptions`, `off` только у webhooks), `mcp.networkPolicy` в том же
> формате, live per-request, аудит изменений политики (`audit/security.jsonl`) и журнал внешних запросов
> (`audit/egress.jsonl`), удаление `webhooks.allowPrivateTargets`. **Остаток:** HTTP-прокси/`no_proxy`/
> аутентификация прокси (Basic/NTLM/Negotiate/Kerberos) и mTLS для прокси (бывшие
> [PROP-088](./prop-088-http-proxy.md)), пиннинг проверенного адреса к соединению
> ([PROP-100](./prop-100-ssrf-dns-rebinding.md)), метрики/наблюдаемость
> ([PROP-094](./prop-094-observability-metrics.md)), пересборка TLS-dispatcher без рестарта. Политика —
> **не граница безопасности**, когда доступны shell, `stdio`-MCP или внешние движки (см. «Последствия»).
> **Дата:** 2026-10-16 (адресная политика — 2026-10-17)
> **Обновлено:** 2026-10-17 — адресная egress-политика как часть того же слоя: `egress.tools`/
> `egress.webhooks`, `mcp.networkPolicy` с `exceptions`, live per-request, аудит изменений и журнал
> внешних запросов, удаление `webhooks.allowPrivateTargets`.
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
доверенные CA + аутентификация прокси/Kerberos). Прокси-часть требует внешних зависимостей и решения
по Kerberos/NTLM; доверие TLS/CA — самая востребованная часть, не требующая прокси-транспорта, поэтому
зафиксирована отдельным решением (этим ADR), а прокси-остаток остаётся в PROP-088.

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
6. **TLS-транспорт — стартовая конфигурация; адресная политика — runtime.** `security.tls` **не входит**
   в `RuntimeSettings`: dispatcher процесс-глобальный, изменения применяются при старте и требуют
   рестарта (hot-reload — остаток). Адресная политика (пункты 8–11) — наоборот, **live**: резолвится из
   стора на каждый исходящий запрос, рестарт не нужен.
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
15. **Правило при HTTP-прокси** (когда прокси появится, [PROP-088](./prop-088-http-proxy.md)). Если
    адрес резолвит прокси, адресная проверка на стороне Synth **отключается** (проверять нечего:
    соединение устанавливает прокси), hostname-правила (`list`/`exceptions` по имени) остаются;
    ответственность за адресную политику переходит на прокси и его allowlist. Правило фиксируется
    заранее, чтобы при включении прокси не возникло ложного ощущения защиты.

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

## Последствия

- (+) Единый источник доверия: корпоративные CA и mTLS работают во всех исходящих точках, включая
  git и PostgreSQL; поведение тестируемо (инъекция `fetchImpl`/`dispatcher`).
- (+) Fail-closed: неверная конфигурация не уводит канал молча на недоверенный транспорт; «забыли
  CA» ловится на старте, а не на первом запросе.
- (+) Адресная политика управляется одинаково для tools/webhooks/MCP и применяется live; аудит
  (`audit/security.jsonl`) отвечает «кто и что изменил», журнал (`audit/egress.jsonl`) — «куда ходили
  и что заблокировали» (без тел и заголовков).
- (−) Появилась прямая зависимость `undici@^7`; git-CA ограничен файлом (`caFile`).
- (−) Политика — **не граница безопасности**: при доступном `execute_shell`, `stdio`-MCP или внешних
  движках ([PROP-050](./prop-050-external-engines-runner.md)) исходящий трафик идёт мимо guard;
  пиннинга проверенного адреса нет (TOCTOU/DNS-rebinding — [PROP-100](./prop-100-ssrf-dns-rebinding.md));
  при прокси адресную проверку выполняет прокси (п. 15).
- (−) TLS инициализируется при старте (без hot-reload); HTTP-прокси, `no_proxy`, аутентификация
  прокси и Kerberos не покрыты — это отдельный остаток ([PROP-088](./prop-088-http-proxy.md)).

## Статус в коде

- **Конфиг/резолверы (shared):** `packages/shared/src/config/tls.ts` (`resolveTlsConfig`/`resolveTlsTrust`/`TLS_ENV`,
  `isPemContent`, PG-билдер `buildPostgresSslOptions`/`normalizePostgresSslMode`/`findDsnTlsParams`/`DSN_TLS_PARAMS`);
  схемы `securityTlsConfigSchema` и `storage.postgres.sslmode` (`packages/shared/src/config/types.ts`);
  env `SYNTH_POSTGRES_SSLMODE` (`packages/shared/src/config/resolve.ts`).
- **Транспорт доверия (core):** `packages/core/src/security/tls.ts` (`buildTlsTrust`,
  `applyGlobalTlsTrust` через `setGlobalDispatcher`, `egressFetch`, `initTlsTrust`, `gitCaConfig`/`getTlsCaPath`,
  `TlsDependencyUnavailableError`).
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
- **API:** секция egress в `packages/core/src/server/routes/settings.ts`
  (`/settings/egress/tools`, `/settings/egress/webhooks`, `POST /settings/egress/check`, расширенный
  `/settings/mcp-network-policy`), `packages/core/src/server/routes/audit.ts`
  (`GET /api/v2/audit/security`, `GET /api/v2/audit/egress`).
- **UI:** `components/settings/EgressPolicySection.tsx` — режим/список/исключения и «Проверить URL»;
  встроена в «Встроенные инструменты» (`ToolsDisabledSettings`), «Webhooks» (`WebhooksSettings`,
  `off` с предупреждением) и MCP (`NetworkPolicySection` — исключения и проверка); журналы —
  вкладки «Безопасность (политики)» и «Внешние запросы» в «Логах и аудите»
  (`SecurityAuditPanel`/`EgressLogPanel`); i18n `egress.*`/`logs.security.*`/`logs.egress.*` (ru/en).
- **git:** `packages/core/src/git/git-service.ts` — `simpleGit({ config: gitCaConfig() })` (`http.sslCAInfo`).
- **PostgreSQL:** `packages/storage-postgres/src/pool.ts` (`assertNoDsnTlsParams`, `buildPoolConfig` →
  `buildPostgresSslOptions`).
- **Деплой:** Helm `security.tls` (Secret с CA/клиентскими сертификатами, mount `/etc/synth/tls`; в
  ConfigMap только пути, `NODE_EXTRA_CA_CERTS` — для дочерних процессов); docker-compose (`SYNTH_TLS_*`).
- **Тесты:** `packages/shared/src/config/tls.test.ts`, `packages/core/src/security/tls.test.ts`,
  `packages/storage-postgres/src/pool-tls.test.ts`, `packages/core/src/git/git-ca.test.ts`,
  `packages/shared/src/config/resolve.test.ts`, `packages/core/src/engine/net/egress-guard.test.ts`
  (политика/журнал/аудит — тесты уровня подсистем); фикстуры — `packages/core/src/security/__fixtures__/`
  (self-signed, `TEST ONLY`).
- **Нет (остаток):** HTTP-прокси/`no_proxy`, аутентификация прокси (Basic/NTLM/Negotiate/Kerberos),
  mTLS для прокси, пересборка TLS-dispatcher без рестарта — [PROP-088](./prop-088-http-proxy.md);
  пиннинг адреса (TOCTOU) — [PROP-100](./prop-100-ssrf-dns-rebinding.md); метрики — [PROP-094](./prop-094-observability-metrics.md).

## История

- 2026-10-16 — ADR заведён: единый egress-слой доверия TLS/CA + mTLS (секция `security.tls`, общий
  транспорт `egressFetch`/`applyGlobalTlsTrust`, перевод всех исходящих точек, git-CA, PostgreSQL
  `sslmode` + запрет TLS-параметров в DSN); прокси-часть PROP-088 не вошла — заменён/надстроен.
- 2026-10-17 — ADR расширен адресной политикой исходящих запросов: `egress.tools`/`egress.webhooks`
  (единый формат `mode`/`list`/`exceptions`, `off` только у webhooks), `mcp.networkPolicy` в том же
  формате, независимые экземпляры, live per-request, аудит изменений и журнал внешних запросов,
  удаление `webhooks.allowPrivateTargets`, правило взаимодействия с прокси.
