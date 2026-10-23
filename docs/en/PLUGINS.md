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

---

## 5. Two execution modes

One extension point contract — two transports. The mode is set by the manifest's `mode`.

| Aspect | `inline` | `out-of-process` (`remote`) |
|---|---|---|
| Where the code runs | in the core process | a separate Node process, HTTP/1.1 + JSON |
| Isolation | none | process-level: a crash/a memory leak does not bring down the core |
| Latency | ~0 | a round-trip per point call |
| Access to internals | yes (limited by the facade and discipline) | only serializable DTOs |
| What the bundle needs | `dist/index.js` | `dist/server.js` |
| When to choose | `llmFilters` (the hot path), fast blocks, simple tools | heavy filters (ML, antivirus, DLP), blocks with a heavy load, untrusted code |

`mode: "both"` is a compromise: the host chooses `inline` if the bundle has `dist/index.js`,
otherwise `remote`. For `both` the bundle should have both entry points if you want predictability.

### 5.1. `inline`: the module contract

The host does an `import()` of the entry point and accepts **one of three forms**:

```typescript
export function apply(facade) { /* … */ }        // 1
export default { apply(facade) { /* … */ } };    // 2
export default function apply(facade) { /* … */ }// 3
```

Any other form → `plugin.module_invalid` ("the module was loaded, but the contract was not
fulfilled"). Loader restrictions: the file must lie inside the installation directory (containment by
`realpath` — `..`, absolute paths and symlinks pointing outside are rejected), the extension is
only `.js`/`.mjs`, the entry file size is ≤ 8 MiB. The `import()` is done with cache-busting
(`?v=<contentHash|mtime>`), so a reinstall does not serve the old module.

### 5.2. `out-of-process`: the wire protocol

```text
GET  /health        → 200 (no token; the process is alive)
GET  /capabilities  → { protocol: 1, name, version, points: { promptBlocks?, llmFilters?, tools? } }
POST /invoke        → { protocol: 1, point, id, input } → { output }
```

- **Loopback only**: `127.0.0.1`/`::1`/`localhost`, the scheme is `http://`.
- A **bearer token** on `/capabilities` and `/invoke` (not on `/health`). The token is the
  instance's, from the file `{dataDir}/secrets/plugin-token` (`0600`); the host passes it to the
  process in the environment.
- The **process environment** is exactly: `PATH`, `NODE_ENV`, `SYNTH_PLUGIN_PORT=0`,
  `SYNTH_PLUGIN_TOKEN`. No other Synth process variables are passed to the plugin.
- **Readiness**: the server prints to **stdout** the line `SYNTH_PLUGIN_READY port=<n>`; the host
  reads it and then polls `/health`. Stdout only: diagnostics go to stderr.
- **Errors**: `{ error: { reason, message } }` with `reason` from `invalid_request`/`unknown_point`/
  `unknown_id`/`unauthorized`/`timeout`/`internal_error`/`protocol_mismatch`.
- **Identity**: `name`/`version` in `/capabilities` must match the manifest, otherwise
  `protocol_mismatch` (fail-closed).
- **Tools** are declared in `points.tools[]` (`name` — local, `description`, `parameters?` — a JSON
  Schema, `capabilities` — **mandatory**), and not through `apply()`: there is no code in the host
  process.

A minimal server (`dist/server.js` is a **script**, the host runs it: `node dist/server.js`):

```typescript
// src/server.ts  →  dist/server.js
import { createServer } from 'node:http';

const TOKEN = process.env.SYNTH_PLUGIN_TOKEN ?? '';
const PORT = Number(process.env.SYNTH_PLUGIN_PORT ?? '0');
const PLUGIN = { name: 'my-plugin', version: '0.1.0' };

const server = createServer((req, res) => {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/health') {
    json(200, { status: 'ok' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    json(401, { error: { reason: 'unauthorized', message: 'bad token' } });
    return;
  }
  if (req.method === 'GET' && req.url === '/capabilities') {
    json(200, {
      protocol: 1,
      ...PLUGIN,
      points: {
        promptBlocks: [
          { key: 'plugin.my-plugin.notes', tier: 'context', order: 120, title: 'Project notes' },
        ],
        tools: [
          {
            name: 'notes_search',
            description: 'Searches for a note by keyword.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
            capabilities: ['search'],
          },
        ],
      },
    });
    return;
  }
  // POST /invoke: parse the body, call the point, answer { output } — see the DTO format
  json(400, { error: { reason: 'unknown_point', message: 'not implemented in example' } });
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : PORT;
  // The only line the host reads from stdout.
  console.log(`SYNTH_PLUGIN_READY port=${actual}`);
});

process.on('SIGTERM', () => process.exit(0));
```

