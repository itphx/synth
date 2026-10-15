# Quick start

> 🌐 **English** · [Russian](../QUICKSTART.md)

> [!NOTE]
> The current user-facing version of this document lives in the documentation portal:
> https://docs.synth.itphx.ru/getting-started/quickstart/.

A short guide for end users: installation, provider setup and the first Synth launch.

## Requirements

- **Node.js** >= 22
- **pnpm** >= 11 (for installing from source)
- **Ollama** — only if you use local models (or any OpenAI/Anthropic-compatible API)

## 1. Installation

### Option 1: npm (global install)

```bash
npm i -g @itphx/synth
```

### Option 2: Docker

```bash
docker pull gitverse.ru/itphx/synth:<version>
docker run -p 4300:4300 -e SYNTH_API_KEY=my-secret-key gitverse.ru/itphx/synth:<version>
```

Always specify a version: the `latest` tag is not published (registry images are versioned only).

Or docker-compose from the repository root (`docker-compose.yml`):

```bash
git clone https://gitverse.ru/itphx/synth synth && cd synth
echo "SYNTH_API_KEY=my-secret-key" > .env
docker compose up -d
```

### Option 3: from source

```bash
git clone https://gitverse.ru/itphx/synth synth && cd synth
pnpm install
pnpm build

# Launch through the thin CLI wrapper (the UI is resolved from @itphx/synth-ui automatically)
node packages/synth/dist/cli.js serve --api-key my-secret-key
```

## 2. Provider setup (minimum)

The minimum setup is to add a provider through the CLI. Providers are stored as JSON files in `{dataDir}/providers/`.

```bash
# Ollama (local models); the recommended model is qwen3.8:27b
# ollama pull qwen3.8:27b
# URL without /v1: type: ollama talks to the native /api/chat
# (this is how num_ctx, think and tools work).
synth config provider add \
  --name ollama --type ollama \
  --url http://localhost:11434 \
  --model qwen3.8:27b
```

```bash
# Any OpenAI-compatible API
synth config provider add \
  --name my-openai --type openai \
  --url https://api.openai.com/v1 \
  --model gpt-4o \
  --api-key sk-xxx
```

Required flags: `--name`, `--type` (`openai`, `anthropic`, `ollama`). List: `synth config provider list`, delete: `synth config provider delete <name>`.

An alternative is environment variables (`SYNTH_PROVIDER_<NAME>_*`):

```bash
export SYNTH_PROVIDER_OLLAMA_URL=http://localhost:11434
export SYNTH_PROVIDER_OLLAMA_MODEL=qwen3.8:27b
export SYNTH_PROVIDER_OLLAMA_TYPE=ollama
```

See [LLM providers](./LLM_PROVIDERS.md) for details.

### Context window and `num_ctx`

`qwen3.8:27b` supports a window of **~100k–256k tokens**, but Ollama raises it only
slightly by default. `num_ctx` is **set through Synth** (`ProviderConfig.numCtx`)
and **passed** in the request body: the `type: ollama` provider talks over the
**native** `/api/chat`, so `options.num_ctx` applies (along with `think`
and the native tool format). Specify the base URL **without** the `/v1` suffix.

Setting `num_ctx` through Synth (priority: the provider's explicit `numCtx` >
the model's `contextWindow`):

```bash
# 1) CLI — the flag exists only on `config provider add` (there is no `edit` subcommand)
synth config provider add \
  --name ollama --type ollama \
  --url http://localhost:11434 \
  --model qwen3.8:27b \
  --num-ctx 262144

# 2) Environment variable (OLLAMA → ollama, `_` in the name → `-`)
export SYNTH_PROVIDER_OLLAMA_NUM_CTX=262144

# 3) API — the `num_ctx` field (also `numCtx`) in POST/PATCH /api/v2/providers;
#    GET returns the value; null/'' — reset
```

For an existing provider the field is edited via `PATCH /api/v2/providers/:name`.

**`type: ollama` works only natively.** The URL is always normalized to
`/api/chat`: an old base URL with a `/v1` suffix (or `/v1/chat/completions`)
still works — the suffix is stripped and a warning is written to the log. Ollama's
OpenAI-compatible path requires a separate provider: `type: openai`/`generic` with the URL
`http://localhost:11434/v1` (`num_ctx` does not apply there).

An alternative on the Ollama side is a server-side default window:

```bash
# 1) The primary way — the Ollama server environment variable (when starting `ollama serve`)
OLLAMA_CONTEXT_LENGTH=262144 ollama serve

# 2) Or a model with an explicit num_ctx (Modelfile)
cat > Modelfile <<'EOF'
FROM qwen3.8:27b
PARAMETER num_ctx 262144
EOF
ollama create qwen3.8-27b-256k -f Modelfile
# then use the model qwen3.8-27b-256k
```

Synth's own context budget is calculated from the model's `contextWindow`: it
is synced from Ollama (`/api/tags`) or set manually on the model; the provider's
explicit `numCtx` takes priority over `contextWindow`. But Ollama determines the
**actual** window.

## 3. Launch

```bash
synth serve --api-key my-secret-key
```

`--api-key` is optional: if no key is set (`--api-key`/`SYNTH_API_KEY`/`core.apiKey`),
`synth serve` generates a stable local key, saves it to
`{dataDir}/secrets/api-key` and prints it in full at startup — enter it in the UI.

The server listens on `http://127.0.0.1:4300` (host — `--host` or `SYNTH_HOST`, default
`127.0.0.1`; port — `--port` or `SYNTH_CORE_PORT`, default `4300`). The UI ships
together with `@itphx/synth-ui` and is resolved automatically.

Open [http://localhost:4300](http://localhost:4300) and enter the API key.

## 4. CLI chat

```bash
# One-shot request
synth chat "hello" --provider ollama --model qwen3.8:27b

# Interactive mode
synth chat --provider ollama --model qwen3.8:27b

# Just synth — straight into the interactive chat
synth
```

## Authentication

API requests (except `GET /health`) are authenticated. Roles: `ADMIN`, `USER`, `LEAD`, `AUDITOR`.

| Mode | Where | Mechanism |
|-------|-----|----------|
| API Key | backend (`SYNTH_API_KEY`) | A single key → the ADMIN role |
| API Key | core standalone (`synth serve`, `--api-key`/`SYNTH_API_KEY`; otherwise an auto-generated key at `{dataDir}/secrets/api-key`) | A single key → the ADMIN role |
| Debug | backend (`SYNTH_AUTH_DEBUG=true`) | Test users (admin-key-123, user-key-456, lead-key-789, auditor-key-012) |
| OIDC | backend (Keycloak) | JWT + cookie `user_session` |

## Next steps

- [Configuration](./CONFIGURATION.md) — environment variables and `config.yaml`
- [Routing](./ROUTING.md) — quick answers and model selection
- [Development](../DEVELOPMENT.md) — building and running from source
- [Architecture](./ARCHITECTURE.md) — components and deployment scenarios
- [Troubleshooting](./TROUBLESHOOTING.md) — known issues
