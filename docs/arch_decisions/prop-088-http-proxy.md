# PROP-088: Работа через HTTP-прокси (единый egress-слой, включая аутентификацию и Kerberos)

> **Статус:** ⛔ Заменено — TLS/CA- и mTLS-часть надстроена [ADR-099](./adr-099-egress-tls-trust.md) (единый egress-слой доверия); ниже сохранён **нереализованный остаток** — HTTP-прокси/`no_proxy`/аутентификация прокси (Basic/NTLM/Negotiate/Kerberos), mTLS для прокси, пересборка dispatcher без рестарта.
> **Заменено/надстроено:** [ADR-099](./adr-099-egress-tls-trust.md) (2026-10-16) — решение о доверии TLS/CA перенесено туда; файл оставлен как живой остаток по HTTP-прокси (номер и файл стабильны, [ARCH_DECISIONS.md](../ARCH_DECISIONS.md) §3).
> **Дата:** 2026-10-01
> **Источник:** перенесено из `AD-DRAFTS.md` (D25); **перенумеровано с PROP-083** — номер PROP-083 занят брендингом ([PROP-083](./prop-083-instance-customization-branding.md)).
> **Связано:** [ADR-099](./adr-099-egress-tls-trust.md), [ADR-023](./adr-023-configuration.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-076](./adr-076-git-repo-registry-ssh.md),
> [ADR-071](./adr-071-mcp-servers-prompt.md), [ADR-042](./adr-042-hybrid-mode.md), [PROP-050](./prop-050-external-engines-runner.md),
> [PROP-055](./prop-055-instance-exchange.md), [PROP-056](./prop-056-synth-mcp-server.md), [ADR-041](./adr-041-llm-error-taxonomy.md).

## Замена (ADR-099)

Замысел «единый egress-слой» **разделён на две части**:

- **Реализовано — доверие TLS/CA + mTLS** → [ADR-099](./adr-099-egress-tls-trust.md): секция
  `security.tls`, общий транспорт (`egressFetch`/`applyGlobalTlsTrust`/`egress-guard`), перевод всех
  исходящих точек, git-CA, PostgreSQL `sslmode` + запрет TLS-параметров в DSN. Здесь это больше
  **не проектируется**.
- **Остаётся предложением — HTTP-прокси** (этот файл): `proxy.url`/`httpProxy`/`httpsProxy`/`allProxy` +
  `no_proxy`, аутентификация на прокси (Basic/NTLM/Negotiate/Kerberos), mTLS для прокси, пересборка
  dispatcher без рестарта. Эти пункты в ADR-099 **не вошли** и сохранены в теле ниже как остаток.

**Решение (остаток):** ввести в Synth единый сетевой **egress-слой**: настройка исходящего HTTP/HTTPS-прокси (и, возможно,
SOCKS), `no_proxy`/списки исключений, доверенные CA-сертификаты, а аутентификация на прокси — Basic/NTLM/Negotiate
(**Kerberos**). Все исходящие HTTP(S)-вызовы — провайдеры LLM, MCP HTTP-транспорт, `web_fetch`/`web_search`,
HTTPS-git, OIDC-дискавери, гибридный обмен — идут через **общий dispatcher/agent**, а не через «сырой» `fetch`
в каждой точке.

## Контекст

### Зачем это нужно

Корпоративные инсталляции (managed/hybrid) и защищённые сети часто не имеют прямого egress: выход в интернет —
только через HTTP/HTTPS-прокси, нередко с обязательной аутентификацией на прокси (доменный Kerberos/NTLM) и с
корпоративными/self-signed CA. Без поддержки прокси Synth не может достучаться до LLM-провайдеров, MCP-серверов,
веб-поиска, HTTPS-git и удалённого backend — то есть теряет работоспособность в такой среде.

### Практическое подтверждение: `synth-media`