The types `PluginServerOptions`/`PluginServerHandle`/`PluginServerFactory` in `@itphx/synth-shared`
describe the shape of the server for tests and helper wrappers; **the host itself does not import
the factory** — it runs the file as a script and waits for the readiness line.

Building the second entry point: `esbuild src/server.ts --bundle --format=esm --platform=node
--target=node20 --outfile=dist/server.js`.

> **A `package.json` with `"type": "module"` is mandatory** in the bundle root: without it Node
> treats a `.js` file as CommonJS, and `import`/`export` in the entry point do not work (this
> concerns both modes).

### 5.3. What crosses the boundary

Only serializable DTOs:

| Point | Input | Output |
|---|---|---|
| `promptBlocks` | `PromptBlockContext` | `{ content, provenance?, status? }` (a string/`null` is also allowed) |
| `llmFilters` | `LlmFilterInput` | `LlmFilterVerdict` |
| `tools` | `{ parameters, context: { sessionId, messageId, workingDir } }` | `{ content, isError? }` |

Storage ports, the core registries, `GatewayProvider`, `ToolContext.extra` are **not** exposed
outwards.

---

## 6. Bundle rules (bundle-only)

A plugin is distributed as a **self-contained ESM bundle**: everything needed at runtime is inlined
into the bundle files. `npm install` is not run for a plugin, `node_modules` never appears, and
there is no runtime resolution of npm dependencies.

### 6.1. What may and may not go into the bundle

| Artifact | Rule |
|---|---|
| ordinary files and directories | yes |
| `node_modules/`, `.git/` | are not part of the bundle (skipped during installation) |
| symlinks | are not read: they are skipped during installation, and in archives they are **rejected** (fail-closed) |
| devices, FIFOs, hardlinks | are rejected in archives |
| the entry point | `.js`/`.mjs`, inside the bundle directory, ≤ 8 MiB |
| `@itphx/*` | may be left external, but the **safer** option is `import type` only (erased by the build): a runtime import of a host package requires a permission from the plugin directory |
| other npm dependencies | must be inlined into the bundle |
| binary assets | are copied byte for byte; only the text files enter the `content_hash` (the scanner sees the binary ones too) |

### 6.2. What the scanner does

The scanner is **static and advisory**: the code is not executed, the scanner only issues a verdict;
the install policy matrix blocks the installation (§7). The categories of findings (7):

| Category | What it looks for |
|---|---|
| `exfiltration` | reading `process.env`, access to `.env`/`id_rsa`/`credentials.json`/certificates, `~` |
| `injection` | "ignore previous instructions", requests to reveal the prompt, a role change, hiding from the user, inline shell |
| `destructive` | `rm -rf`, filesystem deletion, `DROP`, `chmod 777`, `sudo`, `child_process` |
| `persistence` | `crontab`, `systemd`, shell rc files, `authorized_keys`, global installations, install scripts |
| `network` | network calls, sockets, DNS, remote execution |
| `obfuscation` | encoded strings, `eval`, dynamic imports |
| `invisible_unicode` | zero-width, bidi, unicode tags, soft hyphen |

The `severity → verdict` boundaries: `info|low → safe`, `medium → caution`, `high|critical →
dangerous`. The verdict of the bundle is the maximum over the findings.

The structural quotas: **50** files, **1024 KiB** in total → no higher than `caution`; **256 KiB** per
file or an executable binary → `dangerous`. The exceptions are `.skillignore` files in the gitignore
style (`#`, `!`, `/`, `*`, `**`, "the last match wins").

The practical conclusion: do not write `child_process`, `eval`, a read of `process.env` next to the
network, or "hidden" unicode characters in the bundle — that is either `caution` (a manual
confirmation) or `dangerous` (a block).

---

## 7. Trust and install policy

