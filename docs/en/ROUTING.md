# Request routing: Quick answers and model selection

> 🌐 **English** · [Russian](../ROUTING.md)

Synth handles every request in two layers:

1. **Quick answers** — an instant answer to simple requests without calling the large model
2. **Routing** — automatic model selection for requests that Quick answers did not handle

Both layers are configured in the settings sections: “Quick answers” and “Routing”.

## Overall request flow

```
User request
   │
   ▼
┌─ Quick answers (enabled) ──────────┐
│  Classification → model cascade    │
│  confident? ─── yes → ready answer │
│  no (fallback)                     │
└───────────────┬────────────────────┘
   │
   ▼
┌─ Routing (enabled) ────────────────┐
│  Classification → model selection  │
└───────────────┬────────────────────┘
   │
   ▼
LLM
```

If Quick answers is off, the request goes straight to Routing (or directly to the session model if that is off too). If Routing is off, the model selected in the session is used.

---

## Quick answers

Quick answers handles simple requests — greetings, yes/no, task classification — instantly and without calling the large model. This speeds up responses and saves tokens.

### Task classification

The first step is to determine which class the request belongs to:

| Class | Examples | What happens next |
|-------|----------|-------------------|
| **small_talk** | hi, thanks, bye | Ready answer (greeting/thanks) |
| **classify** | “fix a bug”, “write tests”, “what is...” | Intent detection: question/command/review/fix/test |
| **enum_decision** | yes, no, reject, plan | Option selection: yes/no/approve/reject/mode |
| **llm_task** | everything else | Skip — the request goes to Routing |

Classification works on keyword dictionaries (loaded from `packages/core/dictionaries/`):

- **small_talk** — exact match of words from the greetings/farewells/thanks dictionary
- **classify** — a question (contains “?” or starts with “what/how/why/what for/which”) or intent words (“write”, “fix”, “repair”, “analyze”, etc.)
- **enum_decision** — word-boundary matches (“yes”, “no”, “reject”, “plan”) so that “yes” does not fire inside another word

If a request matches no class, it is classified as `llm_task` and passed on.

### Model cascade

For the `small_talk`, `classify` and `enum_decision` classes, a cascade of four models is started. Each next one is engaged only if the previous one was not confident:

1. **Rules (rules)** — the fastest layer (milliseconds, 0 tokens). Comparison against the dictionaries.
2. **Embeddings (embedding)** — semantic classification. Understands the meaning of a request even if its words are not in the dictionary.
3. **Decision model** — the System One class (Clef/Jev/Decision-1 and compatible): in a single forward pass it answers typed questions and returns probabilities per option. For the `classify`/`enum_decision` classes this is a `choice` question — picking a label from a set. It cannot generate text — it only classifies.
4. **Micro-LLM** — a small local LLM for structured classification (rarely used).

The model returns a label and a confidence (0–1). If the confidence is >= the threshold (`microConfidenceThreshold`, default 0.8), Quick answers returns a ready answer. Otherwise the request is passed on (fallback).

**Decision level** is engaged between the embeddings and the micro-LLM, and only if the master switch `decision.enabled` is on (off by default) and the session has no explicit opt-out `decisionFirst: false` (an absent value inherits the global setting). An answer is accepted when the confidence is >= the `decision.confidenceThreshold` (default 0.6); otherwise (low confidence, error, timeout) the level is considered unconfident and the cascade moves on — fail-safe. If the optional **escalation model** (`escalationProvider`/`escalationModel`) is set, the request is run through the `escalation` tier before falling back (a single `primary → escalation` cascade). If no decision provider is set or the level is off, it is simply skipped — the previous behavior. Aggregate statistics of the decision layer live in the admin section “Decision models” (ADR-084).

### How embeddings work

The embedding classifier determines the request intent semantically — by meaning, not by words.

**On initialization** (the first request, lazily), the model prepares reference texts:
- For every possible label (question, command, review, explain, debug, fix, test, yes, no, approve, reject, mode_plan, mode_act), a reference text is taken in the session language (Russian/English)
- The reference text is turned into a vector — an embedding (a numeric array, for example 768 numbers for `nomic-embed-text`)
- The vectors are computed with the selected embedding model (by default `local.nomic-embed-text:latest` via Ollama)

**When handling a request:**
1. The request text is turned into a vector by the same embedding model
2. The cosine similarity between the request vector and every reference is computed
3. The label with the highest similarity wins
4. If the similarity is >= 0.5, the confidence is normalized (`similarity × 1.2`, capped at 0.99); if the result is >= the threshold, the label is accepted

Cosine similarity shows how close two texts are in meaning: 1 — almost identical, 0 — unrelated.

**Configuring embeddings:** the “Embedding” section in the session settings (visible when Quick answers is on): the embedding model and provider. If embeddings are off or unavailable, classification works by rules, and harder cases fall back.

---

## Routing

Routing decides **which model** answers requests that Quick answers did not handle. The choice depends on the task type and the strategy.

### Request classification

The first step is to determine the request category:

| Category | Signals | Examples |
|-----------|---------|---------|
| **coding** | code tool calls (write_file, edit, etc.), keywords “write”, “fix”, “implement” | “write a function”, “fix a bug” |
| **research** | keywords “investigate”, “analyze”, “why”, “explain” | “analyze the architecture” |
| **chat** | everything else (fallback) | ordinary dialog |

