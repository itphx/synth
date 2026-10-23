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
