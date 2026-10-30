# Providers and models: protocols, compatibility, specifics

> 🌐 **English** · [Russian](../PROVIDERS.md)

A reference specification: "how it works and what to configure". This is **not** an ADR — the
decision and its rationale live in [ADR-117](../arch_decisions/adr-117-provider-compatibility.md)
(the compatibility layer and the Anthropic thinking round-trip),
[ADR-036](../arch_decisions/adr-036-llm-gateway.md) (the single LLM call path),
[ADR-070](../arch_decisions/adr-070-system-prompt-composer.md) (prompt cache),
[ADR-115](../arch_decisions/adr-115-multimodal-input.md) (modalities and attachments),
[ADR-099](../arch_decisions/adr-099-egress-tls-trust.md) (TLS/proxy of outgoing requests).

## 1. Scope and terms

| Term | Meaning | Declared in |
|---|---|---|
| **Provider** | Access point: protocol type, base URL, key, timeout, price currency, `num_ctx`, compatibility defaults | `ProviderConfig` — [shared/types/provider.ts](../../packages/shared/src/types/provider.ts) |
| **Model** | Catalog record: "provider + model name" pair, limits, prices, modalities, compatibility overrides | `ModelConfig` — same file |
| **`provider/model` pair** | How a model is addressed in routing, agents, subagents and `list_models` (a model without a provider is ambiguous) | model `id` = `<provider>/<name>` |
| **Protocol** | Request/response format implemented by an adapter (`openai`/`anthropic`/`ollama`/`decision`/`remote`) | `packages/core/src/providers/` |
| **Catalog** | Instance-level provider and model records (JSON or DB), not `config.yaml` keys | `{dataDir}/providers/`, `{dataDir}/models/` |
| **`compatibility`** | Data describing protocol differences of compatible gateways: reasoning field name, output-limit field, `tool_choice`, cache format, `finish_reason` requirement | `ModelCompatibility` — [shared/types/provider.ts](../../packages/shared/src/types/provider.ts) |

Providers and models are **instance data** (ADR-023/ADR-096), so a new gateway or proxy is added as a
catalog record, not by a core release. They have no separate `config.yaml` keys: edit them via the
API, the admin UI, or (for initial provisioning) env sync.

**Out of scope:**

