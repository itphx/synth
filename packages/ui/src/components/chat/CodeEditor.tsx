import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { EditorView as EditorViewType } from '@codemirror/view'
import type { LanguageSupport } from '@codemirror/language'

/**
 * Просмотрщик/редактор кода на CodeMirror 6 — **ленивый**.
 *
 * Ни одного статического импорта `@codemirror/*`/`@lezer/*` в модуле нет:
 * пакеты подключаются динамическим `import()` внутри эффекта, поэтому в
 * главный чанк попадает только этот компонент (он сам лежит в чанке
 * вкладки). Грамматики языков (`@codemirror/language-data` → `lang-*`)
 * грузятся отдельными чанками при первом файле соответствующего расширения.
 *
 * Тема — из CSS-переменных Synth (`--foreground`, `--primary`, `--status-*`,
 * `--muted-foreground`): hex-литералов нет, поэтому светлая/тёмная схема и
 * кастомные палитры работают без пересборки редактора (значения `var(...)`
 * резолвит сам браузер).
 */

export interface CodeEditorProps {
  value: string
  /** Путь файла — по расширению выбирается язык (`LanguageDescription.matchFilename`). */
  filePath: string
  readOnly?: boolean
  onChange?: (value: string) => void
  className?: string
  testId?: string
}

/** Модули CodeMirror, загруженные один раз на приложение. */
interface CodeMirrorModules {
  EditorState: typeof import('@codemirror/state').EditorState
  Compartment: typeof import('@codemirror/state').Compartment
  EditorView: typeof import('@codemirror/view').EditorView
  keymap: typeof import('@codemirror/view').keymap
  lineNumbers: typeof import('@codemirror/view').lineNumbers
  drawSelection: typeof import('@codemirror/view').drawSelection
  highlightActiveLine: typeof import('@codemirror/view').highlightActiveLine
  highlightActiveLineGutter: typeof import('@codemirror/view').highlightActiveLineGutter
  bracketMatching: typeof import('@codemirror/language').bracketMatching
  syntaxHighlighting: typeof import('@codemirror/language').syntaxHighlighting
  HighlightStyle: typeof import('@codemirror/language').HighlightStyle
  history: typeof import('@codemirror/commands').history
  defaultKeymap: typeof import('@codemirror/commands').defaultKeymap
  historyKeymap: typeof import('@codemirror/commands').historyKeymap
  indentWithTab: typeof import('@codemirror/commands').indentWithTab
  languages: typeof import('@codemirror/language-data').languages
  LanguageDescription: typeof import('@codemirror/language').LanguageDescription
  /** Собственная тема Synth из CSS-переменных. */
  theme: import('@codemirror/state').Extension
  /** Собственный `HighlightStyle` из CSS-переменных. */
  highlightStyle: import('@codemirror/language').HighlightStyle
}

/** Промис модулей CodeMirror: StrictMode-двойное монтирование его переживает. */
let modulesPromise: Promise<CodeMirrorModules> | null = null

/** Кэш загрузки грамматик по имени языка (`desc.name`) — один на приложение. */
const languageCache = new Map<string, Promise<LanguageSupport | null>>()

/** Тема редактора: фон прозрачный, цвета — только токены Synth. */
function buildTheme(EditorView: typeof import('@codemirror/view').EditorView) {
  return EditorView.theme({
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--foreground)',
      height: '100%',
      fontSize: '0.8125rem',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
      lineHeight: '1.55',
    },
    '.cm-content': { caretColor: 'var(--primary)', padding: '0.75rem 0' },
    '.cm-line': { padding: '0 0.75rem' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--muted-foreground)',
      border: 'none',
      paddingLeft: '0.25rem',
    },
    '.cm-lineNumbers .cm-gutterElement': { minWidth: '2.5rem' },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--foreground)',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'color-mix(in oklab, var(--primary) 28%, transparent)',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'color-mix(in oklab, var(--primary) 15%, transparent)',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--primary)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'color-mix(in oklab, var(--primary) 20%, transparent)',
      outline: '1px solid color-mix(in oklab, var(--primary) 45%, transparent)',
    },
  })
}

/** Подсветка синтаксиса: семантические цвета — токены темы. */
function buildHighlightStyle(
  HighlightStyle: typeof import('@codemirror/language').HighlightStyle,
  tags: typeof import('@lezer/highlight').tags,
) {
  return HighlightStyle.define([
    { tag: tags.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
    {
      tag: [
        tags.keyword,
        tags.modifier,
        tags.controlKeyword,
        tags.definitionKeyword,
        tags.moduleKeyword,
        tags.operatorKeyword,
      ],
      color: 'var(--primary)',
    },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--status-success)' },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--status-info)' },
    {
      tag: [tags.typeName, tags.className, tags.namespace, tags.tagName],
      color: 'var(--status-warning)',
    },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName],
      color: 'var(--status-caution)',
    },
    { tag: [tags.variableName, tags.propertyName], color: 'var(--foreground)' },
    { tag: [tags.heading, tags.strong], color: 'var(--foreground)', fontWeight: '600' },
    { tag: [tags.link, tags.url], color: 'var(--status-info)' },
    { tag: tags.invalid, color: 'var(--status-error)' },
  ])
}

