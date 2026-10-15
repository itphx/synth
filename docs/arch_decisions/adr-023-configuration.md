# ADR-023: Конфигурация

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md

Приоритет: `CLI-флаги > SYNTH_* env vars > config.yaml > defaults`.

Каскадный поиск `config.yaml`:
1. `--config` / `SYNTH_CONFIG`
2. `./synth.config.yaml`
3. `./config.yaml`
4. `~/.config/synth/config.yaml`
5. `/etc/synth/config.yaml`

Ключевые env vars: `SYNTH_DATA_DIR`, `SYNTH_PORT`, `SYNTH_CORE_PORT`, `SYNTH_AUTH_DEBUG`, `SYNTH_API_KEY`.
