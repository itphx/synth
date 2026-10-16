# Troubleshooting

> 🌐 **English** · [Russian](../TROUBLESHOOTING.md)

> [!NOTE]
> User-facing troubleshooting lives in the documentation portal:
> https://docs.synth.itphx.ru/help/troubleshooting/. What remains here are
> engineering issues: publishing, CI, `dev.sh`, the WS fix.

Verified symptoms, causes and solutions from real experience. If your problem is not described here, check the logs (`tmp/*.log`) and open an issue.

## 1. GitVerse npm: 403 "no permission" when publishing `@itphx/synth`

**Symptom:** publishing `@itphx/synth` to `https://gitverse.ru/api/packages/itphx/npm/` fails with 403 "no permission", while the other six packages (seven in total) publish fine.

**Cause:** the `repository` field in `packages/synth/package.json` (`{"type": "git", "url": "https://gitverse.ru/itphx/synth"}`). When linking a package to a repository by `repository.url`, GitVerse checks permissions and returns 403.

**Solution:** remove the `repository` field from `package.json` (like the other packages). Verification: publishing with `repository` → 403, without `repository` → 200.

## 2. npm unpublish: 403 "Granular access tokens that bypass two-factor authentication may not perform this action"

**Symptom:** an attempt to remove a published version via `npm unpublish` is rejected with 403.

**Cause:** the npm 2026 policy — GAT tokens with `bypass 2FA` can no longer perform unpublish (see [changelog](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)).

**Solution:** instead of deleting, use deprecate — consumers will see a warning on install:

```bash
npm deprecate @itphx/synth@<version> "Use a newer version"
```

## 3. The `registry.gitverse.ru` Docker registry does not resolve

**Symptom:** `docker pull registry.gitverse.ru/...` / `docker push registry.gitverse.ru/...` fails with a resolution error.

**Cause:** the correct registry address is **`gitverse.ru`** (without the `registry.` prefix). The outdated default `registry.gitverse.ru` was fixed in `publish.sh`/`build.sh` (`GITVERSE_DOCKER_REGISTRY`).

**Solution:** use `gitverse.ru/itphx/synth:<version>`.

## 4. `dev.sh` does not survive in the background/CI (it kills its children)

**Symptom:** `./scripts/dev.sh` launched from a bash tool/CI script exits immediately or kills its child processes; `trap cleanup` fires unexpectedly.

**Cause:** `dev.sh` is tied to the controlling terminal and, when the parent session exits, terminates the process group (`kill -TERM -$pgid`). Background operation is not a supported mode.

**Solution:** start the services directly with package commands via `setsid`:

```bash
setsid pnpm --filter @itphx/synth-backend dev > tmp/backend.log 2>&1 &
setsid pnpm --filter @itphx/synth-ui dev > tmp/ui.log 2>&1 &
```

## 5. WS `/ws/events` and cookie login (standalone) — fixed

**Before (outdated limitation):** in standalone mode (`synth serve`) the `/ws/events` WebSocket did not connect after logging in through the UI: the upgrade handler accepted only `Authorization: Bearer <api-key>` and did not read the cookie session.

**Now:** the upgrade handler in `packages/core/src/server/app.ts` (the `server.on('upgrade')` method for `/ws/events`) accepts both a valid Bearer API key (CLI/API clients) and a cookie session via `auth.getCurrentUser` — the browser UI connects by cookie without a separate header. The issue is closed.

## 6. 403 "Permission denied" for protected paths

**Symptom:** the agent cannot read/modify a file it should have access to; the response contains `Permission denied` with text from the system context file.

**Cause:** protected-path protection is active (`packages/core/src/engine/security/protected-paths.ts`): the system list `definitions/protected-paths.json` plus an override policy (the `GET/PUT/DELETE /api/v2/settings/protected-paths` route, `packages/core/src/server/routes/settings.ts`). Protection is on by default (`security.protectedPaths.enabled: true`). The check runs for all file tools and shell commands; the hard deny is above `permission.rules`.

**Solution:** configure the protected-paths policy:

- **Via the API** (if available): `GET/PUT/DELETE /api/v2/settings/protected-paths` — an override of the form `{version: 1, add: [...], remove: [...]}`
- **Via a file:** `{dataDir}/security/protected-paths.json` (add/remove format, version: 1)
- **Disable protection:** the `security.protectedPaths.enabled` toggle in the UI "Security" section or `false` in `config.yaml`

## 7. TLS/certificates (outgoing connections and PostgreSQL)

The single source of TLS/CA trust in Synth is the `security.tls` section (ADR-099). All outgoing connections (LLM providers, MCP, webhooks, hybrid, OIDC/JWKS, icon/update fetching, `web_fetch`) and TLS to PostgreSQL take their CA/client certificates from there.

### `self-signed certificate in certificate chain` / `DEPTH_ZERO_SELF_SIGNED_CERT`

**Symptom:** a request to an LLM/MCP/OIDC/webhook fails with a certificate verification error (`self-signed certificate in certificate chain`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `unable to verify the first certificate`).

**Cause:** the server (corporate proxy/gateway, self-hosted IdP) is signed by an internal CA that is not in the system trust store, and `security.tls` is not set.

**Solution:** provide the trusted CA (the git channel requires a file):

```yaml
security:
  tls:
    caFile: /etc/synth/tls/ca.crt      # or caPem — the PEM itself (mutually exclusive with caFile)
```

or the env var `SYNTH_TLS_CA_FILE=/etc/synth/tls/ca.crt` (`caPem` — `SYNTH_TLS_CA_PEM`). For mTLS add `certFile`/`keyFile` (`SYNTH_TLS_CERT_FILE`/`SYNTH_TLS_KEY_FILE`). A broken/missing file is fail-closed (a clear error at startup, not a silent fallback).

**Why `NODE_EXTRA_CA_CERTS` is not a solution for the Synth process itself:** the variable affects only Node's standard transport and is **not** Synth configuration; when `security.tls` is set, Synth installs its own global undici dispatcher (`initTlsTrust`), which ignores it. The canonical path is `security.tls`; `NODE_EXTRA_CA_CERTS` remains only a compatibility channel for child processes.

### `The server does not support SSL connections`

**Symptom:** the PostgreSQL driver fails at startup with `The server does not support SSL connections`.

**Cause:** `storage.postgres.sslmode` (`require`/`verify-full`) is set, but the DB server does not support TLS (or `pg_hba.conf` does not allow it).

**Solution:** enable TLS on the DB server or drop `sslmode` (or `sslmode: disable`) — but note that `disable` also turns off certificate verification.

### "TLS parameters in DSN are forbidden (found: …)"

**Symptom:** the driver rejects `storage.postgres.dsn` with a message about forbidden TLS parameters.

**Cause:** the DSN contains `sslmode`/`sslrootcert`/`sslcert`/`sslkey`/… — `pg` overlays the DSN on top of the config (`Object.assign`) and silently overrides the `ssl` options (up to disabling TLS), so they are forbidden.

**Solution:** remove the TLS parameters from the DSN and set them where they belong:

```yaml
storage:
  postgres:
    dsn: postgres://synth@db.internal:5432/synth   # no ?sslmode=…
    sslmode: verify-full                             # disable | require | verify-full
security:
  tls:
    caFile: /etc/synth/tls/ca.crt                    # CA for verify-full
```

### git-over-https problems (clone/fetch with a corporate CA)

**Symptom:** `project_repo_clone`/`git fetch` over https fails with a certificate verification error.

**Cause:** git does not trust the server CA. The env channel (`GIT_SSL_CAINFO`) is unavailable: `git-service.ts` sanitizes the environment (`sanitizeGitEnv`/`allowEnvironment`).

**Solution:** provide the CA **as a file** via `security.tls.caFile` — the git channel passes it per call (`git -c http.sslCAInfo=<path>`). `caPem` (a PEM without a file) is unavailable to the git channel — a `caFile` is required.

## Where to look at the logs

| Service | Log |
|--------|-----|
| backend | `tmp/backend.log` |
| UI | `tmp/ui.log` |
| core standalone | `tmp/core.log` |
| LLM Gateway audit | `{dataDir}/audit/llm-gateway.jsonl` |