- user documentation portal [docs.synth.itphx.ru](https://docs.synth.itphx.ru/) (end-user guides);
- dev credentials and local models — [LLM_PROVIDERS.md](./LLM_PROVIDERS.md);
- model selection/routing and the micro layer — [ROUTING.md](./ROUTING.md), ADR-034/ADR-035/ADR-084;
- LLM Gateway policy (obfuscation, rate limit, guard) — ADR-036; here only the boundary "what the
  wrapper guarantees vs what the protocol does";
- the attachment pipeline (hydration, aux models, drop) — ADR-115 and §3 of this spec;
- instance configuration as a whole — [CONFIGURATION.md](./CONFIGURATION.md), HTTP reference —
  [API_V2.md](./API_V2.md) §5.9/§5.10.

## 2. Protocols

The provider type selects the adapter class; `type` comes from the provider record and, if absent,
from the provider name. If the type is not registered, it is detected from the URL
(`ProviderFactory._detectProviderType`,
[providers/base.ts](../../packages/core/src/providers/base.ts)).

| `type` | Adapter | Endpoint (after URL normalization) | Chat | Notes |
|---|---|---|---|---|
| `openai`, `generic` | `OpenAIProvider` | `POST {base}/chat/completions` if `base` already contains `/v1` or `/chat/completions`; otherwise `POST {base}/v1/chat/completions` | yes | The main path for compatible gateways and proxies; `compatibility` is used most extensively here (§5) |
| `anthropic` | `AnthropicProvider` | `POST {base}/v1/messages` | yes | Thinking blocks and signatures (§6), its own `tools`/`tool_choice`/`cache_control` format |
| `ollama` | `OllamaProvider` | `POST {base}/api/chat` — **always native** | yes | A URL with `/v1` or `/v1/chat/completions` is normalized to `/api/chat` with a log warning; `options.num_ctx`, `think`, native `tools` format |
| `decision`, `systemone` | `DecisionProvider` | `POST {base}/decisions` (RouterAI/SystemOne) or `POST {base}/v1/systemone` (Ollama ≥ 0.35.1) | **no** | Not chat: `state` + typed questions → probabilities in one forward pass (ADR-084); `chat`/`chatAsync` throw `ProviderError` |
| `remote`, `synth-server` | `RemoteProvider` | `POST {backend}/api/v2/llm/chat/completions` (the backend LLM Proxy) | yes | Hybrid mode: the local core calls the server for LLM, the gateway is applied server-side; the token comes from `RemoteSession`/the token registry |

`remote` and `synth-server` are the same adapter: `synth-server` is registered as an **alias**
(`providers/index.ts`, test `remote.test.ts`), has no separate behaviour, and exists for hybrid mode
and compatibility with older catalog records.

URL normalization — `ProviderFactory._normalizeUrl`; for `decision`/`systemone` the URL stays the base
(the adapter appends the protocol path).

**The `GatewayProvider` boundary** ([engine/gateway/gateway-provider.ts](../../packages/core/src/engine/gateway/gateway-provider.ts)).
Every LLM call (chat, stream, `embed`, `decide`) goes through the wrapper; adapters are never called
directly (root invariant 3). The wrapper provides:

- **input guard** and secret obfuscation (per-session obfuscation map; the provider receives the
  already obfuscated request — prompt-cache markers are placed after the guard/obfuscation);
- **rate limit** (per user and per provider, per-minute windows);
- **audit** of every call (`AuditLogger`, including LLM filter verdicts);
- **output guard** for the response;
- call accounting for metrics (`synth_llm_requests_total`/`synth_llm_duration_seconds`/
  `synth_llm_tokens_total`, ADR-094) and filter phases `pre_request`/`post_response`/`embedding`.

Protocol specifics (which field carries reasoning, how the output limit is passed, what to do with
`tool_choice`, how thinking blocks are replayed) stay in the adapter and are driven by
`compatibility` data. The guard/obfuscation/scanner work **only with text** — attachment binaries are
not scanned (ADR-115).

## 3. Catalog and configuration

### 3.1 Storage

| Item | Location | Type |
|---|---|---|
| Provider | `{dataDir}/providers/<name>.json` (with `storage.backend=postgres` — a documents table) | `ProviderConfig` |
| Model | `{dataDir}/models/<id>.json`, `id` = `<provider>/<name>` | `ModelConfig` |

Writes are atomic (tmp → rename, ADR-005); reads go through the storage layer port (ADR-096). Editing
JSON by hand is an emergency path only; the source of truth for behaviour is the API — the provider
and model caches (`providerCache`/`modelCache`) are updated by the route handlers.

### 3.2 API

| Method/path | Purpose |
|---|---|
| `GET /api/v2/providers` | List: `name`, `type`, `url`, `model`, `enabled`, `is_default`, `currency`, `num_ctx`, `compatibility` (only when set) |
| `POST /api/v2/providers`, `PATCH /api/v2/providers/:name` | Create/update: `compatibility`, `num_ctx`, currency, timeout, icon; both snake_case and camelCase field names are accepted |
| `POST /api/v2/models` | Create/update a model: `context_window`, `max_output_tokens`, prices, `price_source`, `currency`, `modalities`, `compatibility`, `requires_reasoning` |
| `POST /api/v2/models/fetch` (`?provider=<name>`) | Sync with the provider catalog: `contextWindow`/`maxOutputTokens`/prices (`priceSource: 'api'`)/modalities; best-effort (an unreachable catalog does not fail the sync) |

Exact request bodies and status codes — [API_V2.md](./API_V2.md) §5.9/§5.10; implementation —
[server/routes/providers.ts](../../packages/core/src/server/routes/providers.ts),
[server/routes/models.ts](../../packages/core/src/server/routes/models.ts).

### 3.3 Configuration cascade and env

The catalog is instance data; the general configuration priority (CLI > `SYNTH_*` env >
`config.yaml` > defaults, ADR-023) applies to **config sections**, not to catalog records. The
exception is initial provider provisioning from env (`syncProvidersFromEnv`,
[providers/sync-from-env.ts](../../packages/core/src/providers/sync-from-env.ts)):

```text
SYNTH_PROVIDER_<NAME>_(API_KEY|URL|MODEL|TYPE|NUM_CTX)
```

The name is lowercased with `_` → `-`; at startup the catalog record is **supplemented/overwritten**
for these fields, and `MODEL` creates the model `<name>/<model>` with `isDefault: true` if it does not
exist yet. Env does **not** carry `compatibility`, `timeout`, `currency`, `icon` — use the API or the
catalog JSON (see §11). The CLI equivalent is `synth config provider add` (flags `--type`, `--url`,
`--model`, `--api-key`, `--num-ctx`); details in [LLM_PROVIDERS.md](./LLM_PROVIDERS.md).

### 3.4 `num_ctx` (context size)

Applies only to the native Ollama path (`/api/chat`, `options.num_ctx`). Priority:
**explicit `ProviderConfig.numCtx`** → `ModelConfig.contextWindow` → reference
([engine/router/utils.ts](../../packages/core/src/engine/router/utils.ts),
[engine/orchestrator/routing.ts](../../packages/core/src/engine/orchestrator/routing.ts)).
Set it via `num_ctx`/`numCtx` in `POST`/`PATCH /api/v2/providers`, env
`SYNTH_PROVIDER_<NAME>_NUM_CTX`, or the `--num-ctx` flag; Ollama's OpenAI-compatible path
(`type: openai`/`generic`) does not pass this value.

### 3.5 Prices, currencies, price source

- Prices are per **1M tokens**: `inputPrice`, `outputPrice`, `cacheReadPrice`, `cacheWritePrice`.
- Currency — `RUB` | `USD` | `CNY`; absent on the model → provider currency → `USD`.
- `priceSource`: `api` — from catalog sync, `manual` — entered by hand, `unknown` — not determined.
  Manual price entry marks `manual`; clearing all prices resets the source.
- RouterAI/OpenRouter pricing parsing (`pricing`/`pricing_units`) considers **token-based** tariffs
  only (`request`/`second`/`image`/`search_unit` are ignored) and normalizes values ×1,000,000
  ([providers/base.ts](../../packages/core/src/providers/base.ts)).

### 3.6 Modalities (ADR-115)

`ModelConfig.modalities` (`text`/`image`/`pdf`/`audio`/`video`) — which attachments the model accepts.
The source is the provider catalog (`architecture.input_modalities`/`architecture.modality`, mapping
`file` → `pdf`) on `POST /api/v2/models/fetch`, or a manual override in `POST /api/v2/models`
(`null` — reset). **Field absent — modalities unknown**: no filtering, an incompatible type is
rejected by the provider itself (silent attachment loss is forbidden). There is no modality
reference table in the core.

Modalities feed hydration: if the model accepts the modality, the attachment goes natively; if not, an
aux model of the family (`attachments.modalityModels`) or a drop with materialization into the
workspace (ADR-115). Adapters encode only what they physically can: `video_url`/`input_audio{ogg}` —
RouterAI, `audio{base64}` — Anthropic-compatible RouterAI (wav only); official Anthropic/OpenAI do not
know these blocks.

### 3.7 Where to look at the catalog

- UI: admin sections "Providers" and "Models" (forms plus the "Advanced parameters" block, §4.6).
- API: `GET /api/v2/providers`, `GET /api/v2/models` (grouped by provider; `modalities`,
  `requiresReasoning`, `compatibility` are returned **only when set**).
- For the agent: the `list_models` tool (`provider/model`, modalities, current pair, `defaultFor`).

## 4. The `compatibility` layer

One `ModelCompatibility` contract is declared at two levels: `ProviderConfig.compatibility` —
defaults for all models of the provider, `ModelConfig.compatibility` — overrides them per field.

### 4.1 Fields

| Field | Default | Purpose | Protocol |
|---|---|---|---|
| `reasoningField` | `reasoning_content` | Name of the reasoning field in assistant messages; an explicit value implies `requireReasoning` unless that is overridden | openai-chat |
| `requireReasoning` | auto (DeepSeek heuristic) | The reasoning field is mandatory in **every** assistant message — an empty string when there is no reasoning | openai-chat |
| `maxTokensField` | `max_tokens` | Output-limit field: `max_tokens` \| `max_completion_tokens` (the latter only when explicit) | openai-chat |
| `requireAssistantAfterTool` | `false` (Mistral heuristic) | Assistant "bridge" after `tool` results and at the end of the history if it ends with `tool` | openai-chat |
| `streamUsage` | `true` | `stream_options: {include_usage: true}` in streams (without it, stream usage is zero) | openai-chat |
| `supportsToolChoice` | `true` (`false` for `type: ollama`) | Whether to send `tool_choice` | openai-chat, Ollama |
| `cacheFormat` | not set | Inline prompt-cache markers `cache_control: {type:'ephemeral'}`: `anthropic` — last tool + system + tail of the last message; `alibaba` — system + tail, **no** tools. Budget ≤ 4 breakpoints; when set, `prompt_cache_key` is **not** sent | openai-chat |
| `requireFinishReason` | `true` | A stream without `finish_reason` is an incomplete response → error, not retried | openai-chat |
| `supportsEffortUpdates` | `false` (explicit value only) | Anthropic 5.x effort mode: send `output_config.effort` (effort tier) and **not** send `thinking`; thinking blocks in history are not replayed, `temperature` is not forced. Without the flag — previous behaviour, an explicit effort is ignored | anthropic |

`ResolvedModelCompatibility` is the fully resolved set: every field is filled except `cacheFormat`,
where `undefined` is a meaningful state ("do not place markers").

**Reasoning level and sampling sit outside `compatibility`.** `reasoningLevel` is set by the agent
(`AgentDefinition.reasoningLevel`) and the session (`SessionSettings.reasoningLevel`). On session
creation (`POST /api/v2/sessions`) the value **is persisted** (the `SessionManager.createSession`
whitelist no longer drops it — previously `reasoningLevel` from the request body was discarded and the
setting only took effect after `PATCH`), and the effective value goes into the request
(`agentDef.reasoningLevel ?? session.settings.reasoningLevel`, the agent wins). `topP`/`topK` are
**agent** fields, not session ones: `SessionSettings` does not have them, so values passed to
`POST /api/v2/sessions` are dropped (sampling is configured in the «Agents» admin section).

### 4.2 Resolution order

**model → provider → heuristic → built-in default** (`resolveModelCompatibility`,
[shared/types/provider.ts](../../packages/shared/src/types/provider.ts)):

1. explicit `ModelConfig.compatibility`;
2. explicit `ProviderConfig.compatibility` (for fields the model does not set);
3. the `detectCompatibilityHeuristics` heuristic;
4. the built-in default.

`ModelConfig.requiresReasoning` is a **shorthand** for `compatibility.requireReasoning`;
normalization is `compatibility.requireReasoning ?? requiresReasoning` (records created before
`compatibility` existed keep working). An explicit `reasoningField` at either level itself implies
`requireReasoning: true` unless `requireReasoning` is set explicitly (including `false`).

### 4.3 Heuristics

Applied **only to unset** fields:

| Field | Condition |
|---|---|
| `requireReasoning: true` | provider type/name `deepseek`, URL contains `deepseek.com`, model id contains `deepseek` |
| `requireAssistantAfterTool: true` | model id contains `mistral`/`devstral`/`codestral`/`pixtral`/`mixtral` |
| `supportsToolChoice: false` | `type: ollama` (the native `/api/chat` does not know the field) |

`maxTokensField`, `streamUsage`, `cacheFormat`, `requireFinishReason`, `supportsEffortUpdates` are
**not** heuristicized: otherwise existing catalog records would start behaving differently (local
servers do not know `max_completion_tokens`; inline cache markers and effort mode — explicit value only).
For `supportsEffortUpdates` the absence of auto-heuristics is deliberate: enabling it changes the
request body (`output_config` instead of `thinking`), so guessing by model name would send an unknown
field to gateways without support (400).

### 4.4 Where it is resolved

- Catalog assembly into the domain: `server/app/deps.ts` and `backend/app/deps.ts`
  (`resolveModelCompatibility`: `provider.compatibility` → shorthand → `model.compatibility`);
- `toCoreProviderConfig` ([engine/router/utils.ts](../../packages/core/src/engine/router/utils.ts))
  — provider config outside sessions (summarization, pipeline steps, attachment aux models);
- `ProviderPool` puts the value into its cache key — changing `compatibility` recreates the provider
  instance and does not affect other runs;
- inside an adapter — `resolveProviderCompatibility`
  ([providers/base.ts](../../packages/core/src/providers/base.ts)): explicit (provider+model) →
  shorthand → heuristic.

### 4.5 API semantics — replacement

`POST`/`PATCH /api/v2/providers`, `POST /api/v2/models` accept `compatibility` as a **full
replacement**:

| Body | Result |
|---|---|
| field not sent | unchanged |
| `null` | reset |
| `{}` | reset (an empty object equals `null`) |
| an object | replaced as a whole: a field absent from the object means "auto", not "keep the previous value" |
| unknown field / wrong type | `400 VALIDATION_ERROR` (a typo is never silently lost) |

`requires_reasoning: null` on a model resets both the shorthand and `compatibility.requireReasoning`.
`GET` returns `compatibility` only when it is set.

### 4.6 UI: the "Advanced parameters" block

A collapsible block in the provider and model forms
([CompatibilityFields.tsx](../../packages/ui/src/components/admin/CompatibilityFields.tsx),
draft — [lib/api/compatibility.ts](../../packages/ui/src/lib/api/compatibility.ts)):

- boolean fields — tri-state **"Auto / Yes / No"**: an explicit `false` does not collapse into
  "auto"; "Auto" means the field is **not sent** in the request body (the server picks the
  heuristic/default);
- `reasoningField` — a select of known names (`reasoning_content`/`reasoning`/`reasoning_text`) with
  a "custom value" option; an unknown stored name expands into "custom value";
- `maxTokensField` and `cacheFormat` — selects with "Auto"; `requireFinishReason` and
  `supportsEffortUpdates` — tri-state (for the latter "Auto" means "No": the server enables effort mode
  only with an explicit `true`);
- a "changed"/"adv." badge in lists; a full clear on an entity that has saved parameters sends
  `compatibility: null` (an explicit reset), while on an entity without saved parameters the field is
  not sent at all.

### 4.7 Examples

```jsonc
// PATCH /api/v2/providers/deepseek-gw — provider defaults
{ "compatibility": { "reasoningField": "reasoning", "requireReasoning": true } }

// POST /api/v2/models — override for a single model (full object replacement)
{ "id": "qwen3.7-flash", "provider": "routerai",
  "compatibility": { "maxTokensField": "max_completion_tokens", "streamUsage": false } }

// reset to auto/defaults
{ "compatibility": null }
```

```bash
# a custom OpenAI-compatible gateway: reasoning in the `reasoning` field, no stream_options
curl -X POST http://localhost:5000/api/v2/providers \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"name":"my-gw","type":"openai","base_url":"https://gw.example.com/v1",
       "api_key":"sk-…","default_model":"my-model",
       "compatibility":{"reasoningField":"reasoning","streamUsage":false}}'

# a model with another output-limit field and anthropic-style inline caching
curl -X POST http://localhost:5000/api/v2/models \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"id":"my-gw/big","provider":"my-gw","name":"big",
       "context_window":200000,"max_output_tokens":8192,
       "compatibility":{"maxTokensField":"max_completion_tokens","cacheFormat":"anthropic"}}'
```

## 5. OpenAI-chat specifics

Implementation — [providers/openai.ts](../../packages/core/src/providers/openai.ts) (types `openai`,
`generic` — one class).

### 5.1 Reasoning field names

When reading a response the priority is: configured `reasoningField` → `reasoning_content` →
`reasoning` (empty strings are skipped). When sending history, the field name comes from the
resolution; `reasoning_content` is the default (DeepSeek), `reasoning` — OpenRouter/RouterAI,
`reasoning_text` — other gateways (set explicitly). DeepSeek service reasoning chunks `'.'`/`'.\n'`
are dropped (the `reasoning` field has no such filter — dots there are meaningful).

### 5.2 Reasoning pass-back

DeepSeek thinking models require the reasoning to be passed back in repeated history, otherwise
`400` "The `reasoning_content` in the thinking mode must be passed back to the API". Therefore, with
`requireReasoning`, the field is written into **every** assistant message — as an empty string when
there is no reasoning (`reasoning ?? (requireReasoning ? '' : undefined)`). Without this, the
synthetic assistant prefill of the step-limit step broke (§8).

### 5.3 Output-limit field

`maxTokensField`: our default is `max_tokens` (a deliberate difference from opencode, where the
default is `max_completion_tokens`). `max_completion_tokens` is sent only when set **explicitly**:
local and custom OpenAI-compatible servers often do not know it, and a silent default change would
break existing installations. The limit goes into the body only when set and `> 0`.

### 5.4 `tool_choice`

`tool_choice` is passed **only together with `tools`** (some APIs reject the field without tools) and
only when set by the caller: `auto` | `none` | `required`. On the step-limit step — `none` (§8). The
native Ollama does not send the field at all (§7).

### 5.5 `requireAssistantAfterTool` (assistant bridge)

The Mistral family does not accept a history where a `tool` result is immediately followed by a `user`
message. With the flag enabled the adapter inserts `{role:'assistant', content:'Done.'}`: after the
tool result before a `user` message **and** at the end of the history if it ends with `tool`. The
`tool_calls`/`tool_call_id` pairs are not broken.

### 5.6 `streamUsage`

`stream_options: {include_usage: true}` (enabled by default). Without it, stream usage is zero and
`cached_tokens`/`reasoning_tokens` never reach statistics (ADR-070/ADR-094). `false` — the endpoint
does not know the field; usage stays zero, but the request does not fail.

### 5.7 `cacheFormat`: inline markers instead of `prompt_cache_key`

- Without `cacheFormat` — implicit prefix caching: `prompt_cache_key` = the stable session id (with
  `cachePolicy: 'none'` the key is not sent).
- `anthropic` — markers on the last tool definition, on system boundaries (the first and the last
  **distinct** blocks) and on the last message boundary (`tail: 1`, the last text part, otherwise the
  last content part).
- `alibaba` — system and message tail only, **no** tools (Qwen caches tools together with the system
  prompt and ignores markers on definitions).
- Budget — at most 4 breakpoints per request; markers already present in the body are not duplicated
  and do consume budget; fill order is tools → system → tail.
- With `cacheFormat` set, `prompt_cache_key` is **not** sent: these are different mechanisms, and a
  provider tuned for inline markers relies only on them.
- A string system content is expanded into an array of parts when marking
  (`{type:'text', text, cache_control}`) — that is how the marker travels on the wire.
- `cachePolicy: 'none'` — no markers at all.

### 5.8 `requireFinishReason`

Default `true`: a provider that closed the stream without `finish_reason` returned an incomplete
response → `ProviderError` "The provider closed the stream without finish_reason". The error is
**unrecoverable**: the `finish_reason` pattern is part of `UNRECOVERABLE_PATTERNS`
([engine/llm-error.ts](../../packages/core/src/engine/llm-error.ts)), `isLlmErrorRecoverable` does not
retry it (transport errors `network`/`timeout`/`rate_limit` are retried as before). An explicit
`false` restores the tolerant behaviour — for "old" local servers that never send `finish_reason`.

### 5.9 LLM Proxy (`POST /api/v2/llm/chat/completions`)

The hybrid-mode proxy (backend) follows the **same compatibility contract**, not a "raw" openai path:

- the optional `reasoning_effort` field (`low|medium|high|xhigh|max`) goes into `ChatOptions.effort`;
  an invalid value — `400 BAD_REQUEST`, the provider is not called (a request-contract check, not a
  silent ignore);
- the provider is created with merged `compatibility`: `provider.compatibility` → the model shorthand
  `requiresReasoning` → `model.compatibility`. That is why the guards (`requireReasoning`,
  `maxTokensField`, `cacheFormat`, `supportsEffortUpdates`) work through the proxy as well;
- whether the provider actually sends effort is still decided by `compatibility.supportsEffortUpdates`
  (guard inside the provider, §6.1).

## 6. Anthropic specifics

Implementation — [providers/anthropic.ts](../../packages/core/src/providers/anthropic.ts).

### 6.1 Extended thinking

| `reasoningLevel` | `body.thinking` | Thinking blocks in history |
|---|---|---|
| `high` | `{type:'enabled', budget_tokens: …}` | replayed |
| `none` | `{type:'disabled'}` | not replayed |
| `default`, `low`, `medium` | field not sent (model default) | not replayed |

Budget — `resolveThinkingBudget(requested, maxTokens)` (`requested` = 8192):
`min(8192, max(⌊max_tokens/2⌋, 1024))`, and the result must be **strictly less** than `max_tokens`.
In practice: "no more than half the limit, but not below 1024"; if half the limit is below the
minimum, the budget is raised to 1024 (there is still room for the minimum); if there is no room at
all (`max_tokens` ≤ 1024) — thinking is **not enabled** and the request goes as a regular one
(instead of `400` "max_tokens must be greater than thinking.budget_tokens"). The limit used is the
actual one: `ProviderConfig.maxTokens` → default 4096.

Forced constraints when thinking is enabled:

- `temperature` is forced to `1` (the session/agent value is overridden; the provider instance is not
  mutated — it is cached and shared between runs);
- `tool_choice: 'required'` is coerced to `'auto'` (the API forbids a forced tool call); `'none'` is
  allowed — that is the step-limit path.

**Effort mode (`output_config.effort`, ADR-117).** Enabled only by an explicit
`compatibility.supportsEffortUpdates: true` (default `false`, no auto-heuristics) and it changes the
request body:

- `body.output_config = { effort }`. What is sent:
  - priority — an explicit `ChatOptions.effort` (the orchestrator and the sub-agent loop compute it
    **per LLM call** from `agentDef.reasoningLevel ?? session.settings.reasoningLevel` via
    `effortForReasoningLevel`), otherwise the provider instance's `reasoningLevel`;
  - `reasoningLevel` → tier mapping: `low|medium|high` — the same tiers; `none`/`default` — the field
    is **not sent** ("turn reasoning off" cannot be expressed by an effort tier, inventing a value is
    not allowed); `xhigh`/`max` exist only as an explicit `ChatOptions.effort` (neither agent nor
    session settings carry them);
- `thinking` is **not sent at all** — neither `{type:'enabled', budget_tokens}` nor
  `{type:'disabled'}`: on effort models that is a different mode and they must not be mixed.
  Consequences: the budget (see above) is not computed, `temperature` is not forced to `1` (the
  agent/session value applies), `tool_choice` is not coerced;
- thinking blocks from history are **not replayed** (as with thinking disabled, §6.2) — otherwise
  Anthropic would receive them without thinking enabled;
- changing the level between steps and turns is picked up (effort travels in the call options, not in
  the provider constructor, which is cached and shared between runs), but it changes request parameters
  and may drop the provider-side prompt cache.

Without the flag the behaviour is unchanged (`thinking` from `reasoningLevel`) and an explicit
`ChatOptions.effort` is **ignored**.

### 6.2 Thinking signature

- Per turn, reasoning arrives as **several blocks**, and a signature is valid only for its own text,
  so blocks are stored **individually**: a `Part` with `type:'reasoning'` and `metadata {signature?,
  redacted?}`; in the LLM contract — `LLMReasoningBlock {text, signature?, redactedData?}`
  (`LLMChunk`/`LLMResponse.reasoningBlocks`, `LLMMessage.reasoningBlocks`). The seam is
  [engine/reasoning-blocks.ts](../../packages/core/src/engine/reasoning-blocks.ts).
- Stream: `content_block_start` opens a block (`thinking` with a possible signature,
  `redacted_thinking` with opaque `data`, `tool_use`), `thinking_delta` accumulates text,
  `signature_delta` sets the signature (it takes precedence over the one from block start), and a new
  block closes the previous one. Non-stream yields the same result via `content`.
- Replay in an `assistant` message: order `redacted_thinking → thinking → text → tool_use`, **each
  block with its own signature**.
- An empty signature (`signature: ""`) is valid — that is how RouterAI answers for qwen.
- The legacy fields `reasoningSignature`/`reasoningRedacted` on a message are kept as a fallback
  (`reasoningBlocksOfMessage`).
- With thinking disabled, blocks **are not** replayed into history (Anthropic would not accept them
  without thinking enabled).
- Blocks are passed only to the "own" agent **and** only to messages of the same `provider/model` pair
  as the current request (`messageToLLMMessage(msg, currentAgentRole?, currentPair?)`, role aliases
  included; legacy messages without a pair keep the previous behaviour); they are never exposed through
  the API — protocol service data.

### 6.3 Step-limit prefill with thinking

On the step-limit step a synthetic assistant message with the "text only" requirement is appended to
the end of history (§8). With thinking enabled there is **no** thinking block in that prefill. This was
verified live on RouterAI/qwen: the request is accepted and the turn finishes `completed` with
`step_limit_reached`. Official `api.anthropic.com` was not exercised in this scenario (§11).

### 6.4 Prompt-cache breakpoints

`system` is sent as an array of blocks (with `stablePrefix` — `[stable, rest]`); `cache_control:
{type:'ephemeral'}` markers are placed in priority order: tools → system → the last user message;
budget ≤ 4 breakpoints, the excess is dropped with a warning (the request does not fail). The tools
breakpoint index respects `stableToolCount` (ADR-071 §2.1): MCP tools after the boundary are not
cached. `cachePolicy: 'none'` — no markers; the last user message without a text part (e.g. only a
`tool_result`) gets no marker.

### 6.5 The `deepseek-anthropic` inset

DeepSeek's Anthropic-compatible endpoint (`type: anthropic`, URL `https://api.deepseek.com/anthropic`)
was verified live (dev). Behaviour that matters operationally:

- it thinks **always** by default: thinking is disabled only by `reasoningLevel: none`
  (`thinking: {type:'disabled'}` is accepted), not by omitting the field;
- the thinking block signature is non-empty and equals the block `id`; replay with
  `thinking`+`signature` — `200`;
- the endpoint is **tolerant** of a missing thinking block in history (replay without the block —
  `200`), so the strict round-trip required by official Anthropic is not needed here.

`tool_choice: 'none'` together with `tools` remains unverified on this endpoint (§11) — that is the
step-limit path.

## 7. Ollama

Implementation — [providers/ollama.ts](../../packages/core/src/providers/ollama.ts). `type: ollama`
**always** works natively: the URL is normalized to `/api/chat`, and the `/v1` and
`/v1/chat/completions` suffixes are stripped with a log warning. The reason: only the native path
understands `options` (`num_ctx`), `think` and the native `tools` format; Ollama's OpenAI layer
silently ignores all of them. For the OpenAI-compatible path use a separate provider with
`type: openai`/`generic` and a URL ending in `/v1`.

### 7.1 `think`

| `reasoningLevel` | `body.think` |
|---|---|
| `low` / `medium` / `high` | `true` |
| `none` | `false` |
| `default` | field not sent (model default) |

The system prompt goes as the **first message** with `role:'system'` (native `/api/chat` ignores a
top-level `system` — it exists only in `/api/generate`).

### 7.2 No `tool_choice`

The heuristic sets `supportsToolChoice: false` for `type: ollama`; the field is never sent. An explicit
`compatibility.supportsToolChoice: true` restores sending (for compatible server forks).

### 7.3 `num_ctx`

`options.num_ctx` goes into the body when `numCtx > 0` is set. Source priority — §3.4: an explicit
`provider.numCtx` **wins over** `ModelConfig.contextWindow`.

### 7.4 Consequence for the step limit

Since there is no way to forbid tool calls, the model may return `tool_calls` on the step-limit step.
The calls are **not executed**, but they are not silently discarded either: each one gets a paired
`tool` result with `isError` and the key `tool.disabled_by_step_limit`, and the turn then finishes with
a deterministic `session.steps_limit` report (status `limit`). Verified live: `qwen3.8:27b-256k` via
native Ollama yields `status=limit`, `step_limit_reached=true`, with no textual answer from the model.

## 8. Step limit

The mechanics match opencode; the shared module is
[engine/llm/max-steps.ts](../../packages/core/src/engine/llm/max-steps.ts) (used by the main loop
`engine/orchestrator.ts` and the subagent loop `engine/tools/task/run-cycle.ts`).

### 8.1 Numbering: `maxSteps: N` → N−1 working steps + the limit step

`stepLimitStep = iteration + 1 >= maxSteps` (`iteration` starts at zero). Consequences:

- `maxSteps: N` — **N−1** working steps and **one** limit step (not "N working steps, then a report");
- `maxSteps: 1` — only the limit step (no tool calls in the turn);
- `maxSteps` not set (or `<= 0`) — no limit (`DEFAULT_MAX_ITERATIONS = Infinity`).

### 8.2 What happens on the limit step

- **`tools` stay in the request** — otherwise the provider's cached prefix is lost and the model
  starts printing call markup as text;
- tool calls are forbidden via `toolChoice: 'none'` (Ollama — see §7.4);
- the "answer with text only" instruction is inserted as an **assistant message** at the end of the
  request (`prompts/system/MAX_STEPS.{lang}.md`, override —
  `{dataDir}/user/system/MAX_STEPS.{lang}.md`, fallback — `MAX_STEPS_FALLBACK_PROMPT` with `{limit}`
  substituted); it is **not written to session history**;
- a "disobedient" tool call (the provider returned `tool_calls` despite `none`): the calls are not
  executed, but `assistant(tool_calls)` is persisted and each call gets a paired `tool` result with
  `isError` and the key `tool.disabled_by_step_limit` (`{tool}`, `{limit}`), plus a published
  `tool_call.result`; the `toolUse`/`toolResult` pairs are never broken (otherwise the next call would
  get `400` "insufficient tool messages following tool_calls").

### 8.3 Reports and markers

| Where | What |
|---|---|
| Main agent, empty answer | `session.steps_limit` (`{limit}`); response status — `limit` |
| Main agent, has text | that text becomes the report |
| Final assistant message metadata | `step_limit_reached: true` |
| `stream.done` | `step_limit_reached: true` (additive field) |
| Subagent, empty answer | `task.steps_limit_empty` (`{limit}`) |
| Subagent, safeguard after the report | the `task.steps_limit` suffix (`[steps_limit]`) — always when the limit step ran |
| Child message and parent `task` result metadata | `step_limit_reached: true`, `step_limit: N` |

The "limit step really ran" flag is set by the loop itself: the report is substituted only when the
synthetic prefill actually went into a request. The `session.max_iterations` key is no longer used by
the main loop (it remains for pipeline steps).

## 9. Security and observability

- **The only call path** — `GatewayProvider` (ADR-036): guard, obfuscation, rate limit, audit, output
  guard; `embed` and `decide` go through the same wrapper. Calling an adapter directly violates the
  invariant.
- **TLS/proxy** — the single egress layer (ADR-099): providers go only through `egressFetch` and never
  create their own HTTP agents; CA/mTLS trust and the proxy route are set by `security.tls`/`proxy`
  and applied at startup.
- **Prompt cache** — ADR-070: `SystemPromptPayload` (`text`/`stablePrefix`/`cacheKey`/`cachePolicy`/
  `stableToolCount`) passes through the Gateway unchanged; markers are placed in the provider after
  guard/obfuscation; hit statistics — `usage.ts` (`cacheReadTokens / inputTokens`).
- **Metrics** — ADR-094: `synth_llm_requests_total`, `synth_llm_duration_seconds`,
  `synth_llm_tokens_total` (labels `provider`/`model`/`outcome`, no session ids); catalog —
  [OBSERVABILITY.md](../OBSERVABILITY.md) (RU).
- **Errors** — the ADR-041 taxonomy (`classifyLlmError`/`isLlmErrorRecoverable`,
  `engine/llm-error.ts`): transport errors are retried, invalid output (including incomplete-stream)
  is not; engine strings go through `shared/i18n` keys.
- **Attachments** — ADR-115: modalities are catalog data; the guard/obfuscation work only with text,
  and metadata is stripped by `stripMetadata` at the send boundary.

## 10. Diagnostics: symptom → cause → setting

| Symptom | Cause | What to configure |
|---|---|---|
| `400` "The `reasoning_content` in the thinking mode must be passed back to the API" | A DeepSeek-compatible gateway with a "non-default" provider/model name: the heuristic did not fire, so assistant messages go out without the reasoning field | `compatibility.requireReasoning: true` (and/or `reasoningField` with the actual field name) on the provider or the model |
| `400` about `thinking`/`signature` (Anthropic) | Thinking is disabled in this request while history contains blocks; or the signature was lost on a multi-block response | do not mix `reasoningLevel` within one session; the signature is stored per block (§6.2) — check the record was not created by an older core; for gateways without signatures use `reasoningLevel: none` |
| `400` "max_tokens must be greater than thinking.budget_tokens" | The output limit is smaller than the thinking budget (hard-coded budget with a small `max_tokens`) | the budget is now derived from the actual `max_tokens` (§6.1); if `max_tokens ≤ 1024` thinking is disabled automatically; raise the model's `maxOutputTokens`/the provider's `maxTokens` |
| `temperature` has no effect with thinking (Anthropic) | The API requires `temperature: 1` when thinking is enabled | by design; to control variability lower `reasoningLevel` or disable thinking |
| `tool_choice: required` does not work with thinking | Anthropic forbids a forced tool call with thinking — it is coerced to `auto` | drop `required` or disable thinking |
| The stream fails with "The provider closed the stream without finish_reason" | `requireFinishReason: true` (default) while the server does not send `finish_reason` | `compatibility.requireFinishReason: false` for that provider/model (the error is unrecoverable, retries will not help) |
| The prompt cache does not work | The provider caches only via inline markers while `cacheFormat` is not set (so `prompt_cache_key` is used), or the opposite | set `compatibility.cacheFormat: anthropic`/`alibaba` (then `prompt_cache_key` is not sent), or remove it and rely on implicit caching |
| Duplicated/extra cache markers | `cacheFormat` is set but the proxy/gateway adds its own `cache_control`; or markers were already present in the body | the budget of ≤ 4 counts markers already present; do not set `cacheFormat` when the gateway has its own cache; `cachePolicy: 'none'` disables markers for debugging |
| The model calls tools on the step-limit step (Ollama) | Native `/api/chat` does not know `tool_choice` | expected: calls are not executed and a deterministic report arrives (§7.4); raise the agent's `maxSteps` |
| `tool_choice` is unsupported (`400` unknown field / ignored) | A non-standard server | `compatibility.supportsToolChoice: false` (already the default for native Ollama) |
| Stream `usage` is zero | The server does not support `stream_options` | `compatibility.streamUsage: false` (the request stops carrying an unknown field; usage stays zero) |
| `400` about `output_config` / `effort` (Anthropic) | `supportsEffortUpdates` is on but the gateway does not know the field; or the model is not an effort-tier one | remove `supportsEffortUpdates` (the previous `thinking` mode returns); send `xhigh`/`max` only via an explicit `ChatOptions.effort` and after verifying on the live provider |

## 11. Known limitations

- **`supportsEffortUpdates` is partially implemented.** Anthropic effort mode (`output_config.effort`,
  §6.1) is enabled only by an explicit flag; tiers come from `reasoningLevel` (`low|medium|high`) or
  from an explicit `ChatOptions.effort`. Difference from opencode: there, effort markers are carried in
  history (a system message with an `effort` part) and there is a mid-turn UI switch for the level.
  Here effort is applied **per request**: a level change between steps is picked up, but there are no
  history markers and the prompt cache may be invalidated when the level changes; there is no mid-turn
  UI switch.
  Effort is not forwarded through **hybrid mode**: the LLM Proxy (backend) does accept
  `reasoning_effort` and passes `compatibility` through, but the hybrid `RemoteProvider` does **not
  send** it (it passes only `toolChoice` to the proxy) — in a remote session effort is lost.
  Official `api.anthropic.com` was not tested in effort mode (checks were mock-based).
- **Thinking-block filter — agent role + `provider/model` pair.** Blocks are dropped only when both
  halves of the pair are known — for the message and for the current request — and they differ; legacy
  messages without a pair keep the previous behaviour (`sessionMessagesToLlm(..., currentPair)`).
  Residual: `buildPromptHistoryInfo` does not pass the pair, so the reasoning-character counter in prompt
  diagnostics may count blocks that will not be sent (cosmetic statistics). A signature is replayed only
  when thinking is enabled in that request.
- **Official `api.anthropic.com` was not exercised** live: thinking round-trip and step-limit prefill
  checks were done on Anthropic-compatible RouterAI (qwen) and on `deepseek-anthropic`. For strict
  Anthropic the prefill behaviour with thinking enabled should be re-checked.
- **`tool_choice: 'none'` + `tools` on `deepseek-anthropic` is unverified.** That is the step-limit
  path; if a `400` appears on this endpoint, look here.
- **`cacheFormat` has no auto-heuristics.** The inline marker format is enabled only by an explicit
  value; it is not inferred from the provider name/URL (so existing catalog records do not start
  placing markers). Same for `maxTokensField`, `streamUsage`, `requireFinishReason`.
- **Env provider sync (`SYNTH_PROVIDER_*`) does not carry `compatibility`** (nor `timeout`/`currency`/
  `icon`) — those fields are set via the API/catalog JSON; env provisioning is good for the initial
  setup, not for fine-grained compatibility.
- **Token-based tariffs only** reach prices during catalog sync: `request`/`second`/`image`/
  `search_unit` tariffs are ignored (the price stays empty).
- **No modality reference table.** If the provider catalog does not report modalities, no restriction
  is applied: an incompatible type is rejected by the provider itself (an error instead of silent loss,
  but without a pre-flight check).