Classification works on keywords from the same dictionaries (`packages/core/dictionaries/`) — a fast layer without an LLM.

If the dictionary classifier is unconfident (confidence below the threshold) and the session has no explicit category (`routingCategory` from `classify_conversation`), the `coding`/`research`/`chat` category is determined by the **decision model** (the same decision layer as in Quick answers). A decision is accepted only when the confidence is >= `decision.confidenceThreshold`; otherwise (low confidence, error, level off) the router falls back to the dictionary category — fail-safe. Priorities do not change: tool calls, keywords and `routingCategory` stay above the decision layer.

### Model selection strategies

| Strategy | How it works | When to use |
|-----------|-------------|-------------------|
| **Content** | Request category → model from settings (coding/chat/research) | Different models for different task types |
| **Cost** | Complexity estimate (message length, number of tool calls) → cheap or expensive model | Saving on simple requests |
| **Content + Cost** | Content first; a short chat request → cheap model | Combined approach |
| **Auto** | Same as Content | Universal option |

### Content strategy

For the request category, a “category → provider/model” mapping is looked up:

1. Session settings (the “Content” section in the Routing settings)
2. If not set in the session — the global config (`routerConfig.content`)
3. If it is missing there too — the session's default model is used

### Cost strategy

Request complexity is estimated by a heuristic:

- **Simple** (cheap): text shorter than 50 characters and no tool calls → cheap model
- **Complex** (expensive): 2+ tool calls or text longer than 200 characters → expensive model
- **Medium** — by text length (longer than 100 characters → expensive, otherwise cheap)

### Quality check (escalation)

After the model answers, the quality check runs (if enabled):

- **Minimum length** — a too-short answer is considered unconfident
- If the answer fails the check, the request is forwarded to the fallback model (the spare one)

This catches clearly unsuccessful answers before they are shown to the user.

---

## Request walk-through examples

| Request | Quick answers | Routing | Result |
|--------|---------------|---------------|------|
| “hi” | small_talk → “Hi! How can I help you?” | not invoked | instant answer |
| “yes” | enum_decision → “Yes.” | not invoked | instant answer |
| “write tests for the sum function” | classify → intent test → “Got it, tests are needed...” | not invoked | instant answer |
| “explain how authorization works” | classify → UNSURE (a hard question) | research → analysis model | LLM answer |
| “check the PostgreSQL integration” | llm_task (no signals) | coding → coding model | LLM answer |

---

## Configuration

| Setting | Where | Purpose |
|-----------|-----|------------|
| Quick answers on/off | Settings → Quick answers | Enable/disable the instant-answer layer |
| Confidence threshold | Settings → Quick answers | Below the threshold the request falls back |
| Embedding model | Settings → Quick answers → Embedding | Model for semantic classification |
| Routing on/off | Settings → Routing | Enable/disable model selection |
| Strategy | Settings → Routing | content / cost / content+cost / auto |
| Models per category | Settings → Routing → Content | coding/chat/research → model |
| Quality check | Settings → Routing → Quality Check | fallback model, min. length |
| Decision level (session) | Settings → Quick answers → Decision level | Per-session opt-out `decisionFirst`: turning it off forcibly disables the decision level in this session |
| Decision models (admin) | Settings → Decision models | Shared decision layer: master switch, primary and escalation provider/model pairs, confidence threshold, statistics |

### Decision models (admin)

The “Decision models” section defines the shared decision layer for Quick answers, Routing and external-event classification:

- **Master switch** `enabled` (off by default) — when the decision layer is off, the decision model is not called anywhere.
- **Provider and model** — a select for the decision-protocol provider and a model from the “Models” section. The provider type defines the transport: `decision` (RouterAI, `POST {base}/decisions`) or `systemone` (Ollama, `POST {base}/v1/systemone`). A model example: `clef-flash`.
- **Escalation model** (`escalationProvider`/`escalationModel`, optional) — a second provider/model pair (e.g. `clef`). A single `primary → escalation` cascade: if the primary model gives a low confidence, an invalid label, no answer or an error, the request goes to the escalation tier. Empty — escalation is off.
- **Confidence threshold** `confidenceThreshold`.
- **Statistics** — read-only counters of the decision cascade: calls, handled, fallbacks, escalations, attempts per tier, attempt statuses and a breakdown by model (latency avg/max). Reset with a button.

The settings apply immediately (at runtime), without a restart. The per-session “Quick answers → Decision level” toggle (`decisionFirst`) is a targeted opt-out: turning it off forcibly disables the decision level in a particular session, while turning it on inherits the global setting.

If no decision provider is set or the decision layer is off, the decision model is not used — Quick answers and Routing behave as before. If no escalation tier is set, the cascade consists of a single primary pair (the behavior as before phase 6).

---

## Notes

- Quick answers return 0 tokens — pure savings on simple requests
- The processing order is fixed: Quick answers → Routing → LLM
- Classification dictionaries are stored in `packages/core/dictionaries/` (YAML, Russian/English)
- Embeddings can be computed via Ollama (locally) — by default `local.nomic-embed-text:latest`
