# Synth plugins: the author's guide

> 🌐 **English** · [Russian](../PLUGINS.md)

> **Purpose:** a practical path "from zero to a working plugin" — what a plugin is, how the bundle
> and the manifest are laid out, how the three extension points work, and how to install, verify and
> publish an extension.
> **Audience:** plugin authors (external developers, or Synth developers writing an extension).
> **Canonical:** ADR-090 (Extension API v1) — the trust model, manifest, wire protocol, install/update
> flow and RBAC. The decision record itself stays in Russian; see the documentation repository.
> This guide covers the same ground from the author's side: no internal rationale, only verifiable
> examples.
> **Status:** the plugin layer has been accepted as a decision (ADR-090, phases F0–F7 and deferred items
> D1–D3). Execution of plugin code is **disabled by default** (`plugins.executionEnabled: false`) —
> this is a deliberate default, not "plugins do not work".
> **Related documents:** HTTP surface — [API_V2.md](./API_V2.md) §5.36; operations — the "Plugins"
> section of the maintenance runbook (`docs/MAINTENANCE.md`, Russian); configuration keys —
> [CONFIGURATION.md](./CONFIGURATION.md) §"Plugins (`plugins.*`)"; pipelines and extension packs —
> `docs/PIPELINES.md` (Russian).

---

## Contents

