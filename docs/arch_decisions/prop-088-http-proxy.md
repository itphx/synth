# PROP-088: Работа через HTTP-прокси (единый egress-слой, включая аутентификацию и Kerberos)

> **Статус:** ⛔ Заменено — TLS/CA, mTLS, адресная политика и **HTTP/HTTPS/SOCKS5-прокси (D1+D2 + runtime-UI)**
> надстроены [ADR-099](./adr-099-egress-tls-trust.md) (единый egress-слой). Доменная аутентификация
> **NTLM/Negotiate/Kerberos не реализуется в приложении** (2026-10-18, ADR-099 п. 25): делегируется
> промежуточному egress-прокси/шлюзу (Squid `login=NEGOTIATE`, px для NTLM/PAC); SOCKS5 — **best-effort**
> (ADR-099 п. 26); остаток — только runtime-reload прокси/TLS без рестарта.
> **Заменено/надстроено:** [ADR-099](./adr-099-egress-tls-trust.md) (2026-10-16; адресная политика —
> 2026-10-17; прокси D1+D2 — 2026-10-17; runtime-UI — 2026-10-18; доменная аутентификация вне scope —
> 2026-10-18) — решения о доверии TLS/CA, адресной политике и прокси перенесены туда; файл оставлен для
> трассируемости, функционального остатка по доменной аутентификации нет (номер и файл стабильны,
> [ARCH_DECISIONS.md](../ARCH_DECISIONS.md) §3).
> **Дата:** 2026-10-01
> **Источник:** перенесено из `AD-DRAFTS.md` (D25); **перенумеровано с PROP-083** — номер PROP-083 занят брендингом ([PROP-083](./prop-083-instance-customization-branding.md)).
> **Связано:** [ADR-099](./adr-099-egress-tls-trust.md), [ADR-023](./adr-023-configuration.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-076](./adr-076-git-repo-registry-ssh.md),
> [ADR-071](./adr-071-mcp-servers-prompt.md), [ADR-042](./adr-042-hybrid-mode.md), [PROP-050](./prop-050-external-engines-runner.md),
> [PROP-055](./prop-055-instance-exchange.md), [PROP-056](./prop-056-synth-mcp-server.md), [ADR-041](./adr-041-llm-error-taxonomy.md).

## Замена (ADR-099)

Замысел «единый egress-слой» **разделён на четыре части**:

- **Реализовано — доверие TLS/CA + mTLS** → [ADR-099](./adr-099-egress-tls-trust.md). Здесь это больше
  **не проектируется** и не дублируется: состав секции `security.tls`, транспорт и запрет TLS-параметров
  в DSN — по ADR-099.
- **Реализовано — адресная политика (SSRF/allow-list)** → тот же [ADR-099](./adr-099-egress-tls-trust.md)
  (пункты 8–15): `egress.tools`, `egress.webhooks`, `mcp.networkPolicy` с `exceptions`, live per-request,
  аудит изменений и журнал внешних запросов ([docs/CONFIGURATION.md](../CONFIGURATION.md)).
- **Реализовано — HTTP/HTTPS/SOCKS5-прокси (D1+D2 + runtime-UI)** →
  [ADR-099](./adr-099-egress-tls-trust.md) (пункты 16–21): секция `proxy`, `EgressDispatcher` с
  per-origin маршрутом direct/proxy, `noProxy`, Basic и TLS/mTLS к https-прокси, proxied-режим адресной
  политики, git/MCP через env; runtime-override из админ-UI (`RuntimeSettings.proxy`, применение при
  старте, `restartRequired`, write-only пароль, аудит `scope:'proxy'`), API `settings/proxy*`.
- **Вне scope — доменная аутентификация** (этот файл): **NTLM/Negotiate/Kerberos не реализуются в
  приложении**, делегируются egress-шлюзу ([ADR-099](./adr-099-egress-tls-trust.md) п. 25). **Остаётся
  предложением:** только runtime-reload прокси/TLS без рестарта.