Plugins inherit the extension trust model (PROP-068 §4). The levels (from the highest):
`builtin` → `verified` → `trusted` → `community`. The level is **resolved by the source**, not by
the manifest:

| Installation source | Where the trust comes from |
|---|---|
| CLI `synth plugin install --trust <level>` | the flag value (default `community`) |
| API `POST /api/v2/plugins/install { trustLevel }` | the request value |
| the deploy directory (`plugins.deployDir`) | `plugins.deployTrust` (default `trusted`) |
| the extension registry | the `trust_level` of the registry entry — the **source of truth** for publication |

`trust` in the manifest is only an **upper bound** (a claim); the actual level is determined by the
source. Trust cannot be raised by the manifest.

### 7.1. Trust floor

`plugins.trustFloor` (`trusted` by default) is the minimum level **for installing** a plugin. The
check runs **before** the install policy and before the scan decision:

```text
manifest → bundle contents/hash → fail-closed (scan+executionEnabled) → trust-floor → scan →
runtime-install → install-policy (allow/ask/block)
```

If the trust is below the threshold — a refusal `plugin.trust_below_floor` (nothing is written to
disk). That is why a local plugin is installed with `--trust trusted`: otherwise the default
`community` does not pass the threshold.

### 7.2. The install policy matrix for plugins

For `kind: "plugin"` a separate cell of the matrix applies — it **does not depend** on the trust:

| Scan verdict | Decision | What happens |
|---|---|---|
| `safe` | `allow` | installation into `installed/<name>@<version>/`, an entry in the lock |
| `caution` | `ask` | the bundle goes to `quarantine/<name>@<version>/`; the installation is **not finished** — an explicit `approve` is needed |
| `dangerous` | `block` | a refusal `plugin.scan_rejected` |

Confirming the quarantine (`synth plugin approve <name>` / `POST /api/v2/plugins/:name/approve`)
re-runs the gates and compares `PLUGIN_INTEGRITY.json` with the actual hash; after that the bundle
is moved into `installed/`.

### 7.3. Managed plugins (deploy-time)

Plugins delivered **by an image or a PVC** (`plugins.deployDir`) are installed when the instance
starts and **cannot be removed** via the API/CLI:

- `plugins.deployTrust` (default `trusted`) — the trust of the deploy bundles;
- `plugins.managedReadonly` (default `true`) — a plugin is managed ⇔ `managedReadonly` is on and
  (`lock.source === "deploy"` or `lock.identifier` is inside `deployDir`);
- an attempt to `DELETE /api/v2/plugins/:name` or to update → `403 plugin.managed_readonly` (the
  CLI exits with code 1).

Why it is so: a plugin removed by hand would come back on the next start, and an `update` would
replace the image's delivery. Changing such a plugin means a **new image or a redeployment of the
directory**. For the author this means: if your plugin is planned for the managed contour, its
version must be raised together with the image.

---

## 8. Testing a plugin

### 8.1. The layer's contract suite

The core has a "passport" of the extension contract — `describePluginContract`
(`@itphx/synth-core`): a set of checks that the layer must satisfy. It runs on **8 fixtures** (the
reference one plus one violation each: `stable-block`, `bad-phase`, `bad-verdict`, `provides-mismatch`,
`unknown-capability`, `reserved-tool-name`, `untrusted-deny`) and on **two transports** — 23 checks
per transport.

What exactly is checked:

| Block | Checks |
|---|---|
| `promptBlocks` | the tier/keys/`order`; `stable` is rejected; the character budget; `status` (`empty`/`truncated`); the block lands in the prompt, `provenance` = `plugin:<name>` |
| `llmFilters` | valid phases; the traversal order = the registration order; the default `failMode` matches the trust; an unknown verdict is treated per `failMode`; the downgrade of an untrusted veto |
| `tools` | the namespace `plugin_<ns>_<tool>`; no collision with the builtin/MCP ones; the source `plugin`; the tool is visible to the permission layer and can be forbidden; `deregister` works |
| `provides` | the reconciliation of all three kinds of contributions by name |
| dispose | after `deactivate()` not a single registration is left |
| the ban on bypasses | an unknown/reserved capability, a foreign namespace, a declared trust above the actual one |

