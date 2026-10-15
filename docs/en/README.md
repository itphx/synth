# Synth developer documentation — English catalog

> 🌐 **English** · [Russian](../../README.md)

This directory holds the **English versions of the developer documentation** for
the public [GitHub mirror](https://github.com/itphx/synth). The Russian originals
in [`docs/`](../) stay canonical; English versions are kept in sync with them (see
the language rule in the root [AGENTS.md](../../AGENTS.md)).

- English project overview: [`README.en.md`](../../README.en.md)
- Mandatory terminology for translations: [`GLOSSARY.md`](./GLOSSARY.md)

## Status

`✅ available` — the English file exists. `⏳ planned` — translation pending.
`—` — no English version is planned (see the notes below).

| Russian file | English file | Status |
|---|---|---|
| [`README.md`](../../README.md) | [`README.en.md`](../../README.en.md) | ✅ available |
| — | [`docs/en/GLOSSARY.md`](./GLOSSARY.md) | ✅ available |
| [`docs/API_V2.md`](../API_V2.md) | `docs/en/API_V2.md` | ⏳ planned |
| [`docs/CONFIGURATION.md`](../CONFIGURATION.md) | [`docs/en/CONFIGURATION.md`](./CONFIGURATION.md) | ✅ available |
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | [`docs/en/ARCHITECTURE.md`](./ARCHITECTURE.md) | ✅ available |
| [`docs/HYBRID.md`](../HYBRID.md) | [`docs/en/HYBRID.md`](./HYBRID.md) | ✅ available |
| [`docs/UI-KIT.md`](../UI-KIT.md) | [`docs/en/UI-KIT.md`](./UI-KIT.md) | ✅ available |
| [`docs/ROUTING.md`](../ROUTING.md) | [`docs/en/ROUTING.md`](./ROUTING.md) | ✅ available |
| [`docs/LLM_PROVIDERS.md`](../LLM_PROVIDERS.md) | [`docs/en/LLM_PROVIDERS.md`](./LLM_PROVIDERS.md) | ✅ available |
| [`docs/QUICKSTART.md`](../QUICKSTART.md) | `docs/en/QUICKSTART.md` | ⏳ planned |
| [`docs/DEVELOPMENT.md`](../DEVELOPMENT.md) | `docs/en/DEVELOPMENT.md` | ⏳ planned |
| [`docs/PUBLISHING.md`](../PUBLISHING.md) | `docs/en/PUBLISHING.md` | ⏳ planned |
| [`docs/TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) | `docs/en/TROUBLESHOOTING.md` | ⏳ planned |
| [`docs/KEYCLOAK.md`](../KEYCLOAK.md) | `docs/en/KEYCLOAK.md` | ⏳ planned |
| [`docs/ARCH_DECISIONS.md`](../ARCH_DECISIONS.md) | — | stays Russian |
| [`docs/roadmap.md`](../roadmap.md) | — | stays Russian |

## Notes

- **ADR/PROP stay in Russian.** Architecture decisions and proposals in
  [`docs/arch_decisions/`](../arch_decisions/) and their index are not translated:
  identifiers and file names are stable and referenced across the repository.
- **Journals and append-only records** (release notes in `docs/releases/`, task
  logs) stay in Russian as well.
- **User documentation** is not duplicated here. The portal is configured for a
  bilingual structure (an i18n plugin with an English locale, translated
  navigation and fallback to the Russian source for untranslated pages), but the
  English build is currently **disabled** (`build: false` in the portal's
  `mkdocs.yml`) until the pages are translated — the only English page so far is
  a stub. The Russian portal therefore remains the canonical source, and keeping
  English versions in this repository targets the developer documentation, not
  the user portal.
- **Terminology.** Use [`GLOSSARY.md`](./GLOSSARY.md) for every translation. On a
  conflict with the English product strings (UI or engine), the product wins.
