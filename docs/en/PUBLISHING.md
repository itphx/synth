# Publishing and release

> 🌐 **English** · [Russian](../PUBLISHING.md)

Developer/maintainer guide: how to build, publish and release Synth. All commands are run from the monorepo root (`synth/`).

## Package publishing order

**All 6 packages** are published in strict dependency order:

```
shared → core → ui → backend → sdk → synth
```

The order is set by the dependency hierarchy: `@itphx/synth-shared` is the foundation, `@itphx/synth-core` imports shared, `@itphx/synth-backend`/`@itphx/synth-ui` import core, `@itphx/synth-sdk` is a thin client of the public API over shared (ADR-052), `@itphx/synth` is a thin wrapper over core/ui/shared (ADR-038).

## `pnpm publish` instead of `npm publish`

`npm publish` does **not rewrite** `workspace:*` in dependencies — the published packages break for npm consumers (`workspace:*` is not resolved). `pnpm publish` automatically replaces `workspace:*` with the actual versions of the workspace packages, so it is the one used.

The publishing scripts use the `--no-git-checks` flag (publishing happens not from a clean git tree).

## Registries

| Registry | URL | Token |
|--------|-----|-------|
| npmjs.org | `https://registry.npmjs.org` | `NPM_TOKEN` |
| GitVerse Package Registry | `https://gitverse.ru/api/packages/itphx/npm/` | `GV_TOKEN` |

Token values are stored in repository secrets (GitVerse CI) and in the local environment. **Never put token values in documentation, code or commits.**

Checking the npmjs token: `npm whoami --registry https://registry.npmjs.org`.

## npm 2026 requirements (important)

Since 2026 npm has tightened its publishing requirements:

- **Old classic tokens without 2FA are revoked.** To publish you need a **Granular Access Token (GAT) with 2FA enabled** (`publish` rights only for the required `@itphx/*` packages) or a classic token with 2FA enabled on the account.
- **Tokens with `bypass 2FA` do not publish directly** (from January 2027 — only staged publishing with manual 2FA confirmation). When creating a token do NOT choose "bypass 2FA" — use a regular GAT.
- **GAT tokens without the `unpublish` right** cannot delete a published version — use `npm deprecate` instead of `npm unpublish` (see [Troubleshooting](../TROUBLESHOOTING.md)).
- **npm v12**: `allowScripts`/`--allow-git`/`--allow-remote` are disabled by default. If installing a package needs lifecycle scripts — `npm approve-scripts`/`--allow-scripts`.

## Docker image

The image is built from the published npm package: `npm install -g @itphx/synth@<version>` (the `@itphx/synth-core`/`@itphx/synth-ui`/`@itphx/synth-shared` dependencies are installed transitively, prompts and UI are resolved from node_modules). Dockerfile: `docker/Dockerfile`.

The Docker registry is **`gitverse.ru`** (not `registry.gitverse.ru`!). The image:

```
gitverse.ru/itphx/synth:<version>
```

The `latest` tag is **not published** — only versioned tags remain in the registry. Reason: the "Packages" quota in GitVerse counts each version's size without dedup — `latest` and the version point to the same digest but are paid for twice (500 MB limit per repository). Therefore `docker pull gitverse.ru/itphx/synth` without a tag does not work — specify the version.