/** Загрузка модулей CodeMirror (один промис на приложение, ошибка не «залипает»). */
function loadModules(): Promise<CodeMirrorModules> {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      const [state, view, language, commands, languageData, highlight] = await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/language'),
        import('@codemirror/commands'),
        import('@codemirror/language-data'),
        import('@lezer/highlight'),
      ])
      return {
        EditorState: state.EditorState,
        Compartment: state.Compartment,
        EditorView: view.EditorView,
        keymap: view.keymap,
        lineNumbers: view.lineNumbers,
        drawSelection: view.drawSelection,
        highlightActiveLine: view.highlightActiveLine,
        highlightActiveLineGutter: view.highlightActiveLineGutter,
        bracketMatching: language.bracketMatching,
        syntaxHighlighting: language.syntaxHighlighting,
        HighlightStyle: language.HighlightStyle,
        history: commands.history,
        defaultKeymap: commands.defaultKeymap,
        historyKeymap: commands.historyKeymap,
        indentWithTab: commands.indentWithTab,
        languages: languageData.languages,
        LanguageDescription: language.LanguageDescription,
        theme: buildTheme(view.EditorView),
        highlightStyle: buildHighlightStyle(language.HighlightStyle, highlight.tags),
      } satisfies CodeMirrorModules
    })()
    modulesPromise.catch(() => {
      modulesPromise = null
    })
  }
  return modulesPromise
}

/**
 * Язык по имени файла: `LanguageDescription.matchFilename` + ленивый `load()`.
 * Неизвестное расширение — `null` (файл открывается как обычный текст).
 */
async function loadLanguageForPath(filePath: string): Promise<LanguageSupport | null> {
  const modules = await loadModules()
  const description = modules.LanguageDescription.matchFilename(modules.languages, filePath)
  if (!description) return null
  const cached = languageCache.get(description.name)
  if (cached) return cached
  const pending = description.load().catch(() => null)
  languageCache.set(description.name, pending)
  return pending
}

/**
 * Редактор кода на CodeMirror 6 (ленивый чанк).
 *
 * `value` — управляемое значение; правки уходят через `onChange` (эхо
 * собственного изменения не применяется повторно — `lastEmitted`).
 */
export function CodeEditor({
  value,
  filePath,
  readOnly = false,
  onChange,
  className,
  testId,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorViewType | null>(null)
  /** Последнее значение, отправленное наружу через `onChange`. */
  const lastEmitted = useRef<string | null>(null)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  valueRef.current = value
  onChangeRef.current = onChange
  // CodeMirror не загрузился (сеть/чанк) — показываем текст без подсветки.
  const [failed, setFailed] = useState(false)

  // Создание view: язык и разметка зависят от пути/режима, не от содержимого.
  useEffect(() => {
    let cancelled = false
    let view: EditorViewType | null = null
    let compartment: import('@codemirror/state').Compartment | null = null

    setFailed(false)

    loadModules()
      .then((modules) => {
        if (cancelled || !hostRef.current) return
        const {
          EditorState,
          Compartment,
          EditorView,
          keymap,
          lineNumbers,
          drawSelection,
          highlightActiveLine,
          highlightActiveLineGutter,
          bracketMatching,
          syntaxHighlighting,
          history,
          defaultKeymap,
          historyKeymap,
          indentWithTab,
          theme,
          highlightStyle,
        } = modules

        compartment = new Compartment()
        const extensions: import('@codemirror/state').Extension[] = [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          bracketMatching(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...(readOnly ? [] : [indentWithTab]),
          ]),
          syntaxHighlighting(highlightStyle),
          theme,
          compartment.of([]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const next = update.state.doc.toString()
            // Своё изменение не должно вернуться в документ как внешнее.
            lastEmitted.current = next
            onChangeRef.current?.(next)
          }),
        ]
        if (readOnly) {
          extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false))
        } else {
          extensions.push(highlightActiveLine())
        }

        view = new EditorView({
          state: EditorState.create({ doc: valueRef.current, extensions }),
          parent: hostRef.current,
        })
        viewRef.current = view

        const currentView = view
        const currentCompartment = compartment
        void loadLanguageForPath(filePath)
          .then((support) => {
            if (cancelled || !currentView) return
            currentView.dispatch({
              effects: currentCompartment.reconfigure(support ?? []),
            })
          })
          .catch(() => {
            // Неизвестный/сломанный язык — остаётся обычный текст.
          })
      })
      .catch((error) => {
        console.debug('[CodeEditor] CodeMirror failed to load:', error)
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
      view?.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
    // Значение читается из ref при создании: пересоздавать view на каждый
    // символ нельзя (потеряются курсор, история и выделение).
  }, [filePath, readOnly])

  // Внешнее значение → документ (правки пользователя уже в документе).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) {
      // Эхо собственного `onChange` — применять нечего.
      if (lastEmitted.current === value) lastEmitted.current = null
      return
    }
    if (lastEmitted.current === value) {
      lastEmitted.current = null
      return
    }
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return (
    <div
      ref={hostRef}
      data-testid={testId}
      className={cn('h-full min-h-0 w-full overflow-hidden', className)}
    >
      {failed && (
        <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-sm text-foreground">
          {value}
        </pre>
      )}
    </div>
  )
}