**Решение:** в приложении доменную аутентификацию прокси **не поддерживать**; использовать промежуточный
egress-прокси/шлюз (Squid `cache_peer … login=NEGOTIATE`, `px` для NTLM/PAC), который ходит в корпоративный
прокси по Kerberos/NTLM, а Synth — в шлюз по HTTP CONNECT (Basic/mTLS/без auth). SOCKS5 — best-effort
(не целевой для K8s). Все исходящие HTTP(S)-вызовы уже идут через **общий dispatcher** (`EgressDispatcher`),
поэтому приложение не меняется — меняется топология egress.

## Контекст

### Зачем это нужно

Корпоративные инсталляции (managed/hybrid) и защищённые сети часто не имеют прямого egress: выход в интернет —
только через HTTP/HTTPS-прокси, нередко с обязательной аутентификацией на прокси (доменный Kerberos/NTLM) и с
корпоративными/self-signed CA. Без поддержки прокси Synth не может достучаться до LLM-провайдеров, MCP-серверов,
веб-поиска, HTTPS-git и удалённого backend — то есть теряет работоспособность в такой среде. Транспорт через
прокси (Basic, TLS/mTLS к прокси) уже реализован ([ADR-099](./adr-099-egress-tls-trust.md)); здесь остаётся
**доменная аутентификация**.

### Практическое подтверждение: `synth-media`

Это не гипотетический сценарий. Прокси уже реально понадобился в родственном репозитории **`synth-media`**
(`git.itphx.ru:itphx/synth-media`): Telegram Bot API доступен только через прокси, и там сделан **частный случай**
этого AD — `createProxyAgent` в `packages/telegram/src/transport.ts` (SOCKS — `SocksProxyAgent`, `http(s)://` —
`HttpsProxyAgent` с CONNECT-туннелем; зависимости `socks-proxy-agent@^10`/`https-proxy-agent@^9`). Приоритет
источника прокси там: `TELEGRAM_PROXY_URL → ALL_PROXY → HTTPS_PROXY → HTTP_PROXY` → файл `secrets/telegram_proxy_url`
(`apps/telegram-mcp/src/config.ts`). Это доказывает необходимость **общего** механизма Synth: иначе прокси-логика
дублируется и расползается по подсистемам по отдельности.

### Проблема сегодня

Прокси-слой реализован: единый `EgressDispatcher` выбирает маршрут per-origin, соблюдает `noProxy`, умеет
Basic и TLS/mTLS к https-прокси, SOCKS5 (best-effort). Доменная аутентификация прокси **осознанно
делегируется egress-шлюзу** ([ADR-099](./adr-099-egress-tls-trust.md) п. 25): `undici.ProxyAgent` не
выполняет 407-challenge, а собственная реализация Kerberos/NTLM неприемлема по стоимости и blast radius.

## Детали

### Область покрытия (egress-точки)

| Точка | Где | Природа |
|---|---|---|
| Провайдеры LLM | `packages/core/src/providers/{openai,anthropic,ollama,base,remote}.ts` | `fetch` (`egressFetch` → `EgressDispatcher`) |
| Веб-тулы | `packages/core/src/engine/tools/web.ts` (`web_fetch`, `web_search`) | `fetch` |
| MCP HTTP/SSE | `packages/core/src/engine/mcp/client.ts` (`StreamableHTTPClientTransport`) | SDK/`fetch` |
| HTTPS-git | `packages/core/src/git/*` (`simple-git`, ADR-076) | git child-env (`http_proxy`/…, libcurl) |
| OIDC-дискавери | `packages/backend/src/auth/oidc.ts` | `fetch` |
| Гибридный обмен | `packages/core/src/remote/client.ts`, `providers/remote.ts` | `fetch` |
| MCP stdio | дочерний процесс (`engine/mcp/client.ts`) | env `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` |

### Единый dispatcher/agent

Сделано: `EgressDispatcher` (`packages/core/src/security/proxy-dispatcher.ts`) — `undici.Dispatcher`, который
на каждый запрос выбирает `ProxyAgent`/`Socks5ProxyAgent` или прямой `Agent` (по `noProxy`), передаёт TLS к
цели (`requestTls` из `security.tls`) и TLS/mTLS к прокси (`proxyTls`), а при недоступности прокси падает
fail-closed (`EGRESS_PROXY_UNAVAILABLE`). Точки ходят через `egressFetch`, поэтому прокси/CA/таймауты
применяются в одном месте — «новых каналов» нет.

