# AD-088: Работа через HTTP-прокси (единый egress-слой, включая аутентификацию и Kerberos)

> **Статус:** 🧩 Предложение — Единый egress-слой: HTTP-прокси, `no_proxy`/исключения, доверенные CA, Basic/NTLM/Negotiate (Kerberos)
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-01
> **Источник:** перенесено из `AD-DRAFTS.md` (D25); **перенумеровано с AD-083** — номер AD-083 занят брендингом ([AD-083](./ad-083-instance-customization-branding.md)).
> **Связано:** [AD-023](./ad-023-configuration.md), [AD-036](./ad-036-llm-gateway.md), [AD-076](./ad-076-git-repo-registry-ssh.md),
> [AD-071](./ad-071-mcp-servers-prompt.md), [AD-042](./ad-042-hybrid-mode.md), [AD-050](./ad-050-external-engines-runner.md),
> [AD-055](./ad-055-instance-exchange.md), [AD-056](./ad-056-synth-mcp-server.md), [AD-041](./ad-041-llm-error-taxonomy.md).

**Решение:** ввести в Synth единый сетевой **egress-слой**: настройка исходящего HTTP/HTTPS-прокси (и, возможно,
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
| HTTPS-git | `packages/core/src/git/*` (`simple-git`, AD-076) | git (`http.proxy`/env) |
| OIDC-дискавери | `packages/backend/src/auth/oidc.ts` | `fetch` |
| Гибридный обмен | `packages/core/src/remote/client.ts`, `providers/remote.ts` | `fetch` |
| MCP stdio | дочерний процесс | наследует окружение процесса |

### Единый dispatcher/agent

Предлагается общий модуль (placeholder — `packages/core/src/network/`), который по конфигу создаёт
`undici`-`Agent`/`Dispatcher` (или `ProxyAgent`) и отдаёт его всем egress-точкам. Прямые вызовы «сырого» `fetch`
заменяются единым хелпером (placeholder — `egressFetch(url, init)`), чтобы прокси/CA/таймауты применялись в одном
месте. Это согласуется с инвариантом «новых каналов не плодить»: одна точка настройки, а не N копий.

### Конфигурация (AD-023)

Новая секция `network`/`proxy` в `@itphx/synth-shared/config`:

- `proxy.url` (или разрез `httpProxy`/`httpsProxy`/`allProxy` + `noProxy`);
- источник credentials прокси — **ссылка на секрет**, а не значение в конфиге;
- CA: `caFile`/CA-bundle и `rejectUnauthorized`;
- таймауты подключения.

Приоритет — по общему правилу AD-023 (CLI-флаги > `SYNTH_*` env > config.yaml > defaults); конкретный состав
env-резолвера (`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY`/`NODE_EXTRA_CA_CERTS`) и его соотношение с
runtime-настройкой — в открытых вопросах.

### Аутентификация на прокси

- **Basic** — тривиально.
- **NTLM/Negotiate (Kerberos)** — в Node нет нативного GSSAPI. Варианты: нативная зависимость (напр. `kerberos`),
  внешний SPNEGO-helper, либо на первом этапе только Basic+NTLM.

### Секреты и безопасность

Прокси-credentials хранятся как секреты at-rest по [AD-076](./ad-076-git-repo-registry-ssh.md) (AES-256-GCM,
мастер-ключ), наружу не отдаются и **не логируются**; guard/обфускация/аудит — через [AD-036](./ad-036-llm-gateway.md).

### API и UI

Настройка прокси и **healthcheck** («проверить соединение») через API; панель настроек — по образцу
[AD-072](./ad-072-settings-ui-kit.md). Ошибки подключения — через ключи i18n ([AD-041](./ad-041-llm-error-taxonomy.md)).

## Статус реализации в коде

**Не реализовано, кода нет.** Проверено grep по `packages/**` (исключая `dist/`/`node_modules/`, включая `package.json`):

- Единого сетевого слоя нет: `fetch` вызывается точечно (см. таблицу выше).
- Нет прямых зависимостей `undici`/`proxy-agent`/`https-proxy-agent`/`socks-proxy-agent`/`axios` ни в одном
  `package.json` пакетов `synth`.
- Env `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/`NODE_EXTRA_CA_CERTS` не читается.
- В `packages/shared/src/config/types.ts` секции `network`/`proxy` нет. Есть только:
  - `runner.proxyPort` (дефолт 9090, `types.ts:87`, `defaults.ts:40`) — **внутренний LLM Proxy раннера**
    (план: [AD-050](./ad-050-external-engines-runner.md)), не HTTP-прокси;
  - `mcp.networkPolicy` (AD-071 §2.3.1, `types.ts:158`) — политика сетевого доступа MCP-серверов
    (SSRF/приватные CIDR), тоже **не egress-прокси**.
- Частный случай уже реализован **вне** `synth/` — в репозитории `synth-media` (см. «Практическое подтверждение»).

## Открытые вопросы

- Приоритет источника: env (`HTTPS_PROXY`) vs `config.yaml` vs runtime-настройка (по аналогии с AD-023)?
- Kerberos: нативная зависимость (`kerberos`) / внешний SPNEGO-helper / только Basic+NTLM на первом этапе?
- SOCKS5 нужен и на каком этапе?
- MCP stdio-серверы ходят в сеть сами (дочерний процесс) — вне зоны контроля Node? Проксировать через окружение процесса?
- CA/self-signed: единый bypass для LLM/MCP/веба и как он согласуется с guard [AD-036](./ad-036-llm-gateway.md)?
- Прокси один общий или per-provider/per-service?
- Как egress-прокси взаимодействует с `mcp.networkPolicy` ([AD-071](./ad-071-mcp-servers-prompt.md)) и политиками гибрида ([AD-042](./ad-042-hybrid-mode.md))?
- Как пробрасывать прокси во внешние движки/runner ([AD-050](./ad-050-external-engines-runner.md)) — env при спавне?

## Связи

- [AD-023](./ad-023-configuration.md) «Конфигурация» — секция `network`/`proxy`, приоритеты источников.
- [AD-036](./ad-036-llm-gateway.md) «LLM Gateway» — guard/обфускация/аудит; прокси-credentials не утекают в логи.
- [AD-076](./ad-076-git-repo-registry-ssh.md) «Git-репозитории и SSH-ключи» — хранилище секретов at-rest (мастер-ключ) для прокси-credentials.
- [AD-071](./ad-071-mcp-servers-prompt.md) «MCP-серверы в промпте» — сетевой доступ и HTTP-транспорт MCP.
- [AD-042](./ad-042-hybrid-mode.md) «Гибридный режим» — egress к удалённому backend.
- [AD-050](./ad-050-external-engines-runner.md) «Внешние движки — Runner» — проброс прокси в движки.
- [AD-055](./ad-055-instance-exchange.md) «Обмен между инстансами», [AD-056](./ad-056-synth-mcp-server.md) «MCP-сервер Synth» — соседние egress-потребители.
- [AD-041](./ad-041-llm-error-taxonomy.md) «Ошибки LLM/i18n» — ключи ошибок прокси (healthcheck/подключение).
- `synth-media` (`git.itphx.ru:itphx/synth-media`) — частный случай/подтверждение необходимости (Telegram через SOCKS/HTTP-прокси).
