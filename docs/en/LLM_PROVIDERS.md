# LLM providers

> 🌐 **English** · [Russian](../LLM_PROVIDERS.md)

Synth supports providers of types `openai`, `anthropic`, `ollama`, `decision` and `systemone` (validated by `synth config provider add --type`).

## Development providers

| Name | Type | Purpose |
|-----|-----|------------|
| `itphx` | openai | Working provider (ai.itphx.ru), model `local.qwen3.8:27b` |
| `ollama` | ollama | Local Ollama (owu.itphx.loc:11434) |

## Configuration via environment variables

All provider variables share the `SYNTH_PROVIDER_<NAME>_` prefix:

### Ollama (local, free)

```bash
export SYNTH_PROVIDER_OLLAMA_URL=http://localhost:11434
export SYNTH_PROVIDER_OLLAMA_MODEL=qwen3.8:27b
export SYNTH_PROVIDER_OLLAMA_TYPE=ollama
export SYNTH_PROVIDER_OLLAMA_API_KEY=""
```

> **Context window and `num_ctx`.** The model's window is ~100k–256k tokens, but
> Ollama serves only a small one by default. `num_ctx` is **set through
> Synth** (`ProviderConfig.numCtx`) and **passed** in the request body: a provider
> with `type: ollama` talks over the **native** `/api/chat`, so `options.num_ctx`
> applies — as do `think` and the native tool format. Specify the base URL
> **without** the `/v1` suffix.
>
> How to set it (priority: the provider's explicit `numCtx` → `ModelConfig.contextWindow`
> → the reference):
>
> ```bash
> # 1) CLI — the flag exists only on `config provider add` (there is no `edit` subcommand)
> synth config provider add \
>   --name ollama --type ollama \
>   --url http://localhost:11434 \
>   --model qwen3.8:27b \
>   --num-ctx 262144
>
> # 2) Environment variable (provider name in env form: OLLAMA → ollama, `_` → `-`)
> export SYNTH_PROVIDER_OLLAMA_NUM_CTX=262144
>
> # 3) API — the `num_ctx` field (also `numCtx`) in POST/PATCH /api/v2/providers;
> #    GET returns the value; null/'' resets it
> ```
>
> For an existing provider the field is updated via `PATCH /api/v2/providers/:name`.
>
> **`type: ollama` only works natively.** The URL is always normalized to
> `/api/chat`: an old base URL with the `/v1` suffix (or
> `/v1/chat/completions`) still works — the suffix is stripped and a warning goes
> to the log. Ollama's OpenAI-compatible path needs a separate provider:
> `type: openai`/`generic` with the URL `http://localhost:11434/v1` (there `num_ctx`
> does not apply).
>
> An alternative on the Ollama side is the server-side default window:
> `OLLAMA_CONTEXT_LENGTH=262144 ollama serve` or a model with an explicit
> `PARAMETER num_ctx 262144` (Modelfile → `ollama create`).
>
> For the context budget Synth uses the model's `contextWindow` (synced
> from Ollama `/api/tags` or set manually), but the actual window is determined by
> Ollama.

### Any OpenAI-compatible API (LM-Studio, vLLM, Together, Groq, …)

```bash
export SYNTH_PROVIDER_OPENAI_URL=https://api.openai.com/v1
export SYNTH_PROVIDER_OPENAI_API_KEY=sk-xxx
export SYNTH_PROVIDER_OPENAI_MODEL=gpt-4o
export SYNTH_PROVIDER_OPENAI_TYPE=openai
```

### Anthropic-compatible API

```bash
export SYNTH_PROVIDER_ANTHROPIC_URL=https://api.anthropic.com/v1
export SYNTH_PROVIDER_ANTHROPIC_API_KEY=sk-ant-xxx
export SYNTH_PROVIDER_ANTHROPIC_MODEL=claude-sonnet-4-20250514
export SYNTH_PROVIDER_ANTHROPIC_TYPE=anthropic
```

### Decision models (System One, ADR-084)

A separate class of models: not a chat, but a `state` (text/JSON) plus typed
questions → probabilities in a single forward pass. The protocol is set by the
**provider type**:

| Type | Endpoint | Purpose |
|-----|----------|------------|
| `decision` | `POST {baseUrl}/decisions` | RouterAI and other SystemOne-compatible APIs (Bearer) |
| `systemone` | `POST {baseUrl}/v1/systemone` | Local Ollama (≥0.35.1) |

`baseUrl` is the service base URL; the provider itself appends the protocol path.

```bash
# RouterAI (remote) — type decision
export SYNTH_PROVIDER_ROUTERAI_DECISION_TYPE=decision
export SYNTH_PROVIDER_ROUTERAI_DECISION_URL=https://routerai.ru/api/v1
export SYNTH_PROVIDER_ROUTERAI_DECISION_API_KEY=sk-xxx
export SYNTH_PROVIDER_ROUTERAI_DECISION_MODEL=clef-flash

# Ollama (local) — type systemone
export SYNTH_PROVIDER_OLLAMA_DECISION_TYPE=systemone
export SYNTH_PROVIDER_OLLAMA_DECISION_URL=http://localhost:11434
export SYNTH_PROVIDER_OLLAMA_DECISION_MODEL=clef-flash
```

The layer is enabled by the `decision` section (`enabled`, `provider`, `model`, `confidenceThreshold`) —
see [CONFIGURATION.md](./CONFIGURATION.md). Every decision request goes through
`GatewayProvider` (guard/obfuscation/rate limit/audit); on an error or low
confidence it falls back to the current behaviour (fail-safe).

## Configuration via the CLI

Providers are stored as JSON files in `{dataDir}/providers/`. Commands go through the public `synth` CLI wrapper:

```bash
# Add a provider (the recommended local model is qwen3.8:27b).
# URL without /v1: type: ollama talks to the native /api/chat.
synth config provider add \
  --name ollama --type ollama \
  --url http://localhost:11434 \
  --model qwen3.8:27b

# List providers
synth config provider list

# Delete a provider
synth config provider delete ollama
```

Required flags: `--name`, `--type` (openai | anthropic | ollama | decision | systemone). Optional: `--url`, `--model`, `--api-key`, `--num-ctx <n>` (context size, Ollama's `num_ctx`; an integer > 0), `--data-dir`.

## Through the web UI

Providers and models can also be managed through the UI, in the **Providers** section.

## Models for running locally (Ollama)

Examples of models used in Synth locally (the current set lives in `{dataDir}/models/ollama/`):

| Model | Install command |
|--------|-----------------------|
| Qwen3.8 27B **(recommended)** | `ollama pull qwen3.8:27b` |
| DeepSeek Coder V2 16B | `ollama pull deepseek-coder-v2:16b` |
| DeepSeek R1 14B | `ollama pull deepseek-r1:14b` |
| Gemma 4 12B | `ollama pull gemma4:12b` |
| Qwen2.5 Coder 1.5B | `ollama pull qwen2.5-coder:1.5b` |
| Nomic Embed Text | `ollama pull nomic-embed-text:latest` |

For embedding classification (the micro layer, ADR-035) `local.nomic-embed-text:latest` is used (see [Routing](./ROUTING.md)).