Это не гипотетический сценарий. Прокси уже реально понадобился в родственном репозитории **`synth-media`**
(`git.itphx.ru:itphx/synth-media`): Telegram Bot API доступен только через прокси, и там сделан **частный случай**
этого AD — `createProxyAgent` в `packages/telegram/src/transport.ts` (SOCKS — `SocksProxyAgent`, `http(s)://` —
`HttpsProxyAgent` с CONNECT-туннелем; зависимости `socks-proxy-agent@^10`/`https-proxy-agent@^9`). Приоритет
источника прокси там: `TELEGRAM_PROXY_URL → ALL_PROXY → HTTPS_PROXY → HTTP_PROXY` → файл `secrets/telegram_proxy_url`
(`apps/telegram-mcp/src/config.ts`). Это доказывает необходимость **общего** механизма Synth: иначе прокси-логика
дублируется и расползается по подсистемам по отдельности.

### Проблема сегодня

Единого сетевого слоя нет: нативный `fetch` (undici) вызывается точечно, каждая точка сама решает, как ходить
в сеть. Добавление прокси/CA сейчас потребовало бы правок в каждой точке.

## Детали

### Область покрытия (egress-точки)

| Точка | Где | Природа |
|---|---|---|
| Провайдеры LLM | `packages/core/src/providers/{openai,anthropic,ollama,base,remote}.ts` | `fetch` |
| Веб-тулы | `packages/core/src/engine/tools/web.ts` (`web_fetch`, `web_search`) | `fetch` |
| MCP HTTP/SSE | `packages/core/src/engine/mcp/client.ts` (`StreamableHTTPClientTransport`) | SDK/`fetch` |
| HTTPS-git | `packages/core/src/git/*` (`simple-git`, ADR-076) | git (`http.proxy`/env) |
| OIDC-дискавери | `packages/backend/src/auth/oidc.ts` | `fetch` |
| Гибридный обмен | `packages/core/src/remote/client.ts`, `providers/remote.ts` | `fetch` |
| MCP stdio | дочерний процесс | наследует окружение процесса |

### Единый dispatcher/agent

Предлагается общий модуль (placeholder — `packages/core/src/network/`), который по конфигу создаёт
`undici`-`Agent`/`Dispatcher` (или `ProxyAgent`) и отдаёт его всем egress-точкам. Прямые вызовы «сырого» `fetch`
заменяются единым хелпером (placeholder — `egressFetch(url, init)`), чтобы прокси/CA/таймауты применялись в одном
месте. Это согласуется с инвариантом «новых каналов не плодить»: одна точка настройки, а не N копий.

### Конфигурация (ADR-023)

Новая секция `network`/`proxy` в `@itphx/synth-shared/config`:

- `proxy.url` (или разрез `httpProxy`/`httpsProxy`/`allProxy` + `noProxy`);
- источник credentials прокси — **ссылка на секрет**, а не значение в конфиге;
- CA: `caFile`/CA-bundle и `rejectUnauthorized`;
- таймауты подключения.

Приоритет — по общему правилу ADR-023 (CLI-флаги > `SYNTH_*` env > config.yaml > defaults); конкретный состав
env-резолвера (`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY`/`NODE_EXTRA_CA_CERTS`) и его соотношение с
runtime-настройкой — в открытых вопросах.

### Аутентификация на прокси

- **Basic** — тривиально.
- **NTLM/Negotiate (Kerberos)** — в Node нет нативного GSSAPI. Варианты: нативная зависимость (напр. `kerberos`),
  внешний SPNEGO-helper, либо на первом этапе только Basic+NTLM.

### Секреты и безопасность

Прокси-credentials хранятся как секреты at-rest по [ADR-076](./adr-076-git-repo-registry-ssh.md) (AES-256-GCM,
мастер-ключ), наружу не отдаются и **не логируются**; guard/обфускация/аудит — через [ADR-036](./adr-036-llm-gateway.md).

### API и UI

Настройка прокси и **healthcheck** («проверить соединение») через API; панель настроек — по образцу
[ADR-072](./adr-072-settings-ui-kit.md). Ошибки подключения — через ключи i18n ([ADR-041](./adr-041-llm-error-taxonomy.md)).

## Статус реализации в коде

**Разделено (см. «Замена»).** Доверие TLS/CA + mTLS **реализовано** в [ADR-099](./adr-099-egress-tls-trust.md)
(секция `security.tls`, общий транспорт `egressFetch`/`applyGlobalTlsTrust`, прямая зависимость `undici@^7`,
env `SYNTH_TLS_*`). Ниже — остаток, относящийся **только к HTTP-прокси**; он **не реализован**:

