# Keycloak (OIDC) integration

> 🌐 **English** · [Russian](../KEYCLOAK.md)

> ⚠️ RU-версия обновлена 2026-11-14 (**§2.5 «Группы → доступ к проектам (ADR-140)»** —
> маппер членства в группах (claim `groups`), allowlist имён в Synth, типовые проблемы;
> §3.1/§3.2 — `auth.oidc.groups` и env `SYNTH_OIDC_GROUPS_CLAIM`/`SYNTH_OIDC_GROUPS_ALLOW`;
> §4 — проверка групп в `id_token` и симптомы — **переведено**).

Operator guide: how to configure Keycloak and which parameters to set in Synth to deploy a
"Synth + Keycloak" combination with correct role issuance. The material is based on a real setup
(realm `synth`, client `synth`, FreeIPA as the user store).

## 1. How Synth works with Keycloak

The backend acts as an OIDC client (confidential, authenticated with `client_secret`). Two sign-in methods are supported:

| Method | Endpoint | When it is used |
|--------|----------|--------------------|
| Authorization Code | `GET /auth/login` → redirect to Keycloak → `GET /auth/callback` | Standard browser flow |
| ROPC (login/password) | `POST /auth/login` (JSON: `username`, `password`) | Sign-in with login/password directly in the UI, without a redirect |

After exchanging the code/password, the backend verifies `id_token` and `access_token` via the provider's JWKS and extracts the roles.

**How roles are extracted** (`packages/backend/src/auth/oidc.ts`):

1. Roles are taken from `realm_access.roles` (realm roles) and `resource_access.<clientId>.roles` (client roles) — from `id_token`;
2. If `id_token` has no roles, they are taken from `access_token`;
3. Roles are normalized to uppercase and filtered against the known list: `ADMIN`, `USER`, `LEAD`, `AUDITOR`;
4. If there are no known roles at all, the user gets the default role `USER`.

Access depends on these roles: `ADMIN` — admin UI sections and admin endpoints, `AUDITOR` — audit and logs,
`LEAD` — dashboard and session/project management, `USER` — regular work.

## 2. Configuring Keycloak

### 2.1 Realm

Create a separate realm (for example `synth`). The issuer identifier for Synth:

```
https://<keycloak-host>/realms/<realm>
```

### 2.2 Client

Create a client with the following parameters:

| Parameter | Value | Why |
|----------|----------|-------|
| Client ID | `synth` | Must match `clientId` in the Synth config |
| Client authentication | **ON** (confidential) | Authentication with `client_secret` |
| Standard flow | **ON** | For `GET /auth/callback` (authorization code) |
| Direct Access Grants | **ON** | For `POST /auth/login` (ROPC) |
| Valid redirect URIs | `https://<synth-host>/auth/callback` | Where Keycloak redirects after sign-in |
| Web origins | `https://<synth-host>` | Allowed CORS origins |

### 2.3 Roles

Create realm roles with exact names: `admin`, `user`, `lead`, `auditor` (lowercase — the backend itself
converts them to `ADMIN/USER/LEAD/AUDITOR`).

> **Important.** Role names must come from the known list. A role like `administrator`, `synth_admin`,
> `admins`, etc. will be **dropped** by the filter, and the user will get `USER`.

You can assign a role directly to a user or through a group (recommended for FreeIPA):

1. A FreeIPA group is synchronized into Keycloak as a group (for example `synth_admins`);
2. In Keycloak: group → **Role mapping** → assign the realm role `admin`;
3. Members of the group get the role automatically (composite role).

To verify: in the Keycloak Admin console, the user's **Role mapping** must show the effective roles.

### 2.4 Client scopes and role mappers — what to watch out for

Roles get into tokens through protocol mappers in client scopes (usually the `roles` scope):
the **realm roles** mapper (`realm_access.roles`) and the **client roles** mapper (`resource_access.<clientId>.roles`).

Both mappers must have the following enabled:

| Mapper option | Value | Effect |
|---------------|----------|--------|
| `id.token.claim` | `true` | Roles get into `id_token` |
| `access.token.claim` | `true` | Roles get into `access_token` |
| `multivalued` | `true` | Roles as an array |

**A typical problem:** if a mapper has `id.token.claim` disabled, the roles are only in `access_token`.
The backend falls back to taking them from `access_token`, but before this behavior (and with `access.token.claim`
disabled) the user always got the `USER` default — admin sections did not appear in the UI, even if the role was assigned correctly.

