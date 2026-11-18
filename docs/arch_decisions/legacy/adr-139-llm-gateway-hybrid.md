# ADR-139: LLM-шлюз по умолчанию включён в managed и hybrid

> **Статус:** ⛔ Заменено
> **Заменено:** [ADR-147](../adr-147-llm-gateway-default-on.md) — единый дефолт `enabled: true` во всех профилях.
> **Дата:** 2026-11-13
> **Источник:** PROP-139 (файл удалён после принятия).
> **Связано:** [ADR-036](../adr-036-llm-gateway.md) (LLM Gateway), [ADR-045](../adr-045-hybrid-server-profiles.md)
> (гибрид), [ADR-035](../adr-035-micro-model-first.md) (микро-слой); конфиг — [docs/CONFIGURATION.md](../../CONFIGURATION.md),
> наблюдаемость — [docs/OBSERVABILITY.md](../../OBSERVABILITY.md).

## Контекст

`llmGateway.enabled` по умолчанию `true` для backend/managed
(`packages/backend/src/lib/app-config.ts` передаёт `baseDefaults: { llmGateway: { enabled: true } }`) и
`false` для standalone. Hybrid-контур (локальный core + центральный сервер, ADR-045) в дефолтах **не
учитывался**: локальный core в гибриде работал с выключенным шлюзом, то есть без обфускации секретов,
аудита каждого запроса и rate limit. Внешний аудит систематически фиксировал это как замечание.

## Решение

1. **Профильный дефолт:** managed — `true` (уже), **hybrid — `true`**, standalone — `false`.
2. **Hybrid определяется при старте** локального core (активное подключение к центральному серверу,
   ADR-045: `remote.enabled` в `config.yaml` либо OIDC-fallback `--oidc-issuer`/`--oidc-client-id`) и
   добавляет профильный `baseDefaults: { llmGateway: { enabled: true } }`.
3. **Приоритет не меняется (ADR-023):** CLI > `SYNTH_LLM_GATEWAY_ENABLED`/env > `config.yaml` >
   runtime-тумблер UI > профильный дефолт > общий дефолт. Явное отключение (`enabled: false` в
   конфиге/env) остаётся возможным и перекрывает профиль.
4. **Двухпроходная загрузка CLI.** Режим (гибрид/standalone) известен только **после** первой загрузки
   конфига, а профильные дефолты участвуют в мерже. Поэтому публичный CLI (`@itphx/synth`) при
   `hybridEnabled` **перечитывает** конфиг с `baseDefaults`; standalone вторую загрузку не делает —
   поведение и латентность прежние.
5. **Готовность не ломается.** При выключенном шлюзе `/health` и `/ready` продолжают отдавать
   `llmGateway: "disabled"` и предупреждение `['llm-gateway-disabled']` — это предупреждение, а не
   ошибка readiness (ADR-094).

## Статус в коде

- **Managed:** `packages/backend/src/lib/app-config.ts` — `baseDefaults: { llmGateway: { enabled: true } }`.
- **Профиль гибрида:** `packages/core/src/server/app/standalone-options.ts` — `hybridGatewayBaseDefaults()`
  (возвращает свежий объект, общий мутируемый дефолт исключён); реэкспорт — `packages/core/src/index.ts`.
- **Двухпроходная загрузка:** `packages/synth/src/cli.ts` — первая загрузка → вычисление
  `hybridEnabled` (`synth.remote.enabled || oidcFallbackGiven`) → повторная `loadConfig` с
  `baseDefaults: hybridGatewayBaseDefaults()`.
- **Тесты:** `packages/core/src/server/app/standalone-options.test.ts` — профиль, свежесть объекта,
  двухпроходная загрузка (standalone → `false`, гибрид → `true`), явное отключение в config.yaml и
  `SYNTH_LLM_GATEWAY_ENABLED=false` выше профиля.
- **Документация:** [docs/CONFIGURATION.md](../../CONFIGURATION.md) (дефолты профилей), корневой
  `AGENTS.md` (инвариант 25), `packages/backend/AGENTS.md`, `packages/core/AGENTS.md`.

## Альтернативы

- **Всегда `true`** — отклонено: standalone без центрального сервера не нуждается в шлюзе, лишний слой
  менял бы поведение локального инстанса.
- **Runtime-переключатель профиля** — отклонено: профиль определяется при старте (инвариант 24), а
  ручной тумблер UI уже есть и стоит выше дефолта.
- **Определять гибрид до загрузки конфига** — отклонено: `remote.enabled` и OIDC-fallback живут в
  конфиге/флагах; отсюда двухпроходная загрузка вместо второго источника истины.

## Последствия

- **Плюсы:** в гибриде обфускация секретов, аудит запросов и rate limit работают «из коробки», как в
  managed; приоритет настроек предсказуем; standalone не меняется.
- **Минусы:** публичный CLI в гибриде грузит конфиг дважды (однократно при старте); профильный дефолт
  нужно помнить при добавлении новых точек входа — они должны применять `hybridGatewayBaseDefaults`
  так же, как CLI.
- **Проверка:** явное отключение и env-приоритет покрыты тестами; ready-контракт при выключенном шлюзе
  не изменился.

## История

- 2026-11-13 — принято из PROP-139 (реализовано); файл предложения удалён.
- 2026-11-18 — заменено ADR-147 (единый дефолт во всех профилях).