> **An honest clarification.** `describePluginContract` is the "passport" of the **layer**: the
> fixtures are built into the core, and an arbitrary bundle cannot be substituted there. To verify
> **your** plugin use the recipe from §8.2 — it checks the same properties on your bundle.
>
> The contract suite is available through a separate subpath (it is not part of the main package
> bundle — it needs `vitest`, which is absent from the production image):
>
> ```typescript
> import { describePluginContract, createContractHarness } from '@itphx/synth-core/engine/plugins/contract.js';
> ```
>
> `createContractHarness` assembles the reference harness (the registries, the composer, the gateway,
> the permission layer) — it can be reused in the integration test of your bundle instead of a manual
> assembly.

### 8.2. An integration test for your plugin

`PluginHost`, `PromptBlockRegistry`, `LlmFilterRegistry`, `ToolRegistry` and
`createInlinePluginLoader` are public exports of `@itphx/synth-core`. That is enough to run the
"passport" on **your** bundle:

```typescript
// test/contract.test.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  PluginHost,
  PromptBlockRegistry,
  LlmFilterRegistry,
  ToolRegistry,
  createInlinePluginLoader,
} from '@itphx/synth-core';
import { pluginsConfigSchema } from '@itphx/synth-shared';

const ROOT = process.cwd();               // the plugin directory
const read = (rel: string) => readFile(join(ROOT, rel), 'utf8');

/** A minimal audit journal: the host needs a port, the content does not matter to the test. */
const audit = {
  entries: [] as unknown[],
  async append(entry: unknown) { this.entries.push(entry); },
  async list() { return this.entries; },
  async clear() { this.entries = []; return 0; },
} as never;

describe('the my-plugin plugin contract', () => {
  let host: PluginHost;
  let tools: ToolRegistry;
  let promptBlocks: PromptBlockRegistry;
  let llmFilters: LlmFilterRegistry;

  beforeEach(() => {
    tools = new ToolRegistry();
    promptBlocks = new PromptBlockRegistry();
    llmFilters = new LlmFilterRegistry();
    host = new PluginHost({
      audit,
      // For the test the trust must not interfere: the `community` policy + execution enabled.
      config: { ...pluginsConfigSchema.parse({}), executionEnabled: true, trustFloor: 'community' },
      hostVersion: '0.12.0',
      loader: createInlinePluginLoader(),
      tools,
      promptBlocks,
      llmFilters,
      logger: { warn: () => undefined },
    });
  });

  it('activates, provides a block, a filter and a tool; deactivates with no leftovers', async () => {
    const manifest = JSON.parse(await read('synth.pack'));
    const result = await host.activate(
      {
        name: manifest.name,
        version: manifest.version,
        manifest,
        rootDir: ROOT,
        entry: 'dist/index.js',
        trustLevel: 'trusted',
        installKind: 'deploy',
        files: { 'synth.pack': await read('synth.pack'), 'dist/index.js': await read('dist/index.js') },
      },
      { actor: 'test' },
    );

    expect(result.outcome).toBe('activated');

    // promptBlocks: the key, the tier, the provenance
    const block = promptBlocks.get('plugin.my-plugin.notes');
    expect(block?.provider.tier).not.toBe('stable');
    expect(block?.provenance).toBe('plugin:my-plugin');

    // tools: the namespace and the source
    expect(tools.get('plugin_my_plugin_notes_search')?.source).toBe('plugin');

    // llmFilters: exactly one is registered
    expect(llmFilters.size).toBe(1);

    // dispose discipline: after deactivation the registries are empty
    await host.deactivate('my-plugin');
    expect(promptBlocks.size).toBe(0);
    expect(tools.listPlugin()).toHaveLength(0);
    expect(llmFilters.size).toBe(0);
  });
});
```

Check on your plugin the same things the passport checks:

- [ ] the block key starts with `plugin.<name>.`, the tier is not `stable`, `order` is set;
- [ ] the budget: a block longer than `plugins.promptBlockMaxChars` is truncated with
      `status: "truncated"` (check it with a long response);
- [ ] `provides` matches the actual registrations (the activation does not fail with
      `provides_mismatch`);
- [ ] the filter: the `phase` is valid; the `failMode` is deliberate; a `deny` for `community` does
      not block;
