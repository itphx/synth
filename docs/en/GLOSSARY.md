# Synth documentation glossary (RU → EN)

This glossary fixes the **mandatory terminology** for the English versions of the
Synth documentation (`README.en.md`, `docs/en/**`). When writing or translating EN
docs, use the English terms exactly as listed here.

The terminology source of truth is the product itself: the English UI strings
(`packages/ui/src/lib/i18n/messages/en.ts`), the engine strings
(`packages/core/src/engine/system-messages.ts`, contract in
`packages/shared/src/i18n/index.ts`), the existing English repository files
(`CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, `CHANGELOG.md`,
`THIRD-PARTY-NOTICES.md`, `.github/**`, `test/README.md`) and the product landing
dictionary (`synth-landing/js/main.js`).

> **Priority rule.** If a term here disagrees with the current English product
> strings, the product strings win — fix this glossary instead.

## Terms

| Russian (RU) | English (EN) | Meaning / context | Keep as-is |
|---|---|---|---|
| сессия | session | A conversation with the agent; history and state live on the server | `Session` |
| дочерняя сессия | child session | Session spawned by the `task` tool and linked to a parent session (child/parent relationship) | `childSessionId`, `child_session_id` |
| сессия саб-агента | subsession / subagent session | The subagent's own session (the child session where the subagent runs); product strings prefer “subagent session” | `subagentSessions` |
| проект | project | Container for sessions, files and context; optional for a session | `projectId`, `Project` |
| агент | agent | Configured assistant with tools, capabilities and a system prompt | `AgentRegistry` |
| саб-агент | subagent | Agent invoked from within a session via the `task` tool | `task` tool |
| скилл | skill | `SKILL.md` instruction bundle loaded on demand (progressive disclosure) | `SKILL.md` |
| инструмент | tool | A callable the model can use (built-in or MCP) | `ToolCapability` |
| встроенный инструмент | built-in tool | Tool shipped with the core (files, shell, git, plan, todo) | — |
| провайдер | provider | LLM endpoint configuration (URL, type, key) | `GatewayProvider` |
| модель | model | A specific model offered by a provider | — |
| маршрутизация | routing (model routing) | Selecting a model by content, cost and confidence | `router.*` |
| движок | engine | LLM runtime; stateless, history lives on the backend | `opencode`, `cline` (planned, PROP-050) |
| очередь | queue | Per-session message queue processed by the orchestrator | `pendingMessages` |
| оркестратор | orchestrator | Component that drives a session turn (LLM calls + tool calls) | `ChatOrchestrator` |
| режим | mode | Session permission mode: `plan` / `act` / `yolo` | `plan`, `act`, `yolo` |
| разрешения | permissions | `allow` / `deny` / `ask` rules per tool, command or file pattern | `allow`, `deny`, `ask` |
| инвариант | invariant | Rule a project requires the model to follow | `project.invariants` |
| план | plan | Project-level kanban plan | `project.plan`, `plan_*` tools |
| todo | todo / ToDo | Session-level task list | `session.todos`, `todo_*` tools |
| воркспейс | workspace | Project working directory where tools operate | `project.workspace` |
| рабочий каталог | working directory | Default directory for file/shell/git tools | `SYNTH_DEFAULT_WORKSPACE` |
| репозиторий | repository | A git repository registered in the project | `project.repos` |
| ветвление | branching | Forking a session while inheriting context | `forkSession` |
| контекст | context | Message history plus system prompt sent to the model | `ContextBuilder` |
| контекстное окно | context window | Maximum number of tokens the model accepts | `num_ctx` |
| компрессия / оптимизация контекста | context compression / context optimization | Reducing history to save tokens | — |
| сжатие (summary) | summary | Condensed history that replaces older messages | `summary` |
| хук | hook | In-process lifecycle hook (pre/post tool use, session, plan, spawn) | `HookBus` |
| внешнее событие | external event | Event from an external source accepted by the Router | `SynthEvent` |
| привязка (binding) | binding | Link of an external source/chat to a session | `EventBinding` |
| маршрут (route) | route | Routing rule that matches an event to a target | `EventRouteRule` |
| шлюз | gateway | 1) security layer for LLM traffic; 2) class of extensions (e.g. Telegram) | `LLM Gateway`, `GatewayProvider`, `synth-gateway-telegram` |
| аддон | add-on | External companion service running next to Synth | `synth-media` |
| плагин | plugin | In-process code extension (Extension API) | `@itphx/synth-plugin` |
| шов / точка расширения | seam | Extension point for future plugins/registries — convention, from code comments, not a product string | `RouteRuleProvider`, `ContextSource` |
| плумбинг | plumbing | Wiring already present in the core but not yet used (e.g. the Runner flag) — convention, from a code comment, not a product string | `serve --runner` |
| webhook | webhook | Outbound HTTP subscription with HMAC signing | `whsec_…` |
| расписание (schedule) | schedule | Cron-based rule that fires events | `Schedule` |
| задание (job) | job | One recorded execution of a schedule | `jobs.jsonl` |
| шедулер | scheduler | Component that fires schedules | `SchedulerService` |
| гибридный режим | hybrid mode | Local core plus a remote server in one UI | `origin`, `remote:<uuid>` |
| агрегатор миров | aggregator of two worlds | The local core presents local and remote projects/sessions as one — doc convention, not a product string | `origin` |
| managed | managed | Server-deployed instance; roles come from the server | — |
| standalone | standalone | Local single-user instance with the ADMIN role | — |
| инстанс | instance | One Synth installation with its own data directory | `SYNTH_DATA_DIR` |
| мастер-ключ | master key | At-rest encryption key for stored secrets | `master.key`, `SYNTH_SECRET_KEY` |
| секрет | secret | API key, token or credential stored encrypted | `at-rest` |
| обфускация | obfuscation | Replacing secrets with placeholders before sending to the model | `⟦SYNTH_SECRET_N⟧` |
| аудит | audit / audit log | Record of every LLM request and sensitive action | `Logs & audit` |
| RBAC | RBAC | Role-based access control for HTTP endpoints | `requirePermission` |
| роль | role | One of `ADMIN` / `USER` / `LEAD` / `AUDITOR`, or a project role | `ADMIN`, `USER`, `LEAD`, `AUDITOR` |
| scope | scope | Fine-grained token permission (e.g. `events:ingest`) | `requireScope` |
| потолок прав | permission ceiling | Sender roles that only narrow (never raise) the profile roles — convention, not a product string | `identity.roles` |
| service-key | service key | Scoped instance key for external services | `synth_svc_…` |
| binding-key | binding key | API key bound to an event source/chat | `synth_evt_…` |
| мягкий отзыв | soft revocation | Marking a key revoked without deleting it — the UI string is “Revoke”/“Revoked”; “soft” is a convention | `revoke`, `revokedAt` |
| ephemeral-сессия | ephemeral session | Temporary session with a time to live | `expiresAt` |
| TTL | TTL | Time to live before an ephemeral session is swept | `parseTtl` |
| артефакт | artifact | Data produced by a step and passed to the next one (pipelines) | — |
| релиз | release | Published version (npm, Docker, Helm, GitVerse/GitHub) | — |
| тег | tag | Git tag (`v*`) that triggers the release pipeline | `v*` |
| чарт | chart | Helm chart used to deploy Synth | `charts/synth` |
| образ | image | Container image | `ghcr.io/itphx/synth` |
| реестр | registry | 1) package / MCP / skills registry; 2) container registry | `McpRegistryEntry`, `SERVICE_SCOPES` |
| зеркало | mirror | Public GitHub mirror of the repository | `GitHub mirror` |
| ADR / PROP | ADR / PROP | Architecture Decision Record / Proposal; kept in Russian | `adr-*.md`, `prop-*.md` |
| возможность (capability) | capability | Tool group or ability granted to an agent | `ToolCapability` |
| политика | policy | Which tool/skill definitions are sent to the model | `tools.policy` |
| снапшот | snapshot | Frozen per-session copy of MCP/skills defaults | — |
| гейт | gate | Hard on/off switch for an entity | `hard-gate` |
| мастер-выключатель | master switch | Instance-wide on/off toggle | `disabled` |
| владелец сессии | session owner | User or machine account that owns a session | `resolveOwnerId` |
| идентичность | identity | External-account link of a user profile | `ExternalIdentity` |
| claim-flow | claim flow | One-time code that links an external sender to a profile | `identities/claim` |
| allowlist | allowlist | Explicit list of permitted values | — |
| подпись | signature | HMAC signature of a webhook payload | `X-Synth-Signature` |
| идемпотентность | idempotency | Safe repeated execution without duplicate effects | — |
| дедупликация | deduplication (dedup) | Dropping duplicate events | `dedupKey` |
| лимит | rate limit | Requests-per-minute cap | `rateLimitPerMinute` |
| поток (стрим) | stream | Server-sent token stream of an answer | `currentStream` |
| частичный ответ | partial response | Answer kept when a stream is cancelled | `stream.cancelled` |
| остановка / прерывание | stop / abort | Reliable stop of a running turn | `POST /sessions/:id/abort` |
| хранилище | storage | JSON file storage accessed through FileStore | `FileStore` |
| миграция | migration | Schema or data migration between versions | — |
| переменная окружения | environment variable (env var) | Configuration through `SYNTH_*` variables | `SYNTH_*` |
| флаг | flag | Command-line option | `--api-key` |
| сборка | build | Compiling the packages | `pnpm build` |
| публикация | publishing | Releasing packages to registries | `publish.sh` |
| монорепозиторий | monorepo | pnpm-workspaces repository | `pnpm-workspace.yaml` |
| пакет | package | npm package under `packages/` | `@itphx/synth-*` |
| системный промпт | system prompt | Composed prompt sent before the conversation | `SystemPromptComposer` |
| кэш промпта | prompt cache | Reusing the stable prompt prefix | `prompt-cache` |
| provenance-заголовок | provenance header | `--- from <path> (<chars> chars[, truncated]) ---` emitted before injected instructions — core code, not a UI string | `provenance` |
| decision-модель | decision model | Small model used for fast decisions and routing | `Clef-Flash` |
| эскалация | escalation | Falling back to a stronger model | `decision-cascade` |
| порог уверенности | confidence threshold | Confidence below which escalation happens | `confidenceThreshold` |
| быстрые ответы | quick answers | Instant-answer layer for simple requests (rules / embeddings / decision, without the large model); UI section “Quick answers” | `settings.microFirst.*`, `sessionSettings.micro.*` |
| микро-слой | micro layer | The rules + embeddings + decision level in front of the LLM (product keys use `micro`; the product hint writes “micro-layer”) | `micro` |
| decision-уровень | decision level | Decision-model classification inside Quick answers; per-session opt-out `decisionFirst` | `sessionSettings.micro.decision` |
| каскад моделей | model cascade | Chain of models engaged only when the previous one is unconfident | `micro-cascade`, `decision-cascade` |
| контроль качества | quality check | Post-answer check (min length) that forwards the request to the fallback model | `routing.escalation.*` |
| уверенность (0–1) | confidence | Model confidence in the 0–1 range, compared against the threshold | `confidenceThreshold` |
| эмбеддинг / эмбеддинг-модель | embedding / embedding model | Vector representation used for semantic classification | `settings.microFirst.embedding`, `sessionSettings.micro.embeddingModel` |
| запасная модель | fallback (fallback model) | Spare model used when the primary answer fails the quality check | `routing.escalation.fallback`, `decisionConfig.metricFallback` |
| задача (task) | task | Unit of work delegated to a subagent | `task` tool |
| приём события | event ingestion (ingest) | Accepting an external event through the API | `EventIngress` |
| доставка | delivery | Passing an answer to a session or channel | `EventDelivery` |
| журнал | journal / log | Append-only record of decisions or jobs | `journal.jsonl` |
| статистика токенов | token statistics | Token usage shown in the UI | — |
| тема | theme | UI color theme | `Dracula`, `Nord` |
| портал | portal | User documentation site (docs.synth.itphx.ru) | — |
| лендинг | landing page | Product marketing page | — |

## Identifiers that are never translated

Code symbols, package names, CLI commands, configuration keys, protocols and file
names stay exactly as in the source:

- **Packages:** `@itphx/synth`, `@itphx/synth-core`, `@itphx/synth-backend`,
  `@itphx/synth-ui`, `@itphx/synth-shared`, `@itphx/synth-sdk`,
  `@itphx/synth-plugin`.
- **CLI:** `synth`, `synth serve`, `synth chat`, `synth secrets rotate`,
  `synth backup`, `synth restore`, `synth migrate`.
- **Core symbols:** `FileStore`, `EventHub`, `TransportClient`,
  `RequestSessionService`, `SessionManager`, `HookBus`, `EventRouter`,
  `GatewayProvider`, `ContextBuilder`, `SystemPromptComposer`, `AgentRegistry`,
  `EventBinding`, `RouteRuleProvider`, `EventIngress`, `EventDelivery`,
  `ScheduleStore`, `SchedulerService`, `WebhookService`.
- **Tools:** `read_file`, `write_file`, `edit_file`, `execute_shell`, `glob`,
  `grep_files`, `git_status`, `plan_*`, `todo_*`, `task`, `skill`, `web_fetch`,
  `web_search`, `project_repo_clone`, `project_workspace_set`.
- **Configuration / environment:** `config.yaml`, `settings.json`, `SYNTH_*`
  (for example `SYNTH_DATA_DIR`, `SYNTH_HOME`, `SYNTH_API_KEY`,
  `SYNTH_SECRET_KEY`).
- **Secret prefixes:** `synth_svc_…`, `synth_evt_…`, `whsec_…`.
- **Protocols and formats:** MCP, OIDC, JWT, WS, SSE, JSONL, HMAC-SHA256.
- **File names:** `AGENTS.md`, `SKILL.md`, `README.en.md`, `LICENSE`,
  `pnpm-lock.yaml`.
- **ADR/PROP identifiers:** `ADR-NNN`, `PROP-NNN` — file names and numbers are
  stable and are never translated or renumbered.
- **Prompt blocks (engine markers, never translated):** `[SESSION INFO]`,
  `[ADDITIONAL CONTEXT]`, `[PROJECT INSTRUCTIONS]`, `[CLASSIFICATION]`,
  `[APPROVED PLAN]`, `[TODO]`, `[TRUNCATED: …]`,
  `[Subdirectory context discovered: …]`.
- **API platform identifiers:** `public-OpenAPI` — kept as a single hyphenated
  identifier, never split or translated.
- **Upstream products:** Keycloak, Ollama, OpenAI, Anthropic, Hono, React,
  Vitest, pnpm, Docker, Kubernetes, Telegram, GitVerse, GitHub.
