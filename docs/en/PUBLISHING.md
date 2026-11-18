# Publishing and release

> 🌐 **English** · [Russian](../PUBLISHING.md)

Developer/maintainer guide: how to build, publish and release Synth. All commands are run from the monorepo root (`synth/`).

## Package publishing order

**All 8 packages** are published in strict dependency order:

```
shared → core → executor → storage-postgres → ui → backend → sdk → synth
```

The order is set by the dependency hierarchy: `@itphx/synth-shared` is the foundation, `@itphx/synth-core` imports shared, `@itphx/synth-executor` is the agent-command executor (`dependencies`: `@itphx/synth-shared`, `peerDependencies`: `@itphx/synth-core`, ADR-077), `@itphx/synth-storage-postgres` is the optional storage-layer driver (`peerDependencies: @itphx/synth-core`, `pg` — `optionalDependencies`, ADR-097), `@itphx/synth-backend`/`@itphx/synth-ui` import core, `@itphx/synth-sdk` is a thin client of the public API over shared (ADR-052), `@itphx/synth` is a thin wrapper over core/ui/shared (ADR-038).

## `pnpm publish` instead of `npm publish`

`npm publish` does **not rewrite** `workspace:*` in dependencies — the published packages break for npm consumers (`workspace:*` is not resolved). `pnpm publish` automatically replaces `workspace:*` with the actual versions of the workspace packages, so it is the one used.

The publishing scripts use the `--no-git-checks` flag (publishing happens not from a clean git tree).

## Registries

| Registry | URL | Token |
|--------|-----|-------|
| npmjs.org | `https://registry.npmjs.org` | `NPM_TOKEN` |
| GitVerse Package Registry | `https://gitverse.ru/api/packages/itphx/npm/` | `GV_TOKEN` |
| GitHub Packages | `https://npm.pkg.github.com` (`@itphx` scope) | `GH_TOKEN` (`write:packages` scope) |
| Gitea Package Registry | `https://git.itphx.ru/api/packages/itphx/npm/` | `GITEA_NPM_TOKEN` (publishing; a read token for install) |

Token values are stored in repository secrets (GitVerse CI) and in the local environment. **Never put token values in documentation, code or commits.**

Checking the npmjs token: `npm whoami --registry https://registry.npmjs.org`.

## npm 2026 requirements (important)

Since 2026 npm has tightened its publishing requirements:

- **Old classic tokens without 2FA are revoked.** To publish you need a **Granular Access Token (GAT) with 2FA enabled** (`publish` rights only for the required `@itphx/*` packages) or a classic token with 2FA enabled on the account.
- **Tokens with `bypass 2FA` do not publish directly** (from January 2027 — only staged publishing with manual 2FA confirmation). When creating a token do NOT choose "bypass 2FA" — use a regular GAT.
- **GAT tokens without the `unpublish` right** cannot delete a published version — use `npm deprecate` instead of `npm unpublish` (see [Troubleshooting](../TROUBLESHOOTING.md)).
- **npm v12**: `allowScripts`/`--allow-git`/`--allow-remote` are disabled by default. If installing a package needs lifecycle scripts — `npm approve-scripts`/`--allow-scripts`.

## Beta versions (Gitea)

The beta channel is the fast path "as a user sees it": packages are published to the **Gitea Package Registry** (`git.itphx.ru`) and installed from there with a single command, without building from source. This is how local runs and hybrid mode are checked on the same distribution consumers get, without waiting for a release to npmjs.

Step-by-step procedure and troubleshooting — skill `synth-beta-publish`.

Beta version: `X.Y.Z-beta.<UTC timestamp>.<sha>[.dirty]` — the prerelease suffix separates it from release versions; `<sha>` pins the commit, `.dirty` means the publication was built from a dirty working tree. It is published under the dist-tag `beta` or `next`; **`latest` is not moved** — installing `@itphx/synth` without a tag and the official Helm chart still point at a release.

**All 8 packages** are published in release order (`shared → core → executor → storage-postgres → ui → backend → sdk → synth`).

**The registry is read without a token.** Update checks and installation from Gitea need no
authentication: `synth update --check --channel beta` reads the `beta` dist-tag with a public package
metadata GET, and `npm i -g @itphx/synth@beta --@itphx:registry=https://git.itphx.ru/api/packages/itphx/npm/`
works without an `.npmrc` token. The registry is set with the **scoped key** `--@itphx:registry`, not `--registry`:
otherwise npm pulls public dependencies (`hono`, `commander`…) from the mirror and fails with 404.
A `GITEA_NPM_TOKEN` with the `package:write` right is needed **only for
publishing** (`publish-beta.sh`/CI). A closed registry that requires a read token is the exception: then
the token in `.npmrc` is a condition for installing the package, not for checking its version.

### Local publishing

```bash
# token with the package:write right in the itphx namespace
GITEA_NPM_TOKEN=… ./scripts/publish-beta.sh --base 0.13.4
```

`--base X.Y.Z` sets the version from which the next patch is computed; without it the script uses the current `packages/synth/package.json` version.