Additionally the **base `synth` image** (and only it) is mirrored to the GitHub Container Registry — `ghcr.io/itphx/synth:<version>`; the `synth-backend`/`synth-ui` images are not published to GHCR. The policy and the reason are in the section [Release to the GitHub mirror](#release-to-the-github-mirror).

## Helm chart

The application chart is `charts/synth/` in the monorepo. The chart version and `appVersion` equal the release version: on a bump in CI (`version-bump` in `release.yaml`) they are updated together with `version.ts` and `package.json`.

The registry is the **native GitVerse Helm registry**, not OCI (the `helm push oci://...` path is not used on GitVerse):

```
https://gitverse.ru/api/packages/itphx/helm
```

The index repository is `https://gitverse.ru/api/packages/itphx/helm/index.yaml` (available anonymously).

### Publishing

In CI — the `publish-helm` job in `.gitverse/workflows/release.yaml` (not started on `dry_run`): installing Helm → `helm lint charts/synth` → `helm package` → `curl` POST to `.../helm/api/charts` (success = HTTP 201).

Manually:

```bash
helm package charts/synth --version <version> --app-version <version> --destination dist/helm
curl --user "itphx:$GV_TOKEN" -X POST \
  --upload-file dist/helm/synth-<version>.tgz \
  https://gitverse.ru/api/packages/itphx/helm/api/charts
```

### Installation

```bash
helm repo add synth https://gitverse.ru/api/packages/itphx/helm
helm repo update
helm install synth synth/synth --version <version> -f my-values.yaml
```

The images `gitverse.ru/itphx/synth{,-ui,-backend}:<version>` are pulled **anonymously** — no imagePullSecret is needed.

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
2. `packages/*/package.json` — the `version` field in all 6 packages

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

Environment variables: `NPM_TOKEN`, `GV_TOKEN`, `NPM_REGISTRY`, `GITVERSE_NPM_REGISTRY`, `GITVERSE_DOCKER_REGISTRY`.

Note: the GitVerse npm registry does not support `/-/whoami` (404) — authorization is verified by an actual publish.

### `release-github.sh` — GitHub mirror backfill

```bash
./scripts/release-github.sh --version 0.10.0 --dry-run             # plan without actions
./scripts/release-github.sh --version 0.10.0 --push-refs --yes     # mirror refs (master→main + tags)
./scripts/release-github.sh --version 0.10.0 --release --yes       # GitHub Release + assets
./scripts/release-github.sh --version 0.10.0 --push-refs --release --yes
```

Local backfill of the GitHub mirror: synchronizes refs and creates/updates the GitHub Release.
It does **not** build Docker images (they are built by GitVerse CI → `gitverse.ru` + `ghcr.io`) and does not
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

## Release descriptions

Every release has a **pair** of files in `docs/releases/`; `changelog.sh` takes a file **as a whole**
and uses it as the release body (when such a file exists, the commit-based auto-generation is skipped).
Prepare the descriptions in advance, before the tag is pushed.

| File | Language | Where the body goes |
|------|----------|---------------------|
| `docs/releases/<VERSION>.md` | Russian | body of the **GitVerse Release** (job `create-release`) |
| `docs/releases/<VERSION>.en.md` | English | body of the **GitHub Release** (job `publish-github`) |

What to write: what is included in the release, the key changes, **breaking changes**, and an
installation block (`npm`/`docker`/`helm` commands). For the structure, use
[`docs/releases/0.10.0.md`](../releases/0.10.0.md) as a reference.

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
| `.gitverse/workflows/release.yaml` | push of a `v*` tag + `workflow_dispatch` | **build and publish** of the release (including the GitHub mirror and release) |
| `.gitverse/workflows/ci.yaml` | push to `main`/`master`/`feature/**`/`fix/**`/`refactor/**`/`chore/**`/`docs/**` and PR | code tests: typecheck, lint, tests of `shared`/`core`/`backend`/`ui`/`sdk`, `helm lint` + `template`, `pnpm audit --audit-level=high` (report-only) |
| `.gitverse/workflows/ci-docs.yaml` | push to `main`/`master`/`feature/**` and PR, changes by `paths` (docs/AGENTS.md/check scripts) | `node scripts/adr-check.mjs` + `node scripts/docs-link-check.mjs` |

The split is done via `paths`/`paths-ignore`: `ci.yaml` has `docs/**` and `**/*.md` in `paths-ignore`, so docs pushes do not run the heavy jobs; `ci-docs.yaml` is the opposite — `paths` only for docs, and the job does not install pnpm (the scripts run on bare node).

### Starting a release

1. **Dry-run:** `workflow_dispatch` with `dry_run: true` — a check without publishing
2. **Real publishing:** `workflow_dispatch` with `dry_run: false` (inputs: `bump` patch/minor/major, `pre_release`)
3. **Automatically:** create a `vX.Y.Z` tag and push it — the workflow starts on the tag push (skips the bump stage, the version is taken from the tag)

The manual `workflow_dispatch` is kept in `release.yaml` (items 1–2) — this is the only way to start a build/publish without a tag.

Release workflow: version bump (version.ts + package.json + `charts/synth/Chart.yaml`) → CI checks → build → CHANGELOG → npmjs publish → GitVerse npm publish → Docker (kaniko → `gitverse.ru/itphx/synth` + `ghcr.io/itphx/synth`) → Helm chart publish (`publish-helm`) → create the GitVerse Release → GitHub mirror (`publish-github`: push `main`+tags, GitHub Release).

npm packages are published **only** from GitVerse (`publish-npmjs`/`publish-gitverse-npm`) — the GitHub side does not publish npm.

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
| `GV_TOKEN` | Single GitVerse token (API, Docker Registry, npm registry, git push from the bot) |
| `GH_TOKEN` | GitHub mirror: push refs, GitHub Release, publishing the base image to GHCR (classic PAT, scopes `repo` + `write:packages`) |
| `GHCR_USER` | Optional: the login of the `GH_TOKEN` owner for `ghcr.io` (default `itphx`) |

The `GITVERSE_` prefix is forbidden in GitVerse secret names — use `GV_`.

## Release to the GitHub mirror

GitHub is a **mirror and releases**, not a build contour. GitHub Actions are **not used** in the repository: all workflows live in GitVerse CI (`.gitverse/workflows/`), and GitHub only receives what is already built.

### Image policy

Due to the artifact size limit (~500 MB both on GitVerse and on GitHub), **only the base `synth` image** (standalone) is published:

| Image | `gitverse.ru` | GHCR (`ghcr.io/itphx/…`) | Docker Hub |
|---|---|---|---|
| `synth` | ✅ | ✅ (mirror) | — (later) |
| `synth-backend` | ✅ | ❌ | — (later) |
| `synth-ui` | ✅ | ❌ | — (later) |

The additional images (`synth-backend`/`synth-ui`) are **not published** to GHCR; when the corresponding feature appears (the full image), they will go **only to Docker Hub**. Only the versioned tag is published (no `latest`) — the same policy as in the GitVerse side.

### What GitVerse CI does

The `publish-github` job in `.gitverse/workflows/release.yaml` runs after the npm and Docker build/publish (`build-docker`) and after the `changelog` job:

1. **Mirror:** push `master→main` and all tags to `https://github.com/itphx/synth.git` (only `main` + tags, no other branches);
2. **GitHub Release** for the tag `v<version>` — the body is **in English**: `bash scripts/changelog.sh --lang en` reads `docs/releases/<version>.en.md` (if it is missing — the Russian description with a warning, then commit-based auto-generation), plus an English "Installation" block (npm from npmjs.org/GitVerse, the image from `ghcr.io/itphx/synth:<version>`); creation is idempotent (if a release for the tag exists, the body is updated);
3. **Assets — best-effort:** `cli.js` (an artifact of the `build` job), the Helm chart (`helm package charts/synth`, version from `Chart.yaml`), `SHA256SUMS`. If a file is missing, a warning is printed and the work continues; an asset upload error **does not fail** the job, but is visible in the log. On GitHub the standard `uploads.github.com` is used (unlike the GitVerse API, which returns 500 for assets — there the asset is also best-effort).

The base `synth` image is built in the `build-docker` job (kaniko) into **two** registries at once: `gitverse.ru/itphx/synth:<version>` and `ghcr.io/itphx/synth:<version>`. Authorization in GHCR comes from the `GH_TOKEN` secret.

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

A deliberate decision: the single build contour is GitVerse CI (kaniko). Duplicating the build on GitHub would break reproducibility (two sources of truth for images/releases) and would hit artifact limits. The GitHub side is deliberately thin: a code mirror + releases + publishing one base image to GHCR.

### Secrets of the GitHub side

- **`GH_TOKEN`** — a classic PAT with the `repo` + `write:packages` scopes (mirror push, GitHub Release, GHCR). `write:packages` is a classic scope, so **a fine-grained PAT is officially not supported for the GHCR CLI** — you need a classic one. It is better to create the PAT on a **separate machine account**, not a personal one.
- **`GHCR_USER`** (optional) — the login of the PAT owner for `docker login ghcr.io`; default `itphx`.

## Important: the `repository` field in package.json

For publishing to the GitVerse Package Registry the `repository` field in `package.json` **must be absent**: when linking a package to a repository by `repository.url`, GitVerse checks permissions and returns 403 "no permission". In all 6 packages the `repository` field has been removed — do not add it back.

## Local check before pushing

```bash
pnpm typecheck && pnpm lint && pnpm test
```