### Конфигурация (ADR-023)

Сделано: top-level секция `proxy` в `@itphx/synth-shared/config`:

- `url` / `httpProxy` / `httpsProxy` / `allProxy` (выбор по схеме цели), `noProxy[]`, `enabled`, `fromEnv`,
  `fallbackDirect`, `connectTimeoutMs`;
- аутентификация: `auth {type: 'basic', username}`; пароль — только `SYNTH_PROXY_PASSWORD` или файл
  `{dataDir}/secrets/proxy-password`;
- `tls` (CA/mTLS к https-прокси) — по образцу `security.tls`.

Доверие TLS/CA **к цели** и адресная политика — не здесь: единый источник — `security.tls` и
`egress.*`/`mcp.networkPolicy` ([ADR-099](./adr-099-egress-tls-trust.md)).

Приоритет — `SYNTH_PROXY_*` > `config.proxy` > стандартные `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`
(при `fromEnv`) > defaults (ADR-023). Явный `enabled: false` подавляет стандартные env.

### Аутентификация на прокси

- **Basic — реализовано (D2a):** `Proxy-Authorization` передаётся `token`'ом в первом CONNECT; `407` →
  `EGRESS_PROXY_AUTH_REQUIRED`/`EGRESS_PROXY_AUTH_FAILED` без direct-фоллбека. Пароль не логируется.
- **NTLM/Negotiate (Kerberos) — не реализуется (вне scope, ADR-099 п. 25):** `auth.type` ≠ `basic` → 400
  при сохранении из UI / `EGRESS_PROXY_CONFIG_INVALID` на старте. Используйте промежуточный
  egress-прокси/шлюз: Squid с `cache_peer … login=NEGOTIATE` (Kerberos) либо `px` (NTLM/Negotiate/PAC).

### Секреты и безопасность

Пароль Basic — только env `SYNTH_PROXY_PASSWORD` или файл `{dataDir}/secrets/proxy-password` (в config.yaml не
хранится, инвариант 13); userinfo в URL извлекается в память и вырезается из конфига, логов и статуса
(`redactProxyUrl`). Креды в журнал/аудит не попадают; guard/обфускация/аудит LLM — по
[ADR-036](./adr-036-llm-gateway.md).

### API и UI

Сделано:

- `GET /api/v2/settings/proxy` — `saved`/`running`/`defaults`, `isOverridden`, `password`
  (`{source, set, removable}`, без значения), `restartRequired`; плоские поля = `saved`, URL redacted.
- `PUT/DELETE /api/v2/settings/proxy` — сохранить/сбросить runtime-override (валидация; live не
  применяет; аудит `scope:'proxy'`); `PUT/DELETE /api/v2/settings/proxy/password` — файл
  `secrets/proxy-password` (при `SYNTH_PROXY_PASSWORD` → 409 `CONFLICT`).
- `POST /api/v2/settings/proxy/check` — проверка только коннекта к прокси (`authChallenge`, `latencyMs`);
  без `url` проверяется **saved**-конфигурация (`usingSaved: true`).
- Раздел «Сеть» → «Прокси» (админка) — редактируемая форма (URL-поля, `noProxy`, `fromEnv`,
  `fallbackDirect`, таймаут, Basic-username, TLS-пути), write-only пароль, статус saved/running,
  плашка рестарта, «Проверить соединение».

Ошибки — ключи i18n ([ADR-041](./adr-041-llm-error-taxonomy.md)).

## Статус реализации в коде

Транспорт, конфиг, API и UI **реализованы** ([ADR-099](./adr-099-egress-tls-trust.md) пункты 16–20):

- `packages/shared/src/config/proxy.ts` — резолвер/env/валидация, `NoProxyMatcher`, `proxyEntryFor`,
  `proxyStatus`, `resolveProxyTls`; схемы — `packages/shared/src/config/types.ts`.
- `packages/core/src/security/proxy-{state,dispatcher,check}.ts`; интеграция — `security/tls.ts`
  (`initTlsTrust`), `engine/net/egress-guard.ts` (proxied-режим, `via`).