- HTTP-прокси, аутентификация на прокси (Basic/NTLM/Negotiate/Kerberos), mTLS для прокси — нет;
  прямых зависимостей `proxy-agent`/`https-proxy-agent`/`socks-proxy-agent`/`axios` нет.
- Env `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` **не читается**. (`NODE_EXTRA_CA_CERTS` в
  Helm-чарте пробрасывается дочерним процессам как слой совместимости — ADR-099 §7; `SYNTH_TLS_*` —
  доверие CA, а не прокси.)
- В `packages/shared/src/config/types.ts` секции `network`/`proxy` нет. Есть только:
  - `runner.proxyPort` (дефолт 9090, `types.ts:87`, `defaults.ts:40`) — **внутренний LLM Proxy раннера**
    (план: [PROP-050](./prop-050-external-engines-runner.md)), не HTTP-прокси;
  - `mcp.networkPolicy` (ADR-071 §2.3.1, `types.ts:158`) — политика сетевого доступа MCP-серверов
    (SSRF/приватные CIDR), тоже **не egress-прокси**.
- Частный случай уже реализован **вне** `synth/` — в репозитории `synth-media` (см. «Практическое подтверждение»).

## Открытые вопросы

- Приоритет источника: env (`HTTPS_PROXY`) vs `config.yaml` vs runtime-настройка (по аналогии с ADR-023)?
- Kerberos: нативная зависимость (`kerberos`) / внешний SPNEGO-helper / только Basic+NTLM на первом этапе?
- SOCKS5 нужен и на каком этапе?
- MCP stdio-серверы ходят в сеть сами (дочерний процесс) — вне зоны контроля Node? Проксировать через окружение процесса?
- ~CA/self-signed: единый bypass для LLM/MCP/веба и как он согласуется с guard [ADR-036](./adr-036-llm-gateway.md)?~ — **снят**: доверие TLS/CA (и mTLS) решено в [ADR-099](./adr-099-egress-tls-trust.md) (секция `security.tls`, общий транспорт).
- Прокси один общий или per-provider/per-service?
- Как egress-прокси взаимодействует с `mcp.networkPolicy` ([ADR-071](./adr-071-mcp-servers-prompt.md)) и политиками гибрида ([ADR-042](./adr-042-hybrid-mode.md))?
- Как пробрасывать прокси во внешние движки/runner ([PROP-050](./prop-050-external-engines-runner.md)) — env при спавне?

## Связи

- [ADR-023](./adr-023-configuration.md) «Конфигурация» — секция `network`/`proxy`, приоритеты источников.
- [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — guard/обфускация/аудит; прокси-credentials не утекают в логи.
- [ADR-076](./adr-076-git-repo-registry-ssh.md) «Git-репозитории и SSH-ключи» — хранилище секретов at-rest (мастер-ключ) для прокси-credentials.
- [ADR-071](./adr-071-mcp-servers-prompt.md) «MCP-серверы в промпте» — сетевой доступ и HTTP-транспорт MCP.
- [ADR-042](./adr-042-hybrid-mode.md) «Гибридный режим» — egress к удалённому backend.
- [PROP-050](./prop-050-external-engines-runner.md) «Внешние движки — Runner» — проброс прокси в движки.
- [PROP-055](./prop-055-instance-exchange.md) «Обмен между инстансами», [PROP-056](./prop-056-synth-mcp-server.md) «MCP-сервер Synth» — соседние egress-потребители.
- [ADR-041](./adr-041-llm-error-taxonomy.md) «Ошибки LLM/i18n» — ключи ошибок прокси (healthcheck/подключение).
- `synth-media` (`git.itphx.ru:itphx/synth-media`) — частный случай/подтверждение необходимости (Telegram через SOCKS/HTTP-прокси).

## История

- 2026-10-16 — статус переведён в `⛔ Заменено`: TLS/CA- и mTLS-часть надстроена [ADR-099](./adr-099-egress-tls-trust.md); HTTP-прокси/`no_proxy`/аутентификация прокси/Kerberos остаются предложением (остаток сохранён в теле).