1. [What is a plugin](#1-what-is-a-plugin)
2. [Quick start](#2-quick-start)
3. [`synth.pack` manifest reference](#3-synthpack-manifest-reference)
4. [Extension points](#4-extension-points)
5. [Two execution modes](#5-two-execution-modes)
6. [Bundle rules (bundle-only)](#6-bundle-rules-bundle-only)
7. [Trust and install policy](#7-trust-and-install-policy)
8. [Testing a plugin](#8-testing-a-plugin)
9. [Installation and updates](#9-installation-and-updates)
10. [A plugin in hybrid mode](#10-a-plugin-in-hybrid-mode)
11. [Contract versioning](#11-contract-versioning)
12. [Error reference](#12-error-reference)
13. [Publishing](#13-publishing)
14. [Author checklist](#14-author-checklist)

---

## 1. What is a plugin

A **plugin** is code that Synth itself executes, plugged into three ready-made seams of the core:

| Point | What the plugin contributes | Where it applies | What the plugin sees |
|---|---|---|---|
| `promptBlocks` | a system prompt block | prompt assembly (every turn) | a narrow turn context: session, agent, language, project, mode, the question text |
| `llmFilters` | an LLM call filter | the LLM gateway (`pre_request` / `post_response` / `embedding`) | request/response/embedding texts |
| `tools` | a tool for the model | the Tool Use loop, the permission layer | the call arguments and turn identifiers |

This is **not** a runtime and not "your own agent": a plugin does not start new loops, does not pick
the model and does not rewrite role prompts. It contributes exactly three kinds of contributions —
and they land in the existing subsystems (`SystemPromptComposer`, `GatewayProvider`, `ToolRegistry`).

### 1.1. What a plugin can do

- add a block to the system prompt (tiers `context`/`volatile`), including retrieval against the
  current question;
- observe LLM calls and — with sufficient trust — block them (`pre_request`, `embedding`) or redact
  embedding texts;
- register a tool that the model sees on par with the built-in ones (but under its own namespace and
  through the permission layer).

### 1.2. What a plugin cannot do

| Restriction | Why |
|---|---|
| change the model, the role prompt or prompt templates | that is not an extension point; the model is a session/instance setting |
| bypass the permission layer (`plan`/`act`/`yolo`, `allow`/`deny`/`ask`) | ADR-025/ADR-029; a plugin tool is an ordinary tool with capabilities |
| bypass the LLM gateway, its guards, rate limit and audit | ADR-036 |
| read files/secrets "directly", bypassing permissions and the API | secrets are never handed to a plugin; the filesystem is reachable only through tools and the permission layer |
| write into `$SYNTH_DATA_DIR` bypassing the storage layer | ADR-096 |
| remove or replace built-in handlers, built-in/management plugins | the `builtin` policy in `HookBus`, `plugin.managed_readonly` |
| add its own metrics/labels | the observability contract of ADR-094 |
| claim trust above the actual trust | trust is resolved by the source (registry/CLI/deploy), not by the manifest |
| pull npm dependencies at runtime | bundle-only: neither `node_modules` nor `npm install` ever appears |

### 1.3. Trust boundaries

An `inline` plugin runs **inside the core process**: technically it sees the Node API of the process.
There is no isolation — trust, the static scanner, the install policy and the trust floor (§7) form
the boundary. If that is unacceptable for your scenario, use `out-of-process` (§5): there only
serializable DTOs cross the boundary.

> **Important note on the available points.** In Extension API v1 the facade exposes **only**
> `promptBlocks`, `llmFilters` and `tools`. The other points from the ADR-090 table (hooks, providers,
> routes, commands, skills, agents, mcp, events, schedules, settings, UI slot) are **not exported**
> in v1 — a plugin cannot register for them.

---

## 2. Quick start

### 2.1. Requirements

- a Synth version that falls into the manifest's `host` range (in the example — `>=0.11.0 <0.13.0`);
- Node.js 20+ to build the bundle;
- an ESM bundle (CommonJS and TypeScript sources are not loaded: the entry point is `.js`/`.mjs`).

### 2.2. Bundle layout

```text
my-plugin/
├── synth.pack          # manifest (kind: plugin)
├── package.json        # an ordinary npm manifest (not the canonical extension manifest)
├── src/index.ts        # source
└── dist/index.js       # built ESM bundle (this is what Synth loads)
```

`package.json` is only used for the build; Synth reads **`synth.pack`**.

### 2.3. The `synth.pack` manifest (full example)

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "kind": "plugin",
  "description": "Example plugin: a notes block, a DLP filter for requests and a notes search tool",
  "host": ">=0.11.0 <0.13.0",
  "contracts": {
    "extensionApi": "^1",
    "promptBlocks": "^1",
    "llmFilters": "^1"
  },
  "mode": "inline",
  "provides": {
    "tools": ["notes_search"],
    "promptBlocks": [
      {
        "key": "plugin.my-plugin.notes",
        "tier": "context",
        "order": 120,
        "title": "Project notes"
      }
    ],
    "llmFilters": [
      {
        "id": "plugin:my-plugin:dlp",
        "phase": "pre_request",
        "failMode": "closed",
        "timeoutMs": 200
      }
    ]
  },
  "permissions": { "network": [], "secrets": [], "tools": [], "hooks": [] },
  "trust": { "level": "community", "source": "local" }
}
```

The minimum for activation: `name`, `version`, `kind: "plugin"`, `description`, `provides` with at
least one contribution. `host` and `contracts` are strongly recommended: without them the semver gate
does not check compatibility, and the plugin may "silently" activate on an incompatible host.

### 2.4. Plugin code (full example)

```typescript
// src/index.ts
import { z } from 'zod';
import type { LlmCallFilter, PromptBlockProvider } from '@itphx/synth-shared';
import type { PluginFacade } from '@itphx/synth-core';

/** The plugin's own local reference (in a real plugin — your data source). */
const NOTES: Record<string, string> = {
  'release': 'Release 0.12.0: the plugin layer is complete (F0–F6).',
  'encryption': 'At-rest secrets — AES-256-GCM, the master key lives in secrets/master.key.',
};

/** The `promptBlocks` point: a context block that depends on the turn's question. */
const notesBlock: PromptBlockProvider = {
  key: 'plugin.my-plugin.notes',
  tier: 'context',
  order: 120,
  title: 'Project notes',
  load(ctx) {
    const query = ctx.query?.trim().toLowerCase();
    if (!query) return null; // no turn question (subagent/pipeline step) — the block stays empty
    const hit = Object.entries(NOTES).find(([topic]) => query.includes(topic));
    return hit ? `Note on the topic "${hit[0]}": ${hit[1]}` : null;
  },
};

/** The `tools` point: a tool for the model (local name — no namespace). */
const searchTool: Parameters<PluginFacade['registerTool']>[0] = {
  name: 'notes_search',
  description: 'Searches the plugin local reference for a note by keyword.',
  // `parameters` — a zod schema: the host validates the arguments against it before the call.
  parameters: z.object({ query: z.string().min(1) }),
  // `jsonSchema` — what the model will see. Set it explicitly: the schema is converted by
  // the host, and your copy of zod may be a different version (see §4.3).
  jsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword' },
    },
    required: ['query'],
  },
  capabilities: ['search'],
  async execute(params) {
    // The arguments have already passed the `parameters` validation; narrow the type explicitly.
    const { query } = params as { query: string };
    const q = query.toLowerCase();
    const rows = Object.entries(NOTES).filter(
      ([topic, text]) => topic.includes(q) || text.toLowerCase().includes(q),
    );
    if (rows.length === 0) return { content: `Nothing found for "${query}".` };
    return { content: rows.map(([topic, text]) => `- ${topic}: ${text}`).join('\n') };
  },
};

/** The `llmFilters` point: a DLP check of the request. Veto — only with trust >= `trusted`. */
const dlpFilter: LlmCallFilter = {
  id: 'plugin:my-plugin:dlp',
  phase: 'pre_request',
  failMode: 'closed',
  timeoutMs: 200,
  inspect(input) {
    const text = [
      input.systemPrompt ?? '',
      ...(input.messages ?? []).map((message) => message.content),
    ].join('\n');
    if (/AKIA[0-9A-Z]{16}/.test(text)) {
      return { verdict: 'deny', code: 'aws_key', reason: 'an AWS access key was found in the request' };
    }
    return { verdict: 'allow' };
  },
};

/** The entry point: the host calls `apply(facade)` after `import()`. */
export function apply(facade: PluginFacade): void {
  facade.registerPromptBlock(notesBlock);
  facade.registerLlmFilter(dlpFilter);
  facade.registerTool(searchTool);
}
```

`package.json` for the build:

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "peerDependencies": {
    "@itphx/synth-shared": "^0.12.0",
    "@itphx/synth-core": "^0.12.0"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "typescript": "^5.7.0",
    "zod": "^3.24.0"
  },
  "scripts": {
    "build": "esbuild src/index.ts --bundle --format=esm --platform=node --target=node20 --outfile=dist/index.js"
  }
}
```

Both `@itphx/*` packages here are **for types only** (`import type`): such imports are erased during
the build, so not a single reference to the host packages survives in the bundle. `zod` is inlined
into the bundle — that is fine and matches bundle-only (§6).

### 2.5. Installation and activation

```bash
# 1. Dry run: manifest + scanner verdict + findings + content-hash (writes nothing)
synth plugin scan ./my-plugin

# 2. Install. The default trust is `community`, while the instance trust floor is `trusted`,
#    so a local plugin is installed with an explicit --trust trusted.
synth plugin install ./my-plugin --trust trusted

# 3. Verify the activation pipeline in the one-shot CLI process
synth plugin enable my-plugin

# 4. List what is installed and its activation status
synth plugin list
```

Two clarifications that save an hour of debugging:

- **The CLI is an offline tool.** `install` writes the instance files and `plugins.lock.json`, but it
  does not switch the live process; `enable`/`disable` verify the activation pipeline in the CLI
  process and **also do not switch** the running instance (the instance-restart invariant from the
  root `AGENTS.md`). Changes take effect after the instance is restarted (`./scripts/dev.sh`,
  `synth serve`, a pod restart).
- **Execution of the code must be enabled.** While `plugins.executionEnabled: false` (the default),
  activation stops at the `import` step with the code `plugin.execution_disabled`. Turn the key on in
  `config.yaml` (or via `PUT /api/v2/settings/plugins`) **and restart** the instance.

For a **live** instance, activation is done over HTTP/UI: `POST /api/v2/plugins/:name/enable`
(or the "Enable" toggle in the admin "Plugins" section). Installation through the API is a
runtime installation: it requires `plugins.runtimeInstall: allow` (default `deny`) and the `ADMIN`
role.

### 2.6. Verifying the result

1. **The block in the prompt.** Open a session, send a message containing the word "release" and ask
   for the prompt composition:

   ```bash
   curl -s http://localhost:5000/api/v2/sessions/<sessionId>/prompt \
     -H 'Authorization: Bearer admin-key-123' | jq '.manifest.entries[] | select(.key=="plugin.my-plugin.notes")'
   ```

   Expected: an entry with `tier: "context"`, `source: "system"`, `provenance: "plugin:my-plugin"`,
   `status: "loaded"` (or `"empty"`, if the question contains no topic from the reference).

2. **The tool.** In the same turn ask the agent: "find the note about the release using the
   `plugin_my_plugin_notes_search` tool". The full name is `plugin_<namespace>_<local name>`, where
   the namespace is derived from the plugin name (`my-plugin` → `my_plugin`); `provides.tools[]`
   declares the **local** name (`notes_search`).

3. **The filter.** Put a test AWS key into the request — the call must be rejected. Remember: the
   veto works only for a plugin whose actual trust is ≥ `trusted` **and** when the LLM gateway is
   enabled (`llmGateway.enabled: true`). For a `community` plugin, `deny` is downgraded to `allow`
   (the log shows `plugin_filter.deny_downgraded`).

4. **Status and journal.** `GET /api/v2/plugins` (or the "Plugins" section) shows the version, mode,
   trust, scan verdict, content-hash and activity; the operations journal is
   `{dataDir}/audit/plugins.jsonl`.

---

## 3. `synth.pack` manifest reference

`synth.pack` is JSON in the bundle root. Parsing: `packManifestSchema` + `validatePackManifest`
(`packages/shared/src/types/pack.ts`). The schema is **strict** where it matters: for
`provides.promptBlocks[]`/`provides.llmFilters[]` an unknown field is an error, not a silent pass.

| Field | Required | What it is | Rules |
|---|---|---|---|
| `name` | yes | the plugin name | slug (`my-plugin`) or a scoped npm name (`@acme/synth-plugin-x`); lowercase Latin letters/digits, the separator is `-`; ≤ 214 characters. The tool namespace is derived from it |
| `version` | yes | the plugin version | semver `MAJOR.MINOR.PATCH` (+ prerelease/build) |
| `kind` | yes | the extension class | for a plugin — strictly `"plugin"` |
| `description` | yes | a short description | a non-empty string; visible in the inspection/catalog |
| `host` | no | a range of Synth versions | a semver range, a conjunction separated by a space (`>=0.11.0 <0.13.0`); `\|\|` is not supported. A mismatch — `plugin.host_mismatch` |
| `contracts` | no | contract versions | the values are semver ranges. **Only `contracts.extensionApi` is checked** (the major of the host contract; it is `1` now, the host declares `1.0.0`). The `promptBlocks`/`llmFilters`/`tools` keys are a declaration for the reader and for future checks. A major mismatch — `plugin.contract_mismatch` |
| `mode` | no | the execution mode | `inline` \| `remote` \| `both`; `inline` by default. The field is allowed only for `kind: "plugin"` |
| `provides` | yes | the declared contributions | see below; an empty `provides` is an invalid manifest |
| `permissions` | no | the declared accesses | `{ network: string[], secrets: string[], tools: string[], hooks: string[] }`. This is a **declaration**, not a permission: the actual access is decided by the permission layer and the egress policy |
| `trust` | no | the declared level/source | `{ level?: 'builtin'\|'verified'\|'trusted'\|'community', source?: string }`. An upper bound, never an increase: the actual level is resolved by the source. A plugin with a `level` above `trusted` (`builtin`/`verified`) is a **manifest error**; `trusted` and `community` are allowed |

### 3.1. `provides` — what exactly is validated

```json
"provides": {
  "tools": ["notes_search"],
  "promptBlocks": [{ "key": "plugin.my-plugin.notes", "tier": "context", "order": 120, "title": "Project notes" }],
  "llmFilters": [{ "id": "plugin:my-plugin:dlp", "phase": "pre_request", "failMode": "closed", "timeoutMs": 200 }]
}
```

| Key | Shape | Rules |
|---|---|---|
| `tools[]` | an array of strings | non-empty, without duplicates; **local** names (without the `plugin_` prefix) |
| `promptBlocks[]` | `{ key, tier, order, title?, provenance? }` | `tier` — only `context`/`volatile`; `stable` is invalid; `key` is unique within the array; `order` is an integer; extra fields are forbidden |
| `llmFilters[]` | `{ id, phase, failMode?, timeoutMs? }` | `phase` — `pre_request`/`post_response`/`embedding`; `timeoutMs` is a positive integer; extra fields are forbidden |

The `mcp`/`skills`/`agents`/`pipelines` keys are usually empty for a plugin: they belong to other
extension classes. If a plugin declares `tools`/`promptBlocks`/`llmFilters`, the **actual
registrations must match the declaration by name** — otherwise activation is rejected with
`plugin.provides_mismatch` (§4.4).

> **An empty `provides` is invalid.** A plugin without a single contribution will not install:
> `validatePackManifest` requires at least one element.

---

## 4. Extension points

The contract of all three points lives in `@itphx/synth-shared` (browser-safe: only types and pure
functions). The facade is `PluginFacade` from `@itphx/synth-core`; on activation the host calls
`apply(facade)`.

```typescript
export type PluginDisposer = () => void | Promise<void>;

export interface PluginFacade {
  registerDisposer(disposer: PluginDisposer): void;
  registerPromptBlock(provider: PromptBlockProvider, opts?: { title?: string }): PluginDisposer;
  registerLlmFilter(filter: LlmCallFilter, opts?: { failMode?: 'open' | 'closed'; timeoutMs?: number }): PluginDisposer;
  registerTool(def: PluginToolDefinition): PluginDisposer;
}
```

Every registration returns a **disposer** — the inverse operation. On deactivation the host calls
the disposers **in the reverse order of registration**; a failure of one does not interrupt the
others. A `disposer` is idempotent — a repeated call does nothing.

A refused registration (a taken key, the tier `stable`, a reserved capability) **does not fail
activation**: the host writes a warning and returns a no-op disposer. But if such a contribution
was declared in `provides`, the reconciliation turns it into an activation failure.

### 4.1. `promptBlocks` — a system prompt block

```typescript
export const PROMPT_BLOCK_PROVIDER_TIERS = ['context', 'volatile'] as const;

export interface PromptBlockProvider {
  readonly key: string;
  readonly tier: 'context' | 'volatile';
  readonly order: number;
  readonly title?: string;
  load(ctx: PromptBlockContext): Promise<PromptBlockContent | string | null> | PromptBlockContent | string | null;
}

export interface PromptBlockContext {
  readonly sessionId: string;
  readonly agentRole: string;
  readonly language: string;
  readonly projectId?: string;
  readonly mode: 'plan' | 'act' | 'yolo';
  readonly query?: string;   // the text of the last user message
  readonly turnId?: string;  // the turn identifier
  readonly timestamp?: string;
}
```

**Where the block lands.** `SystemPromptComposer` walks the providers while assembling the prompt
and puts their blocks into **the same** array as the built-in ones: one sort (tier → `order`), one
concatenation, one manifest. In the manifest (`GET /api/v2/sessions/:id/prompt`) an entry looks like
`{ key, tier, order, source: "system", provenance: "plugin:<name>", status }`.

**Rules and restrictions.**

| Rule | Details |
|---|---|
| the tier `stable` is forbidden | `stablePrefix` is the prompt-cache boundary (ADR-070); a registration with `stable` is rejected, there is no silent downgrade to `context` |
| the key is unique within the instance | the recommended form is `plugin.<pluginName>.<slot>`; a taken key → a refused registration |
| `order` | a number inside the tier; for plugins `order ≥ 100` is recommended, so as not to compete with the built-in blocks (they occupy 5–90) |
| `provenance` | the host substitutes `plugin:<name>` automatically; it can be overridden in the returned object |
| character budget | `plugins.promptBlockMaxChars` (4 000 by default). If it does not fit — the **host** truncates the block (head + tail with a `[TRUNCATED: …]` marker) and sets `status: "truncated"` |
| degradation | an exception from `load()` → a `warning` in the log, the block is empty, the **turn does not fail** |
| no turn question | `query` is not set for the `task` subagent and for a pipeline step; a `volatile` block should sensibly stay empty in that case (the host does not require it) |
| prompt override | if the session has `settings.systemPrompt`, plugin blocks are **not added** (the user prompt replaces everything) |
| the `task` subagent | a known limitation: the subagent prompt is assembled outside the Composer, so a plugin block does not get there |
| a pipeline step | it goes through the Composer, but with a narrowed context: `sessionId` = `pipeline:<runId>:<nodeId>`, `query`/`turnId`/`timestamp` are not filled in |

**Example: a block with retrieval against the turn's question.**

```typescript
import type { PromptBlockProvider } from '@itphx/synth-shared';

const provider: PromptBlockProvider = {
  key: 'plugin.my-plugin.facts',
  tier: 'volatile',           // changes every turn
  order: 110,
  title: 'Facts for the question',
  async load(ctx) {
    if (!ctx.query) return { content: '', status: 'empty' };
    const facts = await searchFacts(ctx.query, { projectId: ctx.projectId });
    if (facts.length === 0) return null;           // an empty block
    const text = facts.map((f) => `- ${f.text}`).join('\n');
    return { content: text, status: 'loaded' };     // longer than the budget — the host truncates it
  },
};
```

`searchFacts` is your code: the network only through the allowed hosts (`permissions.network` + the
instance egress policy, ADR-099), secrets — not from files, but through the instance API.

### 4.2. `llmFilters` — an LLM call filter

```typescript
export const LLM_FILTER_PHASES = ['pre_request', 'post_response', 'embedding'] as const;

export interface LlmCallFilter {
  readonly id: string;
  readonly phase: 'pre_request' | 'post_response' | 'embedding';
  readonly failMode?: 'open' | 'closed';
  readonly timeoutMs?: number;
  inspect(input: LlmFilterInput): Promise<LlmFilterVerdict> | LlmFilterVerdict;
}

export interface LlmFilterVerdict {
  readonly verdict: 'allow' | 'deny' | 'redact';
  readonly reason?: string;
  readonly code?: string;
  readonly redactedContent?: string;   // only `redact` in post_response (not supported in v1)
  readonly redactedTexts?: readonly string[]; // only `redact` in embedding
}
```

**What the filter sees.**

| Phase | Data | Effect on the call |
|---|---|---|
| `pre_request` | `messages` (**the whole session history**), `systemPrompt`, `tools`, `provider`, `model`, `sessionId` | a `deny` from a trusted filter — the call does not reach the provider; `redact` is **not supported** (the host records `plugin_filter.redact_unsupported` and continues) |
| `post_response` | the full response text (`content`), `usage` | observation only: `deny`/`redact` are rejected by the host (`plugin_filter.buffering_required`) — buffering the response is forbidden (ADR-036) |
| `embedding` | `texts` (an array) | `deny` — the embedding does not go out; `redact` — the texts are replaced with `redactedTexts` (the array lengths must match, otherwise fail-closed `deny`) |

**The text is already obfuscated.** `pre_request` is called **after** the obfuscation map: the filter
sees the request in the form in which it will go to the provider (the secrets are replaced with
placeholders).

**The gateway requirement.** The filters live inside `GatewayProvider`, therefore they apply **only
when `llmGateway.enabled: true`**. With the gateway disabled the call goes around the gateway
contour and the filters are not called — that is not a plugin error.

**The right to veto.** `deny`/`redact` act only for a plugin whose actual trust is ≥ `trusted`
(`builtin`/`verified`/`trusted`). For `community` the host downgrades the verdict to `allow` and
writes `plugin_filter.deny_downgraded` to the plugin journal. Anyone may observe (audit, metrics, a
signal).

**Failure and timeout.** `failMode` applies:

- `closed` — the call does **not** go to the provider (the reason is `plugin_filter.unavailable`,
  in the error text — `plugin_filter.timeout`/`plugin_filter.error`);
- `open` — the call goes through, the failure is recorded in the gateway audit.

The default: for a blocking phase (`pre_request`/`embedding`) with the right to veto — `closed`,
otherwise `open`. The filter's `timeoutMs` takes priority over the instance's
`plugins.llmFilterTimeoutMs` (1 000 ms by default). An unknown verdict (a typo in `verdict`) is
treated as a failure — that is, per `failMode`.

**Order.** The filters are traversed in registration order; the first `deny` from a trusted filter
stops the call (the remaining filters of that phase are not called).

**Example: a DLP filter with a veto.**

```typescript
import type { LlmCallFilter } from '@itphx/synth-shared';

const filter: LlmCallFilter = {
  id: 'plugin:my-plugin:secrets',   // the convention is: plugin:<name>:<filter>
  phase: 'pre_request',
  failMode: 'closed',
  timeoutMs: 150,
  inspect({ systemPrompt, messages }) {
    const text = [systemPrompt ?? '', ...(messages ?? []).map((m) => m.content)].join('\n');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
      return { verdict: 'deny', code: 'private_key', reason: 'a private key was found in the request' };
    }
    return { verdict: 'allow' };
  },
};
```

**Example: masking embedding texts.**

```typescript
const embeddingFilter: LlmCallFilter = {
  id: 'plugin:my-plugin:embed-pii',
  phase: 'embedding',
  failMode: 'closed',
  inspect({ texts }) {
    const redacted = (texts ?? []).map((text) => text.replace(/\b\d{12}\b/g, '<ID>'));
    return { verdict: 'redact', redactedTexts: redacted };
  },
};
```

> **The streaming restriction.** In a stream the chunks go out as they are; `post_response` receives
> the already-sent response. Blocking/editing the response is deliberately not supported in v1.

### 4.3. `tools` — a tool for the model

```typescript
export interface PluginToolDefinition {
  name: string;                       // the local name, without `plugin_`
  description: string;                // the description for the model
  parameters: z.ZodTypeAny;           // a zod schema (the host validates the arguments)
  capabilities: ToolCapability[];     // mandatory
  execute: ToolExecutor;              // (params, ctx) => ToolResult
  jsonSchema?: Record<string, unknown>; // the schema for the model (otherwise converted from parameters)
}
```

**The namespace.** The name in the shared registry is composed by the **host**:
`plugin_<namespace>_<localName>`, where the namespace is the plugin name in lower case with
non-alphanumeric characters replaced by `_` (`my-plugin` → `my_plugin`). The manifest declares the
**local** name (`notes_search`) — so `provides.tools[]` does not depend on the namespace details. The
local name: `^[A-Za-z0-9][A-Za-z0-9_-]*$`, the `plugin_` prefix is forbidden (otherwise the
`provides` reconciliation would be ambiguous).

**The capabilities.** Mandatory and non-empty, the values are from `ToolCapability`: `file_read`,
`file_write`, `shell`, `search`, `web`, `git_read`, `git_write`, `task`, `user` (`mcp` and `runtime`
are **reserved**: the first is the MCP layer, the second is core primitives that an admin cannot
disable). Without capabilities the tool would be invisible to the permission layer and to the
admin's disabling, therefore the registration is rejected.

**Availability.** It is decided by the permission layer (ADR-029), not by the tool: plugin tools are
addressed by the `plugin` group (matched **by source** `plugin`, not by capability) and obey the
session mode. In `plan` mode the mutating capabilities (`file_write`, `shell`, `git_write`) get
`deny` (ADR-025), in `act` — by the rules (`allow`/`ask`/`deny`); `search`/`file_read` are available
in `plan`. The instance can disable the tool by name (`plugin_<ns>_<tool>`) or by capability via
`PUT /api/v2/settings/tools-disabled` — but that will also disable the built-in tools with the same
capability.

**What arrives in `execute`.** `(params, ctx)`, where `ctx.sessionId`, `ctx.messageId`,
`ctx.workingDir`, `ctx.agentRole?`, `ctx.abortSignal?`. Do not rely on `ctx.extra` — it is an
internal core object, its composition is not part of the contract and may change.

**Why you should set `jsonSchema`.** `parameters` is your zod schema; the host validates the
arguments with it (`safeParse`). But for the model the schema is converted by the host into JSON
Schema, and the converter recognizes the classes of **its own** copy of zod. The built bundle
carries its own copy — therefore an explicit `jsonSchema` (what the model sees) is safer and more
predictable.

**Example: a tool that returns an error without an exception.**

```typescript
import { z } from 'zod';
import type { PluginFacade } from '@itphx/synth-core';

const tool: Parameters<PluginFacade['registerTool']>[0] = {
  name: 'notes_search',
  description: 'Searches for a note by keyword.',
  parameters: z.object({ query: z.string().min(1) }),
  jsonSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  capabilities: ['search'],
  async execute(params) {
    const { query } = params as { query: string };
    if (query.length < 2) {
      // An ordinary tool error: the content goes to the model as is, the turn does not fail.
      return { content: 'The query is too short: the minimum is 2 characters.', isError: true };
    }
    return { content: `Found for "${query}": 0 notes.` };
  },
};
```

### 4.4. Reconciling "declared ↔ registered"

After `apply()` and **before** the activation is committed, the host compares `provides` with the
actual registrations across all three points:

- `promptBlocks` — by `key`;
- `llmFilters` — by `id`;
- `tools` — by the local name.

A mismatch in either direction (`missing` — declared but not registered; `unexpected` — registered
but not declared) → an **activation refusal** `plugin.provides_mismatch` with a rollback of the
registrations already made. This is not nitpicking: it is how an inconsistent build is caught (for
example, the manifest has a new version of a block, while the bundle has the old one).

Typical causes:

| Symptom | Cause |
|---|---|
| `missing: plugin.my-plugin.notes` | the name/key in the manifest and in the code diverged (a typo, a different case) |
| `unexpected: notes_search` | the tool was forgotten in `provides.tools` (or an old name was declared) |
| `missing: plugin:my-plugin:dlp` | the filter was not registered because of a refusal (an unknown phase), while `provides` still lists it |

A rejected registration does not count as "registered": for example, a block with the tier `stable`
is rejected, and if it was declared in `provides`, the activation fails with `provides_mismatch`.