- `packages/core/src/git/git-service.ts` — `gitProxyEnv()` (child-env, Basic в userinfo, `no_proxy` через
  libcurl); `packages/core/src/engine/mcp/client.ts` — `mcpProxyEnv()` (+ `NODE_EXTRA_CA_CERTS`).
- Runtime-override — `RuntimeSettings.proxy` (`storage/runtime-settings.ts`), порт
  `getProxySettings/setProxySettings/clearProxySettings`, file/memory/PG, `storage migrate`;
  применение — `security/proxy-startup.ts` (`applyStartupProxyConfig`) в `server/app.ts` и
  `backend/app/deps.ts`.
- API — `packages/core/src/server/routes/settings.ts`; UI — `ProxyStatusSection.tsx`, `lib/api/proxy.ts`.
- Тесты: `proxy-dispatcher.test.ts` (fake HTTP/HTTPS-прокси, Basic/mTLS), `proxy-check.test.ts`,
  `proxy-optin.test.ts` (opt-in против реального прокси, 2/2), `proxy-startup.test.ts`,
  `settings-proxy.test.ts` (saved/running/`restartRequired`, пароль 409/0600), `fake-socks5-proxy.ts`,
  `git-proxy-env.test.ts`, `shared/src/config/proxy.test.ts`.

**Остаток / известные ограничения:**

- **NTLM/Negotiate/Kerberos — вне scope** (делегировано egress-шлюзу, ADR-099 п. 25): это не
  функциональная дыра, а принятое ограничение приложения; `auth.type` кроме `basic` → 400 при сохранении.
- **Runtime-reload без рестарта** — нет: UI сохраняет override, но dispatcher пересобирается только при
  старте (`restartRequired`).
- **SOCKS5 + https-цель:** `Socks5ProxyAgent` (undici 7.26) не принимает `requestTls` → CA/mTLS к цели из
  `security.tls` через SOCKS **не применяется** (только системное доверие).
- **https-прокси/SOCKS по IP-литералу:** SNI/`servername` = IP запрещён в Node — нужен DNS-хост; при этом
  `proxy/check` может показать `reachable` (проба не ставит `servername` для IP).
- **Прокси — start-only**, как TLS; runtime-reload нет.
- **Встроенный глобальный `fetch`:** spike на Node 26 показал, что npm-`setGlobalDispatcher` не влияет на
  встроенный fetch; гарантированно покрыты пути через `egressFetch` (все защищённые). На Node 22 (CI) —
  перепроверить.
- **PostgreSQL не проксируется** (не HTTP); **git** — `no_proxy` на стороне libcurl, per-remote настройки нет;
  **MCP stdio** получает прокси-env без пароля.
- **SOCKS5/SOCKS5H** в undici экспериментальные, оба резолвят hostname на прокси; `proxy.tls` с socks5
  несовместим (ошибка конфигурации).

## Открытые вопросы

Решённые при реализации D1+D2:

- ~~Приоритет источника~~ — `SYNTH_PROXY_*` > `config.proxy` > стандартные env (при `fromEnv`) > defaults;
  явный `enabled:false` подавляет env.
- ~~SOCKS5~~ — реализован (`Socks5ProxyAgent`, RFC 1929); остаточное ограничение — `requestTls`.
- ~~MCP stdio~~ — дочерний процесс получает `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` (+
  `NODE_EXTRA_CA_CERTS`), без пароля.
- ~~Единый или per-provider~~ — один общий прокси на инстанс (per-origin только выбор
  `httpsProxy`/`httpProxy`/`allProxy`); per-service — не делаем.
- ~~CA/self-signed~~ — решено в [ADR-099](./adr-099-egress-tls-trust.md) (`security.tls`, `proxy.tls`).

Остаётся:

- **Egress gateway (Squid/px):** рекомендация, не код Synth — нужны ли примеры манифестов/чарта
  (Squid `login=NEGOTIATE`, keytab Secret, `krb5.conf`, NetworkPolicy; px для NTLM/PAC) в поставке?
