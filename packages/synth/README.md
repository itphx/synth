# @itphx/synth

**Synth** — AI-платформа для командной работы: self-hosted чат-агент с
инструментами, MCP и скиллами, который работает и на личной машине. Этот пакет —
публикуемая CLI-обёртка (`bin: synth`) над `@itphx/synth-core`,
`@itphx/synth-ui` и `@itphx/synth-shared`.

## Установка и запуск

```bash
# Глобально
npm i -g @itphx/synth
synth serve --api-key my-secret-key

# Без установки
npx @itphx/synth serve --api-key my-secret-key
```

После старта откройте <http://localhost:4300> и введите ключ.

Провайдер LLM (Ollama, OpenAI, Anthropic) настраивается переменными окружения
`SYNTH_PROVIDER_<NAME>_*` или командой `synth config provider add` — подробности
в документации по ссылкам ниже.

## Документация и код

- Пользовательская документация: <https://docs.synth.itphx.ru/>
- Исходники и полный README: <https://gitverse.ru/itphx/synth>
  (зеркало — <https://github.com/itphx/synth>)

## Лицензия

MIT.