- [ ] the tool: the name is local, the capabilities are non-empty, the arguments are validated, the
      errors are returned as `isError`, not as an exception;
- [ ] after `deactivate()` there are no blocks, filters or tools left.

### 8.3. Verifying on a live instance

1. `synth plugin scan ./my-plugin` — the verdict and the findings (exit code 1 for `dangerous`);
2. `synth plugin install ./my-plugin --trust trusted` → restart the instance;
3. the "Plugins" section: activity, scan verdict, trust, mode;
4. `GET /api/v2/sessions/:id/prompt` — the block in the manifest;
5. the journal `{dataDir}/audit/plugins.jsonl` — the `install`/`activate`/`filter` actions and the
   refusal codes.

---

## 9. Installation and updates

### 9.1. Sources

| Kind | CLI | Integrity check | What is written to the lock |
|---|---|---|---|
| a directory | `synth plugin install ./my-plugin` | none (the installer reads the files) | `source: local`, the absolute path |
| a local archive | `synth plugin install ./dist/my-plugin-0.1.0.tgz` | `ref = sha256:<hash of the archive>` is computed on the fly | `source: local`, the path, `ref` |
| npm | `synth plugin install my-plugin --version 0.1.0` | the SRI `sha512` (`dist.integrity`) is **mandatory**, `shasum` — additionally; no SRI → a refusal | `source: npm`, the exact version |
| an https URL | `synth plugin install https://…/my-plugin-0.1.0.tgz --sha256 <64-hex>` | the `sha256` pin is **mandatory** | `source: url`, the URL, `ref` |

The kind of the source is derived from the `<ref>`; it can be set explicitly with
`--source dir|archive|npm|url`. For a URL the pin is mandatory: an arbitrary address without a hash
is not installed. The network goes through the shared egress layer (proxy, TLS/CA, ADR-099), the
redirects are checked (a transition to `http:` is rejected), the download limit is 32 MiB.

The archive is unpacked by its own code: ustar/pax/GNU long name are supported, only ordinary files
and directories are extracted; symlinks, hardlinks, devices, FIFOs, absolute paths, `..`, Windows
drives and exceeding the limits (500 entries / 16 MiB per file / 64 MiB in total) — a refusal.

### 9.2. CLI

```bash
synth plugin list [--json]
synth plugin install <ref> [--source …] [--version …] [--sha256 …] [--trust …] [--activate] [--yes]
synth plugin update <name> [--version …] [--sha256 …] [--activate] [--yes]
synth plugin rollback <name>
synth plugin approve <name> [--version …] [--activate] [--yes]
synth plugin enable <name> | disable <name>
synth plugin remove <name> [--keep-files] [--yes]
synth plugin scan <path> [--json]
```

