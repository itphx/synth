# AD-019: React 19 SPA с нуля (без форка OpenChamber)

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md (исторический AD-019 переписан под as-built)

**Решение:** пользовательский UI — собственный React 19 SPA `packages/ui` (`@itphx/synth-ui`), написанный с нуля. OpenChamber UI использовался как референс-архитектура и донор UI-примитивов (MIT), но не как форк. Flask+htmx-UI прототипа заморожен (`synth-legacy-ui`), форк `synth-frontend` отброшен.

**Контекст:** исторический AD-019 (`archive/AGENTS_OLD.md`). Форк synth-frontend содержал ~232k строк, из которых ~90% — мёртвый OpenCode-код (Git/Desktop/Terminal/Passkeys/Worktrees); `SyncProvider` был заглушен, 122 импорта `@opencode-ai/sdk` вели в пустоту. Адаптация форка признана тупиком. Чистый проект даёт контролируемый размер кодовой базы, отсутствие мёртвого кода, простую интеграцию с собственным API (AD-017) и путь к Tauri/Electron. Исторический AD-006 (Flask + htmx) при этом деprecated.

**Стек (as-built):**

| Слой | Выбор |
|---|---|
| Ядро | React `^19.2`, React DOM `^19.2`, TypeScript, Vite (`@vitejs/plugin-react`) |
| Стили | Tailwind CSS v4 (`@tailwindcss/vite`), OKLCH-темы |
| Состояние | Zustand `^5` |
| UI-примитивы | Base UI (`@base-ui/react`), Radix UI (collapsible/dialog/dropdown/popover/select/…) |
| Редактор / diff | CodeMirror, `@pierre/diffs` |
| Markdown | `marked` + `dompurify`, KaTeX |
| Виртуальный скролл | `@tanstack/react-virtual` |
| Drag&drop | `@dnd-kit` |
| Анимации / toast | `motion`, `react-toastify` |

**Что построено сами (не форк):**

| Область | Расположение |
|---|---|
| Zustand-сторы (проекты, сессии, чат, auth) | `packages/ui/src/stores/` |
| Транспорт событий (TransportClient, WS + SSE fallback) | `packages/ui/src/lib/` (AD-024) |
| Chat-компоненты (контейнер, инпут, сообщение, список) | `packages/ui/src/components/` |
| Layout (Header, панели, правая панель, адаптив/PWA) | `packages/ui/src/components/layout/` (AD-044) |
| API-клиент | `packages/ui/src/lib/api/synthApi.ts` |
| i18n | `packages/ui/src/lib/i18n/` (ru/en) |

**Связь:** AD-017 (собственный API-контракт), AD-024 (транспорт), AD-044 (адаптивный мобильный UI + PWA).