To check: decode `id_token` (for example at https://jwt.io) — the payload must contain a block:

```json
{
  "realm_access": {
    "roles": ["user", "admin", "..."]
  }
}
```

### 2.5 Groups → project access (ADR-140)

Groups are a **separate axis** from roles. A role (`ADMIN`/`USER`/`LEAD`/`AUDITOR`) is a
global instance right; a group (`synth-devs`, `synth-admins`) is the source of grants
**for a project** ("participants via groups", `group_members`). Roles are filtered by the
list of known ones and upper-cased; groups are **case-sensitive**, the names are matched
exactly.

#### In Keycloak: the group membership mapper

Groups arrive in a separate `groups` claim — it is put there by the **group membership
mapper** (not the role mapper from 2.4). The order: **Realm → Groups** — create the
groups and assign the users; then in the client scope of the `synth` client add a
**Group membership** mapper with these options:

| Mapper option | Value | Effect |
|---------------|----------|--------|
| `Claim name` | `groups` | The claim name (Keycloak's default is `groups`) |
| `id.token.claim` | `true` | Groups get into `id_token` |
| `access.token.claim` | `true` | Groups get into `access_token` |
| `multivalued` | `true` | Groups as an array |
| `Full group path` | `false` | Only the group name (`synth-devs`), not the path (`/synth-devs`) |

> **Mind `Full group path`.** The claim values are exactly what Synth matches against the
> allowlist. With `Full group path: true` the claim will contain `/synth-devs`, and the
> allowlist must contain exactly `/synth-devs`; with `false` — `synth-devs`. A difference
> of one slash means the group does not match.

To check: decode `id_token` — the payload must contain a block:

```json
{
  "groups": ["synth-devs", "synth-admins"]
}
```

#### In Synth: the group name allowlist

Not **all** groups from the claim are accepted — only the ones listed in the allowlist:

```yaml
auth:
  oidc:
    groups:
      claim: groups          # the claim name with the groups (default groups)
      allow:                 # allowlist of group names; empty — no groups
        - synth-devs
        - synth-admins
```

or via env (csv, takes precedence over `config.yaml`):

```bash
SYNTH_OIDC_GROUPS_CLAIM=groups
SYNTH_OIDC_GROUPS_ALLOW=synth-devs,synth-admins
```

**Without an allowlist there are no groups** (fail-closed): "accept everything" is
impossible — a claim from the IdP is not a trusted input, and the list of allowed names is
set by the operator. An empty allowlist → the user has no groups at all → group grants
give no access.

Claim parsing: the name is at the **top level** (nested paths are not parsed), the values
are strings only (whitespace trimmed, deduplicated, the claim order preserved); a missing
claim or a non-array → no groups. Fallback: if `id_token` has no groups, they are taken
from `access_token`.

#### Typical problems

| Symptom | Cause | Solution |
|---------|---------|---------|
| No groups, a group grant gives no access | The group membership mapper is disabled — the `groups` claim is absent from the token | Enable the mapper (see above) and **log in again**: the groups are a snapshot taken at login |
| The group is in the allowlist but does not match | The match is **exact and case-sensitive**: `Synth-Devs` ≠ `synth-devs`; the path `/synth-devs` ≠ `synth-devs` | Bring the allowlist in line with what is actually in the claim (look at `id_token`) |
| Changed the group membership in the IdP — nothing changes | The groups are a **snapshot taken at login** (cookie session), updated only on a repeated login | Log out and log in again; or wait for the cookie session to expire (`auth.sessionMaxAgeMinutes`, default 1440 min = 24 h) |

## 3. Synth parameters

### 3.1 config.yaml

```yaml
auth:
  oidc:
    enabled: true
    issuer: "https://keycloak.example.com/realms/synth"
    clientId: "synth"
    clientSecret: "<client-secret>"
    redirectUri: "https://synth.example.com/auth/callback"
    cliClientId: "synth-cli"      # public client for the local CLI/core (ROPC/device flow), not a secret
    groups:                        # ADR-140: the source of groups for project access
      claim: "groups"              # the claim name with the groups (default groups)
      allow:                       # allowlist of group names; empty — no groups (fail-closed)
        - "synth-devs"
        - "synth-admins"
```

`cliClientId` (default `synth-cli`) — the public client_id that the backend hands to local clients via `GET /auth/oidc-meta` (`cliClientId || 'synth-cli'`, `packages/backend/src/routes/auth.ts`). The local core uses it for the ROPC/device flow in a hybrid connection (see [HYBRID.md](./HYBRID.md)); in Keycloak this is a separate public client with Direct Access Grants enabled (no secret).

The `groups` section is **optional** (old configs without it are valid). Details — in section [2.5](#25-groups--project-access-adr-140) and in [CONFIGURATION.md](./CONFIGURATION.md).

### 3.2 Environment variables

| Variable | Purpose |
|-----------|------------|
| `SYNTH_OIDC_ENABLED` | `true` — enable OIDC |
| `SYNTH_OIDC_ISSUER` | Issuer: `https://<keycloak-host>/realms/<realm>` |
| `SYNTH_OIDC_CLIENT_ID` | Client ID (for example `synth`) |
| `SYNTH_OIDC_CLIENT_SECRET` | Client secret (keep it in secrets, not in the config) |
| `SYNTH_OIDC_REDIRECT_URI` | Redirect URI: `https://<synth-host>/auth/callback` |
| `SYNTH_OIDC_CLI_CLIENT_ID` | Public client_id for the local CLI/core (ROPC/device flow), default `synth-cli` (`packages/backend/src/lib/app-config.ts`) |
| `SYNTH_OIDC_GROUPS_CLAIM` | The claim name with the groups (ADR-140), default `groups` |
| `SYNTH_OIDC_GROUPS_ALLOW` | The group name allowlist (ADR-140) — csv (`synth-devs,synth-admins`), spaces are trimmed, empty items are dropped; takes precedence over `config.yaml`; **an empty value — no groups** (fail-closed) |

Priority: env vars > config.yaml (see [CONFIGURATION.md](./CONFIGURATION.md)).

### 3.3 Helm deployment (synth-deploy)

```yaml
backend:
  oidc:
    enabled: true
    issuer: "https://keycloak.example.com/realms/synth"
    clientId: "synth"
    redirectUri: "https://synth.example.com/auth/callback"
```

- `clientSecret` is not set in values — it is placed in a SealedSecret as `SYNTH_OIDC_CLIENT_SECRET`;
- if Keycloak is signed by an internal CA, configure trust via the **standard path** — the `security.tls`
  section (`caFile`/`caPem`) or the env var `SYNTH_TLS_CA_FILE` (otherwise the backend cannot verify the JWT
  or reach the issuer):

  ```yaml
  security:
    tls:
      caFile: /etc/synth/tls/ca.crt    # or caPem — the PEM itself; SYNTH_TLS_CA_FILE / SYNTH_TLS_CA_PEM
  ```

  In Helm it is convenient to put the CA in a Secret and mount it (`security.tls.existingSecret` + `caKey`) —
  see `charts/synth/README.md`. `backend.extraEnv.NODE_EXTRA_CA_CERTS` remains only a compatibility channel
  for child processes and is **not** Synth configuration (when `security.tls` is set, Synth installs its own
  global TLS dispatcher and ignores that variable).

## 4. Verification and diagnostics

### Check issuer availability

```bash
curl -s https://<keycloak-host>/realms/synth/.well-known/openid-configuration | jq .issuer
```

### Check that roles get into id_token

```bash
curl -s -X POST "https://<keycloak-host>/realms/synth/protocol/openid-connect/token" \
  --data-urlencode "grant_type=password" \
  --data-urlencode "client_id=synth" \
  --data-urlencode "client_secret=<client-secret>" \
  --data-urlencode "username=<user>" \
  --data-urlencode "password=<password>" \
  --data-urlencode "scope=openid" \
  | jq -r .id_token | cut -d. -f2 | base64 -d 2>/dev/null | jq .
```

The decoded `id_token` must contain `realm_access.roles` with the expected role (`admin`, etc.).

### Check that groups get into id_token

The same command, but look for the `groups` block in the payload:

```json
{
  "groups": ["synth-devs", "synth-admins"]
}
```

The values are matched against the allowlist **exactly and case-sensitively** — compare
them literally (see [2.5](#25-groups--project-access-adr-140)).

### Symptoms and causes

| Symptom | Cause | Solution |
|---------|---------|---------|
| All users get `USER`, no admin UI | The role mapper does not include roles in `id_token`/`access_token` | Enable `id.token.claim` and `access.token.claim` on the realm roles / client roles mappers (see 2.4) |
| The role exists in Keycloak, but not in the UI | The role is not named from the known list (`ADMIN/USER/LEAD/AUDITOR`) | Rename the role or add it to `KNOWN_ROLES` |
| The role is assigned, but as a client role to another client | `resource_access.<clientId>` does not match the Synth `clientId` | Assign the role to the `synth` client or assign a realm role |
| No groups, a group grant gives no access | The allowlist is not set (`auth.oidc.groups.allow` / `SYNTH_OIDC_GROUPS_ALLOW`) or the group membership mapper is disabled | Set the allowlist, enable the mapper and log in again (see 2.5) |
| The group is in the allowlist, but did not match | The match is exact and case-sensitive; the path `/synth-devs` ≠ `synth-devs` | Bring the allowlist in line with the values in `id_token` |
| The backend cannot verify the JWT / 401 on sign-in | The backend does not trust the Keycloak CA | Configure `security.tls.caFile`/`caPem` (env `SYNTH_TLS_CA_FILE`, see 3.3) |

## 5. Test environment accounts

- The test account (realm `synth`, role `user`) and the temporary admin account (realm `master`) are in the file
  `secrets/keycloak-accounts.md` at the project root, **outside** the git repository `synth/`.
- The temporary admin account is used for the Keycloak admin API (`admin-cli`) — for example, to diagnose
  roles and mappers.
- The client secret of the `synth` client is in the SealedSecret `synth-secrets` (namespace `synth`, key
  `SYNTH_OIDC_CLIENT_SECRET`).