| Flag | Effect |
|---|---|
| `--tag beta\|next` | publishing dist-tag (default `beta`) |
| `--base X.Y.Z` | base version (empty — next patch) |
| `--no-smoke` | skip the install-from-registry check (faster) |
| `--dry-run` | show the version and plan; build and publish nothing |
| `--no-build` | do not rebuild packages (use the existing `dist/`) |

The script writes the computed version to `tmp/beta-publish/version.txt`.

### Publishing from CI

Actions → **`Beta packages`** ([workflow](../../.gitverse/workflows/beta.yaml)), inputs:

- `ref` — branch or commit (default `master`);
- `base` — base version `X.Y.Z` (empty — next patch);
- `tag` — dist-tag `beta`/`next`;
- `smoke` — verify installation from the registry (default yes);
- `dry_run` — show the plan without building or publishing.

The workflow deliberately **skips the release gates** (`security-gate`, `release-notes`): a beta is not a release and does not replace the audit. The `GV_GITEA_TOKEN` token must have `package:write`; if it does not, create a separate secret and substitute it in the publishing step's `env`.

### Installation

```ini
@itphx:registry=https://git.itphx.ru/api/packages/itphx/npm/
//git.itphx.ru/api/packages/itphx/npm/:_authToken=${GITEA_NPM_TOKEN}
```

```bash
npm i -g @itphx/synth@beta
synth --version

# a separate home — the beta does not disturb the working instance
synth serve --home ~/.local/share/synth-beta

# hybrid: local core, server in K3s (test)
synth serve --connect https://synth.k3s.itphx.loc --home ~/.local/share/synth-beta --port 4300
```

### Switching from beta to stable

The `beta → stable` switch is a **downgrade** (the stable version is lower than the current beta), so the
command marks it as a rollback and asks for confirmation:

```bash
synth update --check --channel stable          # what is available on the stable channel
synth update --channel stable --apply          # downgrade: confirm "ROLLBACK"
synth service restart                          # or POST /api/v2/maintenance/restart, or the UI button
synth doctor                                   # after start — no fail
```

