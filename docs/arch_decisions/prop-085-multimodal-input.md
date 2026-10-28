# PROP-085: Мультимодальный ввод (звук, изображения, видео)

> ⚠️ **Принято как [ADR-115](./adr-115-multimodal-input.md) (2026-10-27).** Файл оставлен как история: правило каталога — файлы не удаляются (см. [ARCH_DECISIONS.md](../ARCH_DECISIONS.md) §4 «Канонические статусы»).

> **Статус:** ✅ Принято (ADR-115) — Мультимодальный ввод (звук/изображения/видео): типы `Part`, blob-подложка на томе, предобработка, UI-композер
> **Дата:** 2026-10-01
> **Источник:** перенесено из `AD-DRAFTS.md` (D27).
> **Связано:** [ADR-005](./adr-005-json-storage.md), [ADR-096](./adr-096-storage-layer.md),
> [ADR-097](./adr-097-storage-provider-class.md), [ADR-098](./adr-098-storage-degraded-recovery.md),
> [PROP-106](./prop-106-file-ports-to-sql.md), [ADR-077](./adr-077-runtime-toolchain.md),
> [ADR-070](./adr-070-system-prompt-composer.md), [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md),
> [ADR-087](./adr-087-gateways.md), [ADR-089](./adr-089-external-events-automation.md),
> [ADR-086](./adr-086-extensibility-plugins-editions.md), [PROP-047](./prop-047-memory-gbrain.md),
> [ADR-036](./adr-036-llm-gateway.md), [ADR-023](./adr-023-configuration.md).

**Решение:** расширить модель контента сообщения с текстовой на **мультимодальную**: новые типы `Part`
(`image`/`audio`/`video`/`file`) со ссылкой на blob/артефакт + метаданными; загрузка и хранение вложений
(байты — на томе через порт `BlobStore`, в БД — только `blob_refs`; см. «Хранение вложений»);
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
Маппинг/сериализация — через `buildContentFromParts` (`packages/shared/src/utils/index.ts`) и
`sessionMessagesToLlm` (`packages/core/src/engine/orchestrator/prompt-info.ts`); при этом новая часть
обязана давать в `content` текстовый плейсхолдер, иначе вложение теряется в производных строковых полях
(экспорт, легаси-сообщения, PG-маппинг).

### Хранение вложений (решение 2026-10-27)

Байты — **всегда на томе**, через доменный порт `BlobStore` (`storage/ports/blob-store.ts`, файловая
реализация `FileBlobStore`), content-addressed по `sha256` (`attachments/<sha2>/<sha256>`). В БД байты
**не** пишутся: это write-once неизменяемые объекты, а `bytea` тянет WAL/TOAST/`pg_dump` и сделал бы
бэкап БД обязательным условием сохранности вложений.

- **Том.** По умолчанию один том (`{dataDir}`), блобы — в `{dataDir}/blobs`. Отдельный блоб-том — опция
  чарта. При `backend.replicaCount > 1` том с блобами обязан быть `ReadWriteMany` — это ограничение
  деплоя, а не кода.
- **Учёт ссылок.** В БД — `blob_refs` (`blob_path`, `owner_kind`, `owner_id`): дедуп по содержимому и
  детерминированный GC (объект живёт, пока на него есть ссылки).
- **Раздача.** Через API с проверкой доступа к сессии/проекту: `Content-Type`, `Content-Length`,
  `ETag = sha256`, `Cache-Control: private`; большие файлы — потоком (`Range`).
- **Второй миграции не будет:** порт и место метаданных финальны, байты при смене тома не переезжают.

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

**Не реализовано** (проверено по `packages/**` на 2026-10-27):

- `PartType = 'text' | 'tool_use' | 'tool_result' | 'reasoning' | 'session_reference'`
  (`packages/shared/src/types/message.ts:19`) — нет `image`/`audio`/`video`/`file`.
- `buildContentFromParts` (`packages/shared/src/utils/index.ts:194`) — текстовая проекция; неизвестный
  тип части молча даёт `''`, поэтому медиа-части обязаны получить явную ветку-плейсхолдер.
