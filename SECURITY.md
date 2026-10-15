# Security Policy

Thank you for helping keep Synth and its users safe.

> Русская версия: [SECURITY.ru.md](./SECURITY.ru.md).

## Supported versions

Security fixes are provided for the current release line only:

| Version  | Supported |
| -------- | --------- |
| `0.10.x` | ✅        |
| < `0.10` | ❌        |

Pre-1.0 releases are moving quickly; please upgrade to the latest `0.10.x` before
reporting, and reproduce against it where possible.

## Reporting a vulnerability

**Do not report security issues through public GitHub/GitVerse issues, discussions,
or pull requests.** Instead, contact the maintainers privately:

- **Email:** admin@itphx.ru
- **Telegram:** <https://t.me/synth_dev_admin>

Please include as much of the following as you can:

- Synth version (for example `0.10.1`) and how it was installed
  (npm / Docker / Kubernetes / hybrid / from source);
- operating system and Node.js version;
- a clear description of the issue and its security impact;
- step-by-step reproduction instructions (a minimal proof of concept if possible);
- relevant logs, configuration, or request/response samples (with secrets redacted);
- your assessment of severity and any suggested mitigation.

## Response timeline (best effort)

These are good-faith targets, not a contractual SLA:

- **Acknowledgement:** within **72 hours**.
- **Initial assessment** (triage, severity, next steps): within **7 days**.

We will keep you updated on progress and coordinate disclosure. Please give us a
reasonable window to release a fix before public disclosure.

## Out of scope

- Vulnerabilities in third-party LLM providers, models, or external APIs that Synth
  merely calls — report those to the respective vendor.
- Issues caused by self-hosted misconfiguration (for example exposed `.env` or
  `secrets/`, open ports, disabled TLS) that are outside Synth's own defaults and
  documented guidance.
- Reports that require an already-compromised host or privileged local access.

## Secrets

Secrets (tokens, keys, passwords) must **never** be committed. They live in
`secrets/`, outside the git repository. The repository ships a
[`.gitleaks.toml`](./.gitleaks.toml) config and runs `scripts/secret-scan.mjs`
(dependency-free, same allowlist) in CI — on every push/PR and as a mandatory step of
the release gate — to catch accidental leaks in the working tree and in the history.
If you believe a secret has been exposed, contact us privately at the addresses above
so we can rotate it.

## License and credit

Synth is distributed under the [MIT License](./LICENSE). We are happy to credit
reporters who wish to be named, and to respect requests for anonymity.
