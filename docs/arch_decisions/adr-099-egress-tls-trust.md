# ADR-099: Единый egress-слой — доверие TLS/CA (и mTLS) для исходящих соединений

> **Статус:** ⚠️ Частично — реализовано: секция `security.tls` (`caFile`/`caPem`/`certFile`/`keyFile`/`rejectUnauthorized`), единый транспорт доверия (`buildTlsTrust`/`applyGlobalTlsTrust`/`egressFetch`, глобальный undici-dispatcher), перевод всех исходящих точек (провайдеры, MCP, webhooks, гибрид, инструкции/скиллы, `web_fetch`/`web_search`, update-checker, OIDC+JWKS, иконки провайдеров), git-CA (`http.sslCAInfo`), PostgreSQL `storage.postgres.sslmode` + запрет TLS-параметров в DSN; остаток: HTTP-прокси/`no_proxy`/аутентификация прокси (Basic/NTLM/Negotiate/Kerberos) и mTLS для прокси (бывшие [PROP-088](./prop-088-http-proxy.md)), пересборка dispatcher без рестарта ([PROP-100](./prop-100-ssrf-dns-rebinding.md), [PROP-094](./prop-094-observability-metrics.md))
> **Дата:** 2026-10-16
> **Связано:** [PROP-088](./prop-088-http-proxy.md) (заменён/надстроен), [PROP-100](./prop-100-ssrf-dns-rebinding.md), [ADR-036](./adr-036-llm-gateway.md), [PROP-094](./prop-094-observability-metrics.md), [ADR-023](./adr-023-configuration.md), [ADR-076](./adr-076-git-repo-registry-ssh.md), [ADR-078](./adr-078-runtime-dependency-availability.md), [PROP-032](./prop-032-history-storage-postgresql.md); конфиг — [docs/CONFIGURATION.md](../CONFIGURATION.md).

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

## Решение

Ввести **единый источник доверия TLS/CA** для всех исходящих соединений Synth:

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
6. **TLS — стартовая конфигурация, не runtime-настройка.** `security.tls` **не входит** в
   `RuntimeSettings`; изменения применяются при старте и требуют рестарта.
7. **`NODE_EXTRA_CA_CERTS` — только совместимость**, не конфигурируемый механизм: он наследуется
   дочерними процессами (MCP stdio, git) и используется как провиз-совместимый слой в Helm, но
   управляемый источник доверия — `security.tls`.

## Альтернативы

- **`NODE_EXTRA_CA_CERTS` как основной механизм** — отклонён: процесс-глобальный, вне конфига
  (ADR-023), дочерние процессы/`git` видят его иначе; оставлен только для совместимости.
- **Свой агент/диспетчер в каждой подсистеме** — отклонён: дублирование и расхождение политики
  доверия; точечное `rejectUnauthorized: false` снова открывает MITM.
- **Отключение проверки по умолчанию** — отклонён (MITM); доступно явно (`rejectUnauthorized: false`).
- **Разрешить TLS-параметры в DSN PostgreSQL** — отклонён: `pg` молча применяет их поверх `ssl`.
- **Runtime-переключение TLS без рестарта** — отклонено осознанно: dispatcher — процесс-глобальный
  singleton, живая пересборка гонкоопасна (остаток).

## Последствия

- (+) Единый источник доверия: корпоративные CA и mTLS работают во всех исходящих точках, включая
  git и PostgreSQL; поведение тестируемо (инъекция `fetchImpl`/`dispatcher`).
- (+) Fail-closed: неверная конфигурация не уводит канал молча на недоверенный транспорт; «забыли
  CA» ловится на старте, а не на первом запросе.
- (−) TLS инициализируется при старте (без hot-reload); HTTP-прокси, `no_proxy`, аутентификация
  прокси и Kerberos не покрыты — это отдельный остаток ([PROP-088](./prop-088-http-proxy.md)).
- (−) Появилась прямая зависимость `undici@^7`; git-CA ограничен файлом (`caFile`).

## Статус в коде

- **Конфиг/резолверы (shared):** `packages/shared/src/config/tls.ts` (`resolveTlsConfig`/`resolveTlsTrust`/`TLS_ENV`,
  `isPemContent`, PG-билдер `buildPostgresSslOptions`/`normalizePostgresSslMode`/`findDsnTlsParams`/`DSN_TLS_PARAMS`);
  схемы `securityTlsConfigSchema` и `storage.postgres.sslmode` (`packages/shared/src/config/types.ts`);
  env `SYNTH_POSTGRES_SSLMODE` (`packages/shared/src/config/resolve.ts`).
- **Транспорт доверия (core):** `packages/core/src/security/tls.ts` (`buildTlsTrust`,
  `applyGlobalTlsTrust` через `setGlobalDispatcher`, `egressFetch`, `initTlsTrust`, `gitCaConfig`/`getTlsCaPath`,
  `TlsDependencyUnavailableError`).
- **Перевод исходящих точек:** `providers/{base,openai,anthropic,ollama,remote,decision}.ts`,
  `engine/mcp/client.ts`, `engine/webhooks/service.ts`, `engine/context/instructions.ts`,
  `engine/skills/remote.ts`, `engine/tools/web.ts`, `engine/net/egress-guard.ts` (иконки провайдеров
  `POST /api/v2/providers/fetch-icon`), `remote/{client,connection,device-flow}.ts`, `update-checker.ts`,
  `packages/backend/src/auth/oidc.ts` (дискавери/токен и JWKS через `customFetch`); инициализация —
  `main.ts`, `server/app.ts`, `backend/app/deps.ts`.
- **git:** `packages/core/src/git/git-service.ts` — `simpleGit({ config: gitCaConfig() })` (`http.sslCAInfo`).
- **PostgreSQL:** `packages/storage-postgres/src/pool.ts` (`assertNoDsnTlsParams`, `buildPoolConfig` →
  `buildPostgresSslOptions`).
- **Деплой:** Helm `security.tls` (Secret с CA/клиентскими сертификатами, mount `/etc/synth/tls`; в
  ConfigMap только пути, `NODE_EXTRA_CA_CERTS` — для дочерних процессов); docker-compose (`SYNTH_TLS_*`).
- **Тесты:** `packages/shared/src/config/tls.test.ts`, `packages/core/src/security/tls.test.ts`,
  `packages/storage-postgres/src/pool-tls.test.ts`, `packages/core/src/git/git-ca.test.ts`,
  `packages/shared/src/config/resolve.test.ts`; фикстуры — `packages/core/src/security/__fixtures__/`
  (self-signed, `TEST ONLY`).
- **Нет (остаток):** HTTP-прокси/`no_proxy`, аутентификация прокси (Basic/NTLM/Negotiate/Kerberos),
  mTLS для прокси, пересборка dispatcher без рестарта — [PROP-088](./prop-088-http-proxy.md).

## История

- 2026-10-16 — ADR заведён: единый egress-слой доверия TLS/CA + mTLS (секция `security.tls`, общий
  транспорт `egressFetch`/`applyGlobalTlsTrust`, перевод всех исходящих точек, git-CA, PostgreSQL
  `sslmode` + запрет TLS-параметров в DSN); прокси-часть PROP-088 не вошла — заменён/надстроен.
