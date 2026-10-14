# AD-022: TypeScript стек + Runner

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md

- **@itphx/synth-core** — автономное ядро: сессии, очередь, LLM-провайдеры, MCP, HTTP API v2, CLI
- **@itphx/synth-backend** — облачный API Hub: OIDC, RBAC, Runner Registry, LLM Proxy
- **@itphx/synth-ui** — React 19 SPA + админка

> **Runner-мост** (внешние движки opencode/cline через отдельный компонент) — **не реализован**
> (план: [AD-018](./ad-018-session-engine-selection.md), [AD-050](./ad-050-external-engines-runner.md));
> отдельного npm-пакета раннера в репозитории нет.
