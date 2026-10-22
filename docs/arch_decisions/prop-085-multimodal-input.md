# PROP-085: Мультимодальный ввод (звук, изображения, видео)

> **Статус:** 🧩 Предложение — Мультимодальный ввод (звук/изображения/видео): типы `Part`, blob-хранилище, предобработка, UI-композер
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-01
> **Источник:** перенесено из `AD-DRAFTS.md` (D27).
> **Связано:** [ADR-005](./adr-005-json-storage.md), [ADR-097](./adr-097-storage-provider-class.md),
> [ADR-077](./adr-077-runtime-toolchain.md), [ADR-070](./adr-070-system-prompt-composer.md), [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md),
> [ADR-087](./adr-087-gateways.md), [ADR-089](./adr-089-external-events-automation.md),
> [ADR-086](./adr-086-extensibility-plugins-editions.md), [PROP-047](./prop-047-memory-gbrain.md),
> [ADR-036](./adr-036-llm-gateway.md), [ADR-023](./adr-023-configuration.md).

**Решение:** расширить модель контента сообщения с текстовой на **мультимодальную**: новые типы `Part`
(`image`/`audio`/`video`/`file`) со ссылкой на blob/артефакт + метаданными; загрузка и хранение вложений;
маппинг в форматы провайдеров; поддержка в UI (drag&drop, вставка из буфера, запись голоса, камера);
предобработка — транскрипция аудио, OCR/описание для моделей без vision, извлечение кадров из видео,
конвертация/сжатие и лимиты.

## Контекст

Сегодня модель контента сообщения — текстовая: `Part` умеет только `text`/`tool_use`/`tool_result`/`reasoning`/
`session_reference`. Провайдеры получают текстовый `content`, а вложения (картинки, голос, видео) передать
нельзя. Между тем ввод с телефона (камера/микрофон, [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md)) и вложения из
мессенджеров ([ADR-087](./adr-087-gateways.md), [ADR-089](./adr-089-external-events-automation.md))
— востребованные сценарии, а vision/audio/video-модели у провайдеров уже есть.

## Детали

### Модель контента (Part)

Добавить типы медиа-частей с ссылкой на blob/артефакт и метаданными (mime, размер, разрешение/длительность,
опциональный транскрипт, хэш для дедупа). Текстовые части остаются как есть — обратная совместимость.
Маппинг/сериализация — через `buildContentFromParts` и `_sessionMessagesToLlm`.

### Хранение вложений

Blob/artifact-хранилище для бинарных вложений: на первом этапе — под `$SYNTH_DATA_DIR` через `FileStore`
([ADR-005](./adr-005-json-storage.md), content-addressed по хэшу), целевое — PostgreSQL/S3
([ADR-097](./adr-097-storage-provider-class.md), [ADR-077](./adr-077-runtime-toolchain.md)).

### Маппинг в форматы провайдеров

OpenAI content parts (`image_url`, `input_audio`), Anthropic (`image`/`document`/audio), Gemini
(inline/video). Флаги модальностей — в метаданных модели (сейчас `KNOWN_MODEL_WINDOWS` хранит только окно).

### UI-композер

drag&drop, вставка из буфера, запись голоса (`MediaRecorder`), камера (мобильный ввод,
[ADR-044](./adr-044-mobile-adaptive-ui-pwa.md)), превью, лимиты и индикация размера/стоимости.

### Предобработка

ASR-транскрипция (локально whisper.cpp vs провайдер), OCR/описание для моделей без vision, извлечение
кадров+аудио из видео (ffmpeg), конвертация/сжатие (sharp), лимиты. Влечёт новые зависимости.

### Токены, стоимость и безопасность

Учёт токенов/стоимости медиа (в `providers/base.ts` уже встречается `priceUnit: 'image'`), guard/обфускация и
PII-риски медиа ([ADR-036](./adr-036-llm-gateway.md)), права и размеры в конфиге
([ADR-023](./adr-023-configuration.md)), статистика промпта ([ADR-070](./adr-070-system-prompt-composer.md)).