The exit codes: `0` — the operation was performed (including "the bundle is in quarantine" and "it
was not installed" for `remove`), `1` — a refusal (the reason code goes to stderr). The common path
flags: `--data-dir`, `--config`, `--home`.

Remember: `install`/`update`/`remove` from the CLI are **offline operations**; they pass
`installKind: "deploy"`, so the `plugins.runtimeInstall` policy does not apply to them, and the
changes take effect after a restart. Managing a live instance — the API/UI.

### 9.3. HTTP API

| Action | Request | Success |
|---|---|---|
| the list | `GET /api/v2/plugins` | `200 { plugins: [...] }` |
| the details (manifest + integrity) | `GET /api/v2/plugins/:name` | `200 { plugin, manifest?, integrity? }` |
| installation | `POST /api/v2/plugins/install` `{source?, path?, name?, version?, url?, sha256?, trustLevel?}` | `201` installed, `202` an `approve` is needed |
| confirmation | `POST /api/v2/plugins/:name/approve` | `200` |
| enable/disable | `POST /api/v2/plugins/:name/enable` \| `.../disable` | `200 { activation }` / `200 { deactivation }` |
| removal | `DELETE /api/v2/plugins/:name` | `204` (idempotent) |
| an update | `POST /api/v2/plugins/update` `{name, version?, sha256?, activate?}` | `200 { outcome: "unchanged" \| "updated" }` |
| a rollback | `POST /api/v2/plugins/:name/rollback` | `200 { outcome: "rolled_back", version, previousVersion }` |
| the policy | `GET/PUT/DELETE /api/v2/settings/plugins` | `200` (applied after a restart) |

RBAC: managed — `ADMIN`; the installation/activation — also a service key with the scope
`addons:install`; `approve` and `DELETE` — only `ADMIN`. Core (standalone) — a single `requireAuth`.
The local sources (`dir`/`archive`) are forbidden in managed (`403 LOCAL_INSTALL_DISABLED`), the
network ones (`npm`/`url`) are allowed.

A runtime installation through the API requires `plugins.runtimeInstall: allow` (default `deny`).

### 9.4. Update and rollback

- The update source is taken **from the lock record**, not from the request body: `npm` → the name +
  the version (`latest` by default, the exact one is written to the lock); `local` → the
  directory/archive; `url` → the address + a **new mandatory** `sha256`.
- The `content_hash` matched → `unchanged` (nothing is written).
- Otherwise — an ordinary installation with the same gates (the trust is taken from the lock), the
  directory of the previous version is kept, `previous` is written to the lock — **one** step of
  rollback.
- `rollback` swaps the current and the previous versions (therefore the rollback is reversible; "two
  versions back" is two `rollback`s). No step or no directory → `plugin.rollback_unavailable`.
- An active plugin is deactivated and activated again; `activate: false` — do not activate, not
  specified — keep the state.

### 9.5. Quarantine

`caution` → the bundle goes to `quarantine/<name>@<version>/`, the lock is not written, the answer
is `202`. The confirmation (`approve`) repeats the gates and checks the integrity; the trust is
taken from `PLUGIN_INTEGRITY.json`, not guessed. Without a confirmation the plugin is not installed —
it is not in the `GET /plugins` list.

### 9.6. Deploy-time (image/PVC)

```text
plugins.deployDir/
├── analytics/  synth.pack + dist/index.js
└── notes/      synth.pack + dist/index.js
```

At startup the instance first **installs** the bundles from the directory (the same gates: manifest →
fail-closed → trust-floor → scan → install-policy), then activates what is installed according to
the lock. A matching version and `content_hash` → `skipped`; a failure of one bundle does not break
the others and does not bring down the startup. Symlinks are not read. A managed plugin is changed
only by a new image/redeployment (§7.3).

---

## 10. A plugin in hybrid mode

In hybrid mode the local core and the remote server are two worlds, and a plugin must explicitly
declare which world it serves. The server policy is set by the server operator; the plugin author
only plans for it.

### 10.1. Policy shape and allowlist

The `plugins.hybrid` section in the server config and in the runtime settings (`GET/PUT/DELETE
/api/v2/settings/plugins`):

```yaml
plugins:
  hybrid:
    mode: allowlist   # off (the default) | allowlist
    allow:            # the plugin names the server allows to run
      - my-plugin
```

- `mode: 'off'` (the default) — the **server does not restrict** plugins: neither the client-side
  activation gate nor the allowlist check via a server-scoped token is applied;
- `mode: 'allowlist'` — the server restricts: only the plugins from `allow` are permitted; **an
  empty list permits nobody**.

The env override of the mode is `SYNTH_PLUGINS_HYBRID_MODE` (the list of names stays in
`config.yaml`).

### 10.2. Discovery: what the client learns about the server

| Surface | What it returns | Who reads it |
|---|---|---|
| `GET /auth/oidc-meta` (public) | the `plugins: { enabled, mode }` signal — **without the list of names** | the local core when it connects to the server |
| `GET /api/v2/settings/plugins` (authenticated) | the `hybrid: { mode, allow }` block — the full allowlist (the list comes **only** when `mode: 'allowlist'`) | the local core (a cache with a TTL) |

An old server without the `plugins` field → the client considers the policy **unknown** and works in
the cooperative mode (see §10.4). The names are not published in the public discovery on purpose:
the full allowlist is available only to an authenticated request.

### 10.3. Level 1 — cooperative (policy compliance)

The local core **before the activation** checks itself against the server policy:

- the server is reachable, the mode is `allowlist`, the plugin is not in `allow` → the activation
  is rejected with `plugin.hybrid_not_allowed` (HTTP 403, an entry in the plugin audit journal);
- the server is unreachable or the policy is unknown → **the plugin runs**, but it is marked as "not
  verified by the server" (`serverPolicy: 'unverified'` in the API, a badge in the UI).

The gate concerns the **activation**, not the installation: a plugin can be installed, but it can
only run if the server permits it. The key of the check is the plugin name.

**What this means for the author.** Level 1 is a compliance policy, not an enforcement: the
executable code on the client stays under the responsibility of the owner of the local contour.
The client-side enforcement is **not guaranteed** — the server cannot check that the client core
really compared itself with the policy. Level 2 provides the guarantee.

### 10.4. The cooperative marker

The `serverPolicy` status in the answer of `GET /api/v2/plugins` (and in the plugin card in the UI):

| Status | Meaning |
|---|---|
| `allowed` | the server confirmed: the mode is `off` or the plugin is in the allowlist |
| `denied` | the server forbade it: the mode is `allowlist`, the plugin is not in the list (and it is not activated) |
| `unverified` | the server is unreachable or the policy is unknown — the plugin runs, but the server did not confirm it |

`unverified` is **not** a plugin error: it means that there was no server check. In the UI an
explanation about the cooperative mode is shown next to the badge.

### 10.5. Level 2 — server-scoped token (what the guarantee is)

So that a plugin can address the server, the operator issues it a **service key bound to
`plugin_id`**:

```http
POST /api/v2/plugins/token
Authorization: Bearer <admin-key>
Content-Type: application/json

{ "pluginId": "my-plugin", "scopes": ["events:ingest"], "expiresInSec": 3600 }
```

The answer — `201 { "token": "synth_svc_…", "pluginId": "my-plugin", "scopes": […], "expiresAt": … }`.
The secret is handed out **once** (at rest — sha256). It is issued by **ADMIN** (in managed) or by
the owner of the instance (in core); the scope `plugins:invoke` is always added.

The server accepts such a key **only** if the request carries a header with the same `plugin_id`:

```http
Authorization: Bearer synth_svc_…
X-Synth-Plugin-Id: my-plugin
```

Three conditions are checked (fail-closed, applied to **all** the server APIs, not only the plugin
ones):

1. the `X-Synth-Plugin-Id` header is present and matches the key's `plugin_id` — otherwise `403
   PLUGIN_ID_MISMATCH`;
2. the key has the scope `plugins:invoke` — otherwise `403 SCOPE_REQUIRED`;
3. the `plugin_id` is in the server allowlist (with `mode: 'allowlist'`) — otherwise `403
   PLUGIN_NOT_ALLOWED`.

**What this means for the author.** The token cannot be reused on behalf of another plugin, and a
key cannot be issued without the required scope: the server applies the policy itself. Level 3
(attestation — an integrity check of the client) is not part of the layer's scope.

---

## 11. Contract versioning

The Extension API contract is versioned by **semver major**:

- `contracts.extensionApi` — the range of the contract version the plugin was built against. The
  host declares the version `1.0.0`; the plugin writes `^1`. The major is compared.
- **The major changes only on incompatibility**: the removal/renaming of a field, a change in the
  semantics of a verdict, a change of the DTO shape, a tightening of what is mandatory. New optional
  fields, additional points and additive changes — a minor/patch, the major is untouched.
- `host` — an independent range of Synth versions: it answers the question "in which core was this
  verified", while `contracts` answers "on which contract the code is written".

**The deprecation window (fixed in ADR-090).** The major `N` continues to be accepted by the host
for **at least 3 minor core releases and at least 90 days** after the release of the major `N+1`
(which comes later); during that period the host supports both majors, and a warning about the
outdated contract is written to the journal/documentation. The owner's decision is recorded in
ADR-090 §9.

**What to do on `plugin.contract_mismatch`:**

1. look at the actual values in the refusal message (`expected`/`actual`);
2. update `contracts.extensionApi` to the supported major (`^1`) and rebuild the bundle;
3. if the plugin is already incompatible with the current API — release a new major version of the
   plugin; do not try to "fit" the manifest without changing the code.

`plugin.host_mismatch` is the same, but about `host`: widen the range only after verifying on the
new core version. The instance operator can add an exact version to the exceptions file
(`plugins.exactHostExceptions`, one version per line, `#` — a comment) — that is an emergency
workaround, not the norm for an author.
