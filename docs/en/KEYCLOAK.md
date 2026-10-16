# Keycloak (OIDC) integration

> 🌐 **English** · [Russian](../KEYCLOAK.md)

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
```

`cliClientId` (default `synth-cli`) — the public client_id that the backend hands to local clients via `GET /auth/oidc-meta` (`cliClientId || 'synth-cli'`, `packages/backend/src/routes/auth.ts`). The local core uses it for the ROPC/device flow in a hybrid connection (see [HYBRID.md](./HYBRID.md)); in Keycloak this is a separate public client with Direct Access Grants enabled (no secret).

### 3.2 Environment variables

| Variable | Purpose |
|-----------|------------|
| `SYNTH_OIDC_ENABLED` | `true` — enable OIDC |
| `SYNTH_OIDC_ISSUER` | Issuer: `https://<keycloak-host>/realms/<realm>` |
| `SYNTH_OIDC_CLIENT_ID` | Client ID (for example `synth`) |
| `SYNTH_OIDC_CLIENT_SECRET` | Client secret (keep it in secrets, not in the config) |
| `SYNTH_OIDC_REDIRECT_URI` | Redirect URI: `https://<synth-host>/auth/callback` |
| `SYNTH_OIDC_CLI_CLIENT_ID` | Public client_id for the local CLI/core (ROPC/device flow), default `synth-cli` (`packages/backend/src/lib/app-config.ts`) |

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

### Symptoms and causes

| Symptom | Cause | Solution |
|---------|---------|---------|
| All users get `USER`, no admin UI | The role mapper does not include roles in `id_token`/`access_token` | Enable `id.token.claim` and `access.token.claim` on the realm roles / client roles mappers (see 2.4) |
| The role exists in Keycloak, but not in the UI | The role is not named from the known list (`ADMIN/USER/LEAD/AUDITOR`) | Rename the role or add it to `KNOWN_ROLES` |
| The role is assigned, but as a client role to another client | `resource_access.<clientId>` does not match the Synth `clientId` | Assign the role to the `synth` client or assign a realm role |
| The backend cannot verify the JWT / 401 on sign-in | The backend does not trust the Keycloak CA | Configure `security.tls.caFile`/`caPem` (env `SYNTH_TLS_CA_FILE`, see 3.3) |

## 5. Test environment accounts

- The test account (realm `synth`, role `user`) and the temporary admin account (realm `master`) are in the file
  `secrets/keycloak-accounts.md` at the project root, **outside** the git repository `synth/`.
- The temporary admin account is used for the Keycloak admin API (`admin-cli`) — for example, to diagnose
  roles and mappers.
- The client secret of the `synth` client is in the SealedSecret `synth-secrets` (namespace `synth`, key
  `SYNTH_OIDC_CLIENT_SECRET`).