## Статус реализации в коде

**Не реализовано, кода нет.** Проверено grep по `packages/**` (исключая `dist/`/`node_modules/`):

- `PartType = 'text' | 'tool_use' | 'tool_result' | 'reasoning' | 'session_reference'`
  (`packages/shared/src/types/index.ts:40`) — нет `image`/`audio`/`video`/`file`.
- Заготовка статистики: `PromptHistoryInfo.attachments` (`packages/shared/src/types/index.ts:230`) считает
  нетекстовые части (`packages/core/src/engine/orchestrator.ts:2125–2192`, тест
  `orchestrator-prompt-state.test.ts:345`), но самих медиа-частей нет.
- `buildContentFromParts` (`packages/shared/src/utils/index.ts:136`) и `ChatOrchestrator._sessionMessagesToLlm`
  (`packages/core/src/engine/orchestrator.ts:4370`) работают с текстом; провайдеры (`providers/openai.ts`,
  `providers/anthropic.ts`) — text/tool_use.
- `KNOWN_MODEL_WINDOWS` (`packages/shared/src/model-metadata.ts`) хранит только контекстное окно, без модальностей.
- Upload/FormData в API **частично есть**, но для файлов рабочего каталога, а не для вложений сообщений:
  `POST /fs/upload` (multipart, `packages/core/src/server/routes/fs.ts:436`) и hybrid-перенос
  (`packages/core/src/remote/transfer.ts:380`). Upload-потока вложений в сообщении нет.
- В UI-композере — неактивная кнопка вложения (`icon="attachment-2"`, `packages/ui/src/components/chat/ChatInput.tsx:452`),
  потока загрузки нет. Токен `fileAttachment` из архивной темы (ADR-019) в `packages/` **не найден** —
  утверждение черновика требует перепроверки.
- FileStore — JSON + атомарная запись ([ADR-005](./adr-005-json-storage.md)); бинарный слой/артефакты не заведены.

## Открытые вопросы

- Где хранить бинарные вложения: каталог `dataDir`/FileStore vs S3 ([ADR-077](./adr-077-runtime-toolchain.md)) vs БД ([ADR-097](./adr-097-storage-provider-class.md))?
- Транскрипция: локально (whisper.cpp) vs провайдер (API) — приватность/зависимости?
- Видео: полноценный ввод (native video, Gemini) vs извлечение кадров+аудио?
- Конвертация/сжатие — на клиенте или на сервере?
- Лимиты по размеру/токенам/стоимости и как их показывать пользователю?
- Мультимодальность в сабагентах и гибриде (передача вложений между инстансами, [ADR-042](./adr-042-hybrid-mode.md))?
- Как вписывается в `_sessionMessagesToLlm` и prompt-cache ([ADR-070](./adr-070-system-prompt-composer.md))?

## Связи

- [ADR-005](./adr-005-json-storage.md) «JSON-хранилище» — базовое хранение вложений; [ADR-097](./adr-097-storage-provider-class.md)/[ADR-077](./adr-077-runtime-toolchain.md) — целевое blob/S3-хранилище.
- [ADR-070](./adr-070-system-prompt-composer.md) «SystemPromptComposer» — промпт, статистика и prompt-cache медиа.
- [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md) «Мобильный UI/PWA» — камера и микрофон как источники ввода.
- [ADR-087](./adr-087-gateways.md) «Gateway мессенджеров» — вложения из чатов; [ADR-089](./adr-089-external-events-automation.md) «Внешние события/автоматизация» — вложения из событий.
- [ADR-086](./adr-086-extensibility-plugins-editions.md) «Расширяемость/плагины» — точка расширения обработчиков и провайдеров медиа.
- [PROP-047](./prop-047-memory-gbrain.md) «Память (Gbrain)» — RAG по документам/изображениям.
- [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — guard/обфускация/PII в медиа; [ADR-023](./adr-023-configuration.md) «Конфигурация» — лимиты и флаги.