- **Runtime-reload прокси/TLS:** допустима ли пересборка `EgressDispatcher` без рестарта (гонки
  процесс-глобального dispatcher'а) или оставляем start-only? Сейчас — start-only, UI-оверрайд
  применяется при следующем старте (`restartRequired`).
- **Прокси и адресная политика:** правило зафиксировано в [ADR-099](./adr-099-egress-tls-trust.md) п. 15/18
  и реализовано (`proxied`/`addressChecksActive`, `via`); открыто — как это показывать в UI политики и как
  сочетать с политиками гибрида ([ADR-042](./adr-042-hybrid-mode.md)).
- **Проброс прокси во внешние движки/runner** ([PROP-050](./prop-050-external-engines-runner.md)) — env при
  спавне?

## Связи

- [ADR-023](./adr-023-configuration.md) «Конфигурация» — секция `proxy`, приоритеты источников.
- [ADR-099](./adr-099-egress-tls-trust.md) «Единый egress-слой» — доверие TLS/CA (mTLS), адресная политика
  (`egress.*`, `mcp.networkPolicy`), прокси (`proxy.*`, `EgressDispatcher`), аудит и журнал.
- [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — guard/обфускация/аудит; прокси-credentials не утекают в логи.
- [ADR-076](./adr-076-git-repo-registry-ssh.md) «Git-репозитории и SSH-ключи» — Git-канал и env-прокси.
- [ADR-071](./adr-071-mcp-servers-prompt.md) «MCP-серверы в промпте» §2.3.1 — сетевой доступ MCP (отдельный ключ `mcp.networkPolicy`), HTTP-транспорт и proxied-семантика.
- [ADR-042](./adr-042-hybrid-mode.md) «Гибридный режим» — egress к удалённому backend.
- [PROP-050](./prop-050-external-engines-runner.md) «Внешние движки — Runner» — проброс прокси в движки.
- [PROP-055](./prop-055-instance-exchange.md) «Обмен между инстансами», [PROP-056](./prop-056-synth-mcp-server.md) «MCP-сервер Synth» — соседние egress-потребители.
- [ADR-041](./adr-041-llm-error-taxonomy.md) «Ошибки LLM/i18n» — ключи ошибок прокси (healthcheck/подключение).
- `synth-media` (`git.itphx.ru:itphx/synth-media`) — частный случай/подтверждение необходимости (Telegram через SOCKS/HTTP-прокси).

## История

- 2026-10-16 — статус переведён в `⛔ Заменено`: TLS/CA- и mTLS-часть надстроена [ADR-099](./adr-099-egress-tls-trust.md); HTTP-прокси/`no_proxy`/аутентификация прокси/Kerberos остаются предложением (остаток сохранён в теле).
- 2026-10-17 — адресная политика (SSRF/allow-list) также вынесена в [ADR-099](./adr-099-egress-tls-trust.md)
  (`egress.*`/`mcp.networkPolicy`); дубли CA/mTLS убраны, вопрос про `mcp.networkPolicy` снят (ключ остаётся
  отдельным, формат общий), правило при прокси зафиксировано в ADR-099 п. 15.
- 2026-10-17 — прокси реализован (D1+D2: HTTP/HTTPS/SOCKS5, Basic, TLS/mTLS к прокси, `no_proxy`, git/MCP env,
  API/UI); остаток сужен до NTLM/Negotiate/Kerberos и runtime-reload; открытые вопросы по приоритету/env,
  SOCKS5, MCP stdio и per-service закрыты.
- 2026-10-18 — прокси настраивается из админ-UI (runtime-override в сторе, API `GET/PUT/DELETE
  /settings/proxy`, `/password`, `check` по saved, аудит `scope:'proxy'`); «API и UI» закрыт, остаток —
  NTLM/Negotiate/Kerberos, runtime-reload и `security.tls` через SOCKS5.
- 2026-10-18 — **принято решение**: доменная аутентификация прокси (NTLM/Negotiate/Kerberos) не
  реализуется в приложении и делегируется промежуточному egress-прокси/шлюзу (Squid/px), ADR-099 п. 25;
  SOCKS5 — best-effort (п. 26); функционального остатка по доменной аутентификации нет.