- `LLMMessage.content: string` (`packages/core/src/providers/base.ts:151-154`); провайдеры собирают
  текстовый контент (`packages/core/src/providers/openai.ts:369`,
  `packages/core/src/providers/anthropic.ts:443-467`).
- Заготовка статистики уже есть: `PromptHistoryInfo.attachments`
  (`packages/shared/src/types/prompt.ts:214`) считает нетекстовые части
  (`packages/core/src/engine/orchestrator/prompt-info.ts:230-243`).
- `KNOWN_MODEL_WINDOWS` (`packages/shared/src/model-metadata.ts`) хранит только контекстное окно, без
  модальностей модели.
- Blob-подложка есть и работает (логи фоновых процессов): порт `BlobStore`
  (`packages/core/src/storage/ports/blob-store.ts`), `FileBlobStore`
  (`packages/core/src/storage/file-blob-store.ts`), логи — `processes/<runId>.log`
  (`packages/core/src/engine/background/service.ts:44-48`). Учёта ссылок (`blob_refs`) нет.
- `messages.parts` в PostgreSQL — `jsonb` (`packages/storage-postgres/src/migrations/001-init.ts:82`),
  поэтому новые виды частей схемы БД не требуют.
- Upload/FormData в API есть только для файлов рабочего каталога: `POST /fs/upload`
  (`packages/core/src/server/routes/fs.ts`, лимит `DEFAULT_MAX_UPLOAD_BYTES` = 100 МиБ); потока
  вложений сообщения нет.
- В UI-композере — неактивная кнопка вложения (`packages/ui/src/components/chat/ChatInput.tsx:496`),
  потока загрузки нет; токен `fileAttachment` из архивной темы (ADR-019) в `packages/` не найден.

## Открытые вопросы

Хранение — **решено** 2026-10-27 (см. «Хранение вложений»): байты на томе через `BlobStore`, в БД только
`blob_refs`. Остальные вопросы открыты:

- Транскрипция: локально (whisper.cpp) vs провайдер (API) — приватность/зависимости?
- Видео: полноценный ввод (native video, Gemini) vs извлечение кадров+аудио?
- Конвертация/сжатие — на клиенте или на сервере?
- Лимиты по размеру/токенам/стоимости и как их показывать пользователю?
- Мультимодальность в сабагентах и гибриде (передача вложений между инстансами, [ADR-042](./adr-042-hybrid-mode.md))?
- Как вписывается в `sessionMessagesToLlm` (`engine/orchestrator/prompt-info.ts`) и prompt-cache ([ADR-070](./adr-070-system-prompt-composer.md))?

## Связи

- [ADR-005](./adr-005-json-storage.md) «JSON-хранилище» и [ADR-096](./adr-096-storage-layer.md) «слой хранения» — порты и файловые реализации; [ADR-097](./adr-097-storage-provider-class.md) — выбор backend'а хранения (на вложения не распространяется: байты остаются на томе).
- [ADR-070](./adr-070-system-prompt-composer.md) «SystemPromptComposer» — промпт, статистика и prompt-cache медиа.
- [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md) «Мобильный UI/PWA» — камера и микрофон как источники ввода.
- [ADR-087](./adr-087-gateways.md) «Gateway мессенджеров» — вложения из чатов; [ADR-089](./adr-089-external-events-automation.md) «Внешние события/автоматизация» — вложения из событий.
- [ADR-086](./adr-086-extensibility-plugins-editions.md) «Расширяемость/плагины» — точка расширения обработчиков и провайдеров медиа.
- [PROP-047](./prop-047-memory-gbrain.md) «Память (Gbrain)» — RAG по документам/изображениям.
- [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — guard/обфускация/PII в медиа; [ADR-023](./adr-023-configuration.md) «Конфигурация» — лимиты и флаги.

## История

- 2026-10-27 — зафиксировано хранение вложений: байты на томе через порт `BlobStore` (content-addressed),
  в БД только `blob_refs` для дедупа и GC; том один по умолчанию, отдельный блоб-том — опция,
  `ReadWriteMany` обязателен при `replicaCount > 1`. Обновлён статус реализации (актуальные файлы/строки),
  из открытых вопросов снят вопрос «где хранить вложения».