The beta version is **not** removed or migrated; the instance data stays in place (a downgrade does not
roll the schema back — if needed, recovery is only from a backup, see [MAINTENANCE.md](../MAINTENANCE.md)
§"Update and rollback" (in Russian). Going back to beta is an ordinary channel update (`--channel beta --apply`).

### Smoke check

The script installs the published package into `tmp/` and runs `synth --version` — this catches "published but not installable" (broken `workspace:*`, files missing from `files`). Disabled with `--no-smoke`; in CI with the `smoke: false` input.

### Retention

```bash
./scripts/beta-prune.sh --keep 20          # plan: what would be deleted (safe default)
./scripts/beta-prune.sh --keep 20 --yes    # delete the extra betas
```

The script keeps the last N beta versions (semver, descending) and deletes the older ones across all 8 packages. Only versions with `-beta.` are deleted; release versions and the `latest` dist-tag are never touched. Without `--yes` (and with `--dry-run`) it only prints the plan.

### Limitations

- A beta built from a dirty tree is **not reproducible** — the `.dirty` suffix marks it; use a clean commit when reproducibility matters.
- Docker images and the Helm chart are **not** published as betas — only npm packages in Gitea.
- The publishing token needs `package:write`; reading the registry (update checks, installing `@beta`) needs no token — it remains necessary only for closed registries whose read side requires an `.npmrc`.

## Docker image

The image is built from the published npm package: `npm install -g @itphx/synth@<version>` (the `@itphx/synth-core`/`@itphx/synth-ui`/`@itphx/synth-shared` dependencies are installed transitively, prompts and UI are resolved from node_modules). Dockerfile: `docker/Dockerfile`.

Images are built with a build identifier **`SYNTH_BUILD_ID`** (the commit sha in CI; locally `git rev-parse --short HEAD`, with a `-dirty` suffix on a dirty tree). The value is returned by `GET /health` (additive `build` field) and is part of the service worker cache name; the PWA compares it with the bundle build id and, on a mismatch, clears caches, updates the SW and reloads once — a rebuild under the same semver no longer leaves the old shell behind. If the build id is empty (a local build without the variable), the client falls back to comparing `health.version` with `SYNTH_VERSION`.

The Docker registry is **Gitea** (`git.itphx.ru`, `itphx` namespace); gitverse.ru and ghcr.io are no longer used as image registries. The image:

```
git.itphx.ru/itphx/synth:<version>
```

The registry is **public**: `docker pull` works anonymously and no `imagePullSecret` is needed in Kubernetes — authorization is required only for `docker push` (the `GT_TOKEN` secret, login `itphx`; see "Executor images and flavors" → "Secret").

The `latest` tag is **not published** — versioned tags only: pulls use a concrete version, so deployments stay reproducible. `docker pull git.itphx.ru/itphx/synth` without a tag does not work — specify the version.

The `synth` image is published to Gitea **starting from the release that introduced this policy**: older versions have no image in `git.itphx.ru/itphx/synth` (they were released to gitverse.ru/ghcr.io only) — for air-gapped installs use the offline archives from the corresponding GitHub/GitVerse release assets.

The base images (`synth`, `synth-backend` slim, `synth-ui`) are published by the `build-docker` job in `release.yaml` (docker on the self-hosted runner). **multi-arch:** amd64 is built by docker, arm64 by buildx (`:<version>-arm64`), then a best-effort manifest list `:<version>` (amd64+arm64); if the index cannot be created, the per-arch tags `<version>-amd64` / `<version>-arm64` remain. The full policy for every image is in [Release to the GitHub mirror](#release-to-the-github-mirror) → "Image policy".

## Executor images and flavors (PROP-082)

Besides the three base images, **flavor images** (all-in-one: control plane + toolchain), **executor images** (workers, split topology) and `synth-provisioner` (pool provisioner, a single image without flavors) are published. All of them go to the Gitea registry `git.itphx.ru/itphx` (public: anonymous pull, authorization only for push):

| Image | Tag | Content |
|---|---|---|
| `synth-backend` | `<version>` | slim: control plane without the toolchain (published by the `build-docker` job, not `publish-images-gitea` — see below) |
| `synth-backend` | `<version>-core` | hard deps + tier 0 + control plane |
| `synth-backend` | `<version>-dev` | core + tier 1 + tier 4 (MCP) + DB clients + buildah |
| `synth-backend` | `<version>-devops` | dev + tier 2 + diagnostics + docker CLI |
| `synth-backend` | `<version>-browser` | debian branch: tier 0/1 + tier 3 (Playwright + Chromium) + diagnostics |
| `synth-backend` | `<version>-full` | everything above |
| `synth-executor` | `<version>-core` … `<version>-full` | executor images (the same flavors, without the control plane) |

Full addresses: `git.itphx.ru/itphx/synth-backend:<version>-core`, `git.itphx.ru/itphx/synth-executor:<version>-core`.

**Tags are versioned, without `latest`.** Pulls in the cluster use a concrete version (`<version>-<flavor>`) — otherwise a deployment stops being reproducible. The Gitea registry has no repository size limit; the versioned-tag policy is the same for every image.

The `slim` base `synth-backend:<version>` is published by the `build-docker` job (base images); `publish-images-gitea` calls `publish-images.sh` with `--no-slim` — otherwise two jobs would push the same tag into the same registry (a race).

### Secret

Publishing **images to the Gitea registry** (the `build-docker` and `publish-images-gitea` jobs in `release.yaml`) and the **Helm chart** (`publish-helm`) uses the **`GT_TOKEN`** secret (login `itphx`; container-registry and `package:write` rights); locally and in `synth-deploy` it is the `GITEA_TOKEN` environment variable. **Pulling** needs no token: the registry is public. Publishing **beta packages to the Gitea npm registry** (`beta.yaml`) uses the **`GV_GITEA_TOKEN`** secret (it needs the `package:write` permission). If the secret is missing, publishing **fails** with a clear message (fail-closed) instead of being silently skipped: `scripts/docker-auth-gitea.sh` prepares the `config.json` for the docker CLI.

### Build and publish

In CI, publishing lives in the `publish-images-gitea` job of `.gitverse/workflows/release.yaml`: it runs **on a release tag** (like the base image publishing) and builds every flavor through `scripts/publish-images.sh` (docker + BuildKit, `--target` of the needed stage) tagging `git.itphx.ru/itphx/<image>:<version>-<flavor>`; it does not build the slim base (`--no-slim`). In `ci.yaml` (push/PR) there is no publishing — only builds and smoke tests (the `images` job).

An explicit `--platform` is **not** set in the flavor steps: the flavor stages contain `RUN` steps that install packages and are not cross-built — the image is built for the runner architecture (amd64). BuildKit reuses layers between flavors, so the heavy `build` stage is not repeated for every flavor.

Locally:

```bash
# show the plan (nothing is executed)
./scripts/publish-images.sh --tag-base 0.11.4 --dry-run

# build locally, without publishing
./scripts/publish-images.sh --tag-base 0.11.4 --skip-push

# build and publish all flavors to Gitea
GV_GITEA_TOKEN=<token> ./scripts/publish-images.sh --tag-base 0.11.4

# only the executor image, core flavor
GV_GITEA_TOKEN=<token> ./scripts/publish-images.sh --tag-base 0.11.4 \
    --only executor --flavor core
```

The script prints a summary (image, tag, size, digest) and pushes **sequentially**, with retries: the DNS server `10.0.0.245` behind `git.itphx.ru` drops parallel queries, which made `docker push` fail with `Temporary failure in name resolution`.

### Flavor smoke tests

```bash
./scripts/smoke-image.sh --image synth-backend:0.11.4-dev
./scripts/smoke-image.sh --image git.itphx.ru/itphx/synth-executor:0.11.4-core --flavor core
```

The script starts a container and checks the content **per flavor** (not only that binaries exist, but that they work):

| Flavor | Checks |
|---|---|
| `core` | `git`, `rg`, `python3` (+`pip`, `python3 -m venv`), `bash`, `jq`, `yq`, `curl`, `openssl`, `ssh` (+`scp`, `sftp`), `rsync`, `ca-certificates` |
| `dev` | + tier 1 (`make`, `gcc`, `g++`, `patch`), MCP servers (`initialize` over stdio), DB clients (`sqlite3`, `psql`, `redis-cli`, `mysql`), `buildah` |
| `devops` | + tier 2 (`kubectl`, `helm`, `kustomize`, `tofu`/`terraform`, `ansible`, `shellcheck`, `yamllint`, `hadolint`), diagnostics (`dig`, `nc`, `lsof`, `ss`, `traceroute`), `docker --version` (there is no daemon in the image) |
| `browser` | + `playwright`, headless Chromium start, `xmllint` |
| `full` | everything above |
| `slim` | **negative check:** no toolchain binaries must be present |

The exit code is non-zero on a failure; the output shows which check did not pass.

## Helm chart

The application chart is `charts/synth/` in the monorepo. The chart version and `appVersion` equal the release version: on a bump in CI (`version-bump` in `release.yaml`) they are updated together with `version.ts` and `package.json`.

The registry is the **native Gitea Helm registry**, not OCI (`helm push oci://...` is not used):

```
https://git.itphx.ru/api/packages/itphx/helm
```

The index repository is `https://git.itphx.ru/api/packages/itphx/helm/index.yaml` (available anonymously). The GitVerse Helm registry is no longer used.

### Publishing

In CI — the `publish-helm` job in `.gitverse/workflows/release.yaml` (not started on `dry_run`): installing Helm → `helm lint charts/synth` → `helm package` → `curl` POST to `.../helm/api/charts` with Basic auth `itphx:$GT_TOKEN` (success = HTTP 201) → version check in `index.yaml`. The soft mode `CI_HELM_SOFT=1` covers prerequisites only (unavailable helm, failed lint/package, missing token); **a registry refusal or a version missing from the index fails the job** — the chart is the primary delivery artifact, a silent skip is not acceptable.

Manually:

```bash
helm package charts/synth --version <version> --app-version <version> --destination dist/helm
curl --user "itphx:$GITEA_TOKEN" -X POST \
  --upload-file dist/helm/synth-<version>.tgz \
  https://git.itphx.ru/api/packages/itphx/helm/api/charts
```

### Installation

```bash
helm repo add synth https://git.itphx.ru/api/packages/itphx/helm
helm repo update
helm install synth synth/synth --version <version> -f my-values.yaml
```

The images `git.itphx.ru/itphx/{synth,synth-backend,synth-ui}:<version>` are pulled **anonymously** (public registry) — no `imagePullSecret` is needed.

### Custom values

Custom values (addresses, secrets, resources) are stored in the `secrets/` directory **outside the `synth/` git repository**. The repository holds the canonical set of values with comments — `charts/synth/values.yaml` (overridden by your own values file/`--set`).

## Scripts

All scripts are in `synth/scripts/`.

### `version-bump.sh` — version bump

```bash
./scripts/version-bump.sh patch | minor | major | X.Y.Z
./scripts/version-bump.sh --dry-run 0.3.1   # check without changes
```

Updates:
1. `packages/shared/src/version.ts` — the `SYNTH_VERSION` constant
2. `packages/*/package.json` — the `version` field in all 8 packages

The single source of the version is `SYNTH_VERSION` in `packages/shared/src/version.ts` (imported from `@itphx/synth-shared`).

### `build.sh` — build

```bash
./scripts/build.sh                # full build
./scripts/build.sh --check        # build + type and test checks
./scripts/build.sh --clean        # clear dist before the build
./scripts/build.sh --docker       # build + Docker image (default tag: dev)
./scripts/build.sh --docker-tag=<tag>
./scripts/build.sh --docker-registry=<registry>
./scripts/build.sh --help         # help
```

Result: `packages/synth/dist/cli.js` (the executable CLI).

### `publish.sh` — publishing

```bash
./scripts/publish.sh                          # build + publish (both registries)
./scripts/publish.sh --dry-run                # check without a real publish
./scripts/publish.sh --no-build               # without rebuilding
./scripts/publish.sh --registry=npmjs | gitverse | both
./scripts/publish.sh --docker                 # also a Docker image (versioned tag only)
./scripts/publish.sh --docker-tag=<tag>
```

Environment variables: `NPM_TOKEN`, `GV_TOKEN`, `GITEA_TOKEN`, `NPM_REGISTRY`, `GITVERSE_NPM_REGISTRY`, `DOCKER_REGISTRY` (default `git.itphx.ru`; the former name `GITVERSE_DOCKER_REGISTRY` is still accepted for compatibility).

Note: the GitVerse npm registry does not support `/-/whoami` (404) — authorization is verified by an actual publish.

### `release-github.sh` — GitHub mirror backfill

```bash
./scripts/release-github.sh --version 0.10.0 --dry-run             # plan without actions
./scripts/release-github.sh --version 0.10.0 --push-refs --yes     # mirror refs (master→main + tags)
./scripts/release-github.sh --version 0.10.0 --release --yes       # GitHub Release + assets
./scripts/release-github.sh --version 0.10.0 --push-refs --release --yes
```

Local backfill of the GitHub mirror: synchronizes refs and creates/updates the GitHub Release.
It does **not** build Docker images (GitVerse CI builds them and publishes to `git.itphx.ru/itphx`) and does not
publish npm. Details — [Release to the GitHub mirror](#release-to-the-github-mirror).

### `changelog.sh` — release body

```bash
./scripts/changelog.sh                                  # RU, changelog-partial.md
./scripts/changelog.sh --lang en --out tmp/changelog-en.md
./scripts/changelog.sh --help
```

Options: `--lang <ru|en>` (default `ru`), `--out <path>` (default `changelog-partial.md`).
The version is read from `packages/synth/package.json` (`<VERSION>`). For the role of release
descriptions see [Release descriptions](#release-descriptions).

The root changelog is a **pair** of files: `CHANGELOG.ru.md` (canonical) and `CHANGELOG.md`
(EN mirror for the public GitHub). `scripts/changelog.sh` generates the release body, not these
files: the root changelog is maintained by hand.

## Release descriptions

Every release has a **pair** of files in `docs/releases/`; `changelog.sh` takes a file **as a whole**
and uses it as the release body (when such a file exists, the commit-based auto-generation is skipped).
Prepare the descriptions in advance, before the tag is pushed.

This is a **mandatory requirement, not a recommendation**: the `release-notes` gate (before `build`)
fails without non-empty `<version>.md` and `<version>.en.md`. Commit-based auto-generation remains only
an emergency fallback for a manual/local `changelog.sh` run.

| File | Language | Where the body goes |
|------|----------|---------------------|
| `docs/releases/<VERSION>.md` | Russian | body of the **GitVerse Release** (job `create-release`) |
| `docs/releases/<VERSION>.en.md` | English | body of the **GitHub Release** (job `publish-github`) |

What to write: what is included in the release, the key changes, **breaking changes**, and an
installation block (`npm`/`docker`/`helm` commands). For the structure, use
[`docs/releases/0.10.0.md`](../releases/0.10.0.md) as a reference.

Local check of the pair:

```bash
pnpm release:notes -- --version 0.13.4
# or
node scripts/release-notes-check.mjs --version 0.13.4
```

`changelog.sh` behaviour:

- `--lang ru` (default) — prefers `docs/releases/<VERSION>.md`;
- `--lang en` — prefers `docs/releases/<VERSION>.en.md`; if it is missing but the Russian file
  exists, the Russian file is used and a warning is printed that the English description is missing;
  if neither exists, the body is auto-generated from the commits between the previous tag and HEAD
  (with a warning).

Example names for version `0.10.1`: `docs/releases/0.10.1.md` and `docs/releases/0.10.1.en.md`.

## CI/CD (GitVerse)

**Principle: build and publish only on release tags; a regular push — tests; small (docs) pushes — a lightweight check.**

| Workflow | Trigger | Content |
|---|---|---|
| `.gitverse/workflows/release.yaml` | push of a `v*` tag + `workflow_dispatch` | **build and publish** of the release (including the GitHub mirror and release); before artifacts are built — the mandatory `security-gate` and `release-notes` gates (`build.needs`) |
| `.gitverse/workflows/ci.yaml` | push to `main`/`master`/`feature/**`/`fix/**`/`refactor/**`/`chore/**`/`docs/**` and PR | code tests: typecheck, lint, tests of `shared`/`core`/`executor`/`storage-postgres`/`backend`/`ui`/`sdk`, the `test-postgres` job (contract suite against a live PostgreSQL), `helm lint` + `template`, `secret-scan` (tree + history, **blocking**), `pnpm audit --audit-level=high` (report-only) + the vulnerability ratchet as a delta to the baseline (report-only) |
| `.gitverse/workflows/ci-docs.yaml` | push to `main`/`master`/`feature/**` and PR, changes by `paths` (docs/AGENTS.md/check scripts) | `node scripts/adr-check.mjs` + `node scripts/docs-link-check.mjs` + `node scripts/security-gate.mjs --lint-records` (audit records; pnpm is not installed) |

The split is done via `paths`/`paths-ignore`: `ci.yaml` has `docs/**` and `**/*.md` in `paths-ignore`, so docs pushes do not run the heavy jobs; `ci-docs.yaml` is the opposite — `paths` only for docs, and the job does not install pnpm (the scripts run on bare node).

### Build order in CI

`pnpm install --frozen-lockfile` → `pnpm --filter @itphx/synth-shared build` (required before
typecheck) → `pnpm --filter @itphx/synth-core build` (needed by the backend and by typecheck of the
storage driver) → `pnpm --filter @itphx/synth-executor build` (types reference the core dist) →
`pnpm --filter @itphx/synth-storage-postgres build` → `pnpm typecheck` → `pnpm lint` → `pnpm test`.

Without the shared/core builds, typecheck cannot find the types. Recursive tasks
(`pnpm typecheck`/`lint`/`test` = `pnpm --recursive run …`) follow the **intentional** cycles
`core ↔ @itphx/synth-storage-postgres` and `core ↔ @itphx/synth-executor` (core loads both packages
via dynamic `import()`, the packages peer-depend on core) — allowed by `ignoreWorkspaceCycles: true`
in `pnpm-workspace.yaml` (pnpm ≥12 otherwise fails with `ERR_PNPM_TASK_CYCLE`; the tasks themselves
have no dependency between them — the build order is set by the explicit `--filter` calls above).
Recursive tasks run sequentially per package (`workspaceConcurrency: 1`): otherwise package vitest
runs compete for CPU and core degradation tests hit `Test timed out in 20000ms`.

The driver is also built in the release gate `lint-and-test` (`release.yaml`): the recursive
`pnpm test` includes core degradation tests that are not gated by `SYNTH_TEST_POSTGRES_DSN` but
dynamically import `@itphx/synth-storage-postgres` — without its `dist` the run fails. The driver
contract suite against a **live** PostgreSQL is a separate `test-postgres` job
(`SYNTH_TEST_POSTGRES_DSN`; the DB is started by `scripts/ci-postgres.sh`: the `GV_TEST_POSTGRES_DSN`
secret → local `initdb` → docker `postgres:17-alpine`). `security-gate` and `release-notes` gate
artifact builds (`build.needs`) — policy and checklist: [docs/security/README.md](../security/README.md).

### Starting a release

> **Rule: releases are tagged from `master` only.** A tag on a feature branch is formally valid (it points at
> a specific commit) but leaves `master` behind the release — "the release exists, the code is not in master"
> (that is what happened with 0.12.4). On top of that, `release.yaml` takes the npm version from
> `packages/synth/package.json` and the Helm/Docker/offline version from the tag: without a bump commit in the
> tagged tree, publishing goes out under the **previous** version (on 0.12.4 npm packages shipped as `0.12.3`
> and the run had to be cancelled).

**Order (mandatory):**

1. Merge the working branch into `master` and push: `git checkout master && git merge --ff-only <branch> && git push origin master`.
2. Wait for a green `ci.yaml` on `master` (that is the audit commit).
3. Bump the version in a single `master` commit: 8 × `packages/*/package.json`, `packages/shared/src/version.ts`,
   `charts/synth/Chart.yaml` (`version` + `appVersion`). Confirm `ci.yaml` is green on that commit.
4. Add the pair `docs/releases/<version>.md` + `.en.md` and verify it with `pnpm release:notes -- --version <version>`.
5. Add the internal audit record `docs/security/releases/<version>.json` (`security-gate` requires it).
6. Create an **annotated** tag on the commit that contains the record and push it:
   `git tag -a v<version> -m "…" && git push origin v<version>`.
7. Do not re-create the tag or cancel a run mid-flight: pushing the tag again starts a new run while the
   previous one's jobs still hold slots, and GitVerse may kill both (observed: all jobs marked `failure`
   at the same second, including steps that never started).

Manual alternative (no tag):

1. **Dry-run:** `workflow_dispatch` with `dry_run: true` — a check without publishing
2. **Real publishing:** `workflow_dispatch` with `dry_run: false` (inputs: `bump` patch/minor/major, `pre_release`)
   — this path performs the bump, commit and tag itself.

Re-running on the same tag is idempotent: npm versions already in the registry are skipped, the Helm chart is
overwritten with identical content, and CI artifacts and offline builds are best-effort.

Release workflow: version bump (version.ts + package.json + `charts/synth/Chart.yaml`) → release notes check (`release-notes`) → CI checks → build → CHANGELOG → npm publish (npmjs + GitVerse + GitHub Packages) → Docker (`build-docker` → `git.itphx.ru/itphx/{synth,synth-backend,synth-ui}`, plus `publish-images-gitea` → flavor and executor images) → Helm chart publish to Gitea (`publish-helm`) → create the GitVerse Release → GitHub mirror (`publish-github`: push `main`+tags, GitHub Release).

npm packages are published from GitVerse CI by three jobs — `publish-npmjs`, `publish-gitverse-npm`, `publish-github-npm` (GitHub Packages); beta packages go only to the Gitea npm registry (`beta.yaml`).

### Documentation check

`ci-docs.yaml` (job `docs-check`) runs on docs changes and checks:

- `node scripts/adr-check.mjs` — the AD index, link integrity and canonical statuses;
- `node scripts/docs-link-check.mjs` — relative links `[..](path)` in `docs/**` (except `docs/arch_decisions/**`), `README.md`, `AGENTS.md`, `packages/*/AGENTS.md`; external links, `#…` anchors, fenced code blocks and inline code are skipped, and on a broken link — exit 1 with the location `file:line → link`.

The same locally:

```bash
node scripts/adr-check.mjs && node scripts/docs-link-check.mjs
```

### GitVerse CI specifics

1. **Do not use `actions/setup-node@v4`** — use `npm install -g pnpm@latest` instead
2. **`${{ env.VAR }}` does not work** — it resolves to the Go string `%!t(string=...)`. Hardcode values.
3. **`${...}` in inline bash** — GitVerse parses it as a Go template, the script fails. Move complex bash into a separate file (see `scripts/changelog.sh`).
4. **`${GITHUB_REF_NAME}`** — GitHub syntax; on GitVerse: `echo "${{ gitverse.ref }}" | sed 's|refs/tags/v||'`
5. Node.js version in the runner: 22 (preinstalled).

### Secrets

| Secret | Purpose |
|--------|------------|
| `NPM_TOKEN` | Publishing to npmjs.org |
| `GV_TOKEN` | GitVerse token: release API, the GitVerse npm registry, git push from the bot (images are no longer published to GitVerse) |
| `GT_TOKEN` | Gitea token (`git.itphx.ru`, login `itphx`): publishing **images** (`build-docker`, `publish-images-gitea`) and the **Helm chart** (`publish-helm`) in `release.yaml`; rights — container registry + `package:write` |
| `GV_GITEA_TOKEN` | Gitea token (`git.itphx.ru`) for the Gitea npm registry — publishing beta packages in `beta.yaml` (needs the `package:write` permission) |
| `GH_TOKEN` | GitHub mirror: push refs, GitHub Release and npm publishing to GitHub Packages (classic PAT, scopes `repo` + `write:packages`) |
| `GV_SYNTH_URL` | Base API v2 URL of the Synth instance that receives the release event (e.g. `https://synth.k3s.itphx.loc/api/v2`) |
| `GV_SYNTH_MEDIA_KEY` | Synth service-key with the `events:ingest` scope — receives the release event (see “Release event for synth-media”) |

The `GITVERSE_` prefix is forbidden in GitVerse secret names — use `GV_`.

## Release event for synth-media

After a release, CI publishes **one external event** to Synth — the agent inside Synth prepares a draft of the release post (the `media-hub` skill, the `synth-media` subsystem).

### How it works

```text
release.yaml (the media-event job)
        │  POST {SYNTH_URL}/api/v2/events
        │  Authorization: Bearer <service-key, scope events:ingest>
        │  {source: "ci", type: "release_published", payload: {…}, dedupKey: "ci:release:vX.Y.Z"}
        ▼
Synth: EventIngress → Router (ADR-089)
        │  routing rule: source=ci / type=release_published → ephemeral agent session
        ▼
Agent (publisher) per the media-hub skill: draft_create → draft_render → draft_submit
        ▼
Owner: approve / rewrite / reject in the synth-media UI (publishing needs a channel connector)
```

**The CI hook collects the facts, not the agent.** The agent inside Synth has no access to the repository (workspace policy `deny`; file/git tools require a project workspace), so everything needed for the post text arrives in the event `payload`.

### The `scripts/media-release-event.sh` script

Collects the release facts and publishes the event:

| Fact source | What is taken |
|---|---|
| release tag | `--tag` / `SYNTH_RELEASE_TAG` → tag at `HEAD` → `v<version>` from `packages/synth/package.json` |
| previous tag | the semver tag list (`git tag --sort=-v:refname`) — the neighbour before the current one |
| release description | `--changelog` → `changelog-partial.md` (artifact of the `changelog` job) → `docs/releases/<VERSION>.md` → generated by `scripts/changelog.sh` → `CHANGELOG.md` (EN mirror) / `CHANGELOG.ru.md` (canonical) |
| highlights | up to 7 lines of the release description without markdown headings (intro paragraph + list items) |
| commits | `git log PREV..TAG --no-merges` (`sha` + `subject`), at most 100 |
| new ADs | files added under `docs/arch_decisions/` since the previous release; title and status come from the AD index table in `AGENTS.md` |

Event format:

```json
{
  "source": "ci",
  "type": "release_published",
  "dedupKey": "ci:release:v0.11.3",
  "payload": {
    "kind": "release",
    "version": "0.11.3",
    "previousVersion": "0.10.1",
    "tag": "v0.11.3",
    "date": "2026-10-20",
    "repo": "https://gitverse.ru/itphx/synth.git",
    "highlights": ["…"],
    "commits": [{ "sha": "…", "subject": "…" }],
    "ads": [{ "id": "ADR-089", "title": "…", "status": "✅ Implemented" }],
    "changelog": "…markdown…"
  }
}
```

The `dedupKey` is bound to the **release**, not to the run: a re-run of the job does not create a second event and a second session.

### Local check

```bash
# build the event and print the JSON — nothing is sent
bash scripts/media-release-event.sh --dry-run

# send it to your own instance
SYNTH_URL=http://localhost:5000/api/v2 \
SYNTH_MEDIA_KEY=<service-key> \
bash scripts/media-release-event.sh
```

Flags: `--dry-run`, `--url`, `--key`, `--tag`, `--version`, `--changelog`, `--repo`, `--max-highlights`, `--max-commits`. The script only reads the repository and sends **one** event — it commits nothing and pushes nothing; the key is never printed (`curl -sS` without `-v`).

### GitVerse secrets

| Secret | What to put there | Where to get it |
|---|---|---|
| `GV_SYNTH_URL` | Base API v2 URL of the instance that receives the event (e.g. `https://synth.k3s.itphx.loc/api/v2`) | the environment address |
| `GV_SYNTH_MEDIA_KEY` | The service-key secret (`synth_svc_…`) with the `events:ingest` scope | `POST /api/v2/service-keys` on the target instance (the secret is shown once) |

Keys and tokens are **not stored in git**: the `synth-deploy` repository holds no secrets, the working values live in `secrets/` outside the repository.

### Failure tolerance

Publishing the post **does not block the release**:

- the `media-event` job runs with `continue-on-error: true`, and no release job depends on it;
- no secrets → publishing is skipped with a warning, exit code `0`;
- Synth unreachable or a non-2xx answer → a warning in the log and exit code `3` (the job stays “soft-failed”, the release is not broken);
- exit code `2` — a usage error only (unknown flag).

The job step is: `bash scripts/media-release-event.sh` (the complex bash lives in a file — a GitVerse specific, see “GitVerse CI specifics”).

## Release to the GitHub mirror

GitHub is a **mirror and releases**, not a build contour. GitHub Actions are **not used** in the repository: all workflows live in GitVerse CI (`.gitverse/workflows/`), and GitHub only receives what is already built.

### Image policy

Every Synth image lives in **one** registry — the public Gitea `git.itphx.ru/itphx`:

| Image | Repository | Tags |
|---|---|---|
| `synth` | `git.itphx.ru/itphx/synth` | `<version>` (multi-arch amd64+arm64) |
| `synth-backend` | `git.itphx.ru/itphx/synth-backend` | `<version>` (slim), `<version>-<flavor>` |
| `synth-ui` | `git.itphx.ru/itphx/synth-ui` | `<version>` |
| `synth-executor` | `git.itphx.ru/itphx/synth-executor` | `<version>-<flavor>` |
| `synth-provisioner` | `git.itphx.ru/itphx/synth-provisioner` | `<version>` |

ghcr.io and gitverse.ru are **not** used as image registries; neither is Docker Hub. Only the versioned tag is published (no `latest`), pulls are anonymous — `imagePullSecret` is optional. Flavor and executor images — see "Executor images and flavors" (multi-arch and the best-effort manifest list are described there).

### What GitVerse CI does

The `publish-github` job in `.gitverse/workflows/release.yaml` runs after the npm and Docker build/publish (`build-docker`) and after the `changelog` job:

1. **Mirror:** push `master→main` and all tags to `https://github.com/itphx/synth.git` (only `main` + tags, no other branches);
2. **GitHub Release** for the tag `v<version>` — the body is **in English**: `bash scripts/changelog.sh --lang en` reads `docs/releases/<version>.en.md` (the file is mandatory: the `release-notes` gate will not let a release through without it; the fallback to the Russian description/commit auto-generation is emergency-only, for a manual `release-github.sh`), plus an English "Installation" block (npm from npmjs.org/GitVerse/GitHub Packages, the image from `git.itphx.ru/itphx/synth:<version>`); creation is idempotent (if a release for the tag exists, the body is updated);
3. **Assets — best-effort:** `cli.js` (an artifact of the `build` job), the Helm chart (`helm package charts/synth`, version from `Chart.yaml`), `SHA256SUMS`. If a file is missing, a warning is printed and the work continues; an asset upload error **does not fail** the job, but is visible in the log. On GitHub the standard `uploads.github.com` is used (unlike the GitVerse API, which returns 500 for assets — there the asset is also best-effort).

All three base images (`synth`, `synth-backend` slim, `synth-ui`) are built in the `build-docker` job (docker on the self-hosted runner) and published **only** to Gitea: `git.itphx.ru/itphx/<image>:<version>`. Authorization comes from the `GT_TOKEN` secret; GitHub does not take part in image publishing.

### Local backfill

`scripts/release-github.sh` — for "catching up" historical tags and re-releasing when GitVerse CI is unavailable:

```bash
./scripts/release-github.sh --version 0.10.0 --dry-run                        # plan without actions
./scripts/release-github.sh --version 0.10.0 --push-refs --yes                # mirror refs (master→main + tags)
./scripts/release-github.sh --version 0.10.0 --release --yes                  # GitHub Release + assets
./scripts/release-github.sh --version 0.10.0 --push-refs --release --yes      # both
```

The script does **not** build or publish Docker images (GitVerse CI does that) and does not publish npm. The token is taken from `GH_TOKEN` or `gh auth token` — it is not stored in the file. Mutating operations require `--yes`.

### Why without GitHub Actions

A deliberate decision: the single build contour is GitVerse CI (docker on the self-hosted runner) and images go to the Gitea registry. Duplicating the build on GitHub would break reproducibility (two sources of truth for images/releases) and would hit artifact limits. The GitHub side is deliberately thin: a code mirror + releases + the npm package in GitHub Packages.

### Secrets of the GitHub side

- **`GH_TOKEN`** — a classic PAT with the `repo` + `write:packages` scopes: mirror push (`main` + tags), GitHub Release and the npm package published to GitHub Packages (`write:packages` is required). Images are no longer published to GHCR, so no container-registry rights are needed. It is better to create the PAT on a **separate machine account**, not a personal one.

## Important: the `repository` field in package.json

For publishing to the GitVerse Package Registry the `repository` field in `package.json` **must be absent**: when linking a package to a repository by `repository.url`, GitVerse checks permissions and returns 403 "no permission". In all 8 packages the `repository` field has been removed — do not add it back.

The same absence suits **GitHub Packages**: if `repository.url` points to another host, publishing to `https://npm.pkg.github.com` is rejected (404) — so do not add the field.

## Local check before pushing

```bash
pnpm typecheck && pnpm lint && pnpm test
```
