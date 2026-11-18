import { useCallback, useEffect, useMemo, useState } from 'react'
import { fileKind, type FileKind } from '@itphx/synth-shared/types'
import type { GitRepoWorktreeStatus, GitWorktreeDiff } from '@itphx/synth-shared/types'
import { synthApi } from '@/lib/api/synthApi'
import { buildSandboxedHtmlDocument } from '@/lib/htmlPreview'
import { useI18n } from '@/lib/i18n'
import { resolveRelativePath, splitFilePath } from '@/lib/markdown/relativeAssets'
import { useUIStore } from '@/stores/useUIStore'
import { useGitStore } from '@/stores/gitStore'
import { buildStatusIndex, fileStatus, repoForFile } from '@/lib/gitStatus'
import {
  defaultFileViewMode,
  fileNameOf,
  openFileEditorTab,
  openFileTab,
  parseFileViewMode,
  type FileViewMode,
} from '@/lib/fileTabs'
import { isCodeViewSupported } from '@/lib/codeEditor'
import { cn } from '@/lib/utils'
import { Icon, type IconName } from '../icon/Icon'
import { ImageViewer } from './ImageViewer'
import { MarkdownContent } from './MarkdownContent'
import { DiffView } from './DiffView'
import { CodeEditor } from './CodeEditor'
import type { CenterTab } from '@/stores/useUIStore'

interface FileViewerTabProps {
  tab: CenterTab
}

/** Отказ чтения: файл больше лимита (или бинарный) — `413 FILE_TOO_LARGE`. */
interface ReadTooLarge {
  size: number
  limit: number
  reason: string
}

/** Цель diff: репозиторий файла и путь относительно его корня. */
interface GitDiffTarget {
  repoPath: string
  repoRelativePath: string
  /** Только индекс без правок в рабочем дереве — показываем staged-diff. */
  staged: boolean
}

/** Семейства, которые можно открыть в текстовом редакторе (остальное — просмотр). */
const EDITABLE_FILE_KINDS: readonly FileKind[] = ['markdown', 'text', 'code']

/** Размер файла для сообщения: байты → KiB/MiB. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Признак отказа «файл слишком большой/бинарный» (машинный код сервера). */
function isTooLargeError(
  e: unknown,
): e is { status: number; code: string; details?: Record<string, unknown> } {
  const err = e as { status?: number; code?: string; details?: Record<string, unknown> } | null
  return err?.status === 413 && err?.code === 'FILE_TOO_LARGE'
}

/**
 * Diff-цель файла по снимку статуса: репозиторий (самый длинный подходящий
 * `repo.path`), путь внутри него и признак «только индекс». `ignored` — не
 * цель (diff пуст, кнопка не нужна).
 */
function gitTargetFor(
  repos: GitRepoWorktreeStatus[] | undefined,
  filePath: string,
): GitDiffTarget | null {
  if (!repos) return null
  const resolved = repoForFile(repos, filePath)
  if (!resolved) return null
  const entry = fileStatus(buildStatusIndex(repos), filePath)
  if (entry?.kind === 'ignored') return null
  return {
    ...resolved,
    staged: entry ? entry.staged && !entry.unstaged : false,
  }
}

/** Кнопка панели: слева иконка, подпись; тач-таргет ≥40px при coarse-указателе. */
const TOOL_BUTTON_CLASS =
  'inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted pointer-coarse:min-h-10'

/** Активный режим подсвечивается токенами темы (без hex). */
const TOOL_BUTTON_ACTIVE_CLASS = 'border-primary/50 bg-primary/10 text-foreground'

function ToolButton({
  icon,
  label,
  active,
  pressed,
  onClick,
  testId,
  groupLabel,
}: {
  icon: IconName
  label: string
  active?: boolean
  pressed?: boolean
  onClick?: () => void
  testId?: string
  groupLabel?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed ?? active}
      aria-label={groupLabel}
      title={label}
      data-testid={testId}
      className={cn(TOOL_BUTTON_CLASS, active && TOOL_BUTTON_ACTIVE_CLASS)}
    >
      <Icon name={icon} className="size-3.5 shrink-0" />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  )
}

/**
 * Текстовое содержимое: CodeMirror с номерами строк и подсветкой. Большой
 * файл — прежний `<pre>` с пометкой (CodeMirror на мегабайтах дорог).
 */
function TextViewer({ content, filePath }: { content: string; filePath: string }) {
  const { t } = useI18n()
  if (isCodeViewSupported(content)) {
    return (
      <div className="h-full min-h-0 w-full">
        <CodeEditor readOnly value={content} filePath={filePath} testId="file-code-viewer" />
      </div>
    )
  }
  return (
    <div className="h-full w-full overflow-auto">
      <div
        className="border-b border-border px-4 py-1 text-xs text-muted-foreground"
        data-testid="file-plain-large"
      >
        {t('file.plainLarge')}
      </div>
      <pre className="min-h-full w-full max-w-full whitespace-pre-wrap break-words p-4 text-sm font-mono text-foreground">
        {content}
      </pre>
    </div>
  )
}

export function FileViewerTab({ tab }: FileViewerTabProps) {
  const { t } = useI18n()
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isBinary, setIsBinary] = useState(false)
  const [binarySize, setBinarySize] = useState(0)
  const [tooLarge, setTooLarge] = useState<ReadTooLarge | null>(null)
  // Медиа не удалось показать браузером (битый файл / отвергнутый предпросмотр).
  const [previewFailed, setPreviewFailed] = useState(false)

  // Diff-режим: загрузка `GET /git/diff` для файла (репозиторий — по статусу).
  const [diff, setDiff] = useState<GitWorktreeDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffNonce, setDiffNonce] = useState(0)

  const openTab = useUIStore((s) => s.openTab)
  const updateTabData = useUIStore((s) => s.updateTabData)
  // Ширина чтения markdown: колонка (по центру) или во всю ширину панели.
  const fileViewerWidth = useUIStore((s) => s.fileViewerWidth)
  const setFileViewerWidth = useUIStore((s) => s.setFileViewerWidth)

  const projectId = tab.data.projectId
  const filePath = tab.data.filePath
  const fileName = filePath ? fileNameOf(filePath) : ''
  const kind = filePath ? fileKind(filePath) : 'binary'
  // Медиа отдаётся inline через `/fs/raw`; текст/код/markdown/неизвестное — чтением.
  const isMedia = kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf'
  const isMarkdown = kind === 'markdown'
  const isHtml = kind === 'html'
  const canEditFile = EDITABLE_FILE_KINDS.includes(kind)

  // ADR-076 (этап 1): снимок статуса рабочего дерева. Просмотрщик запрашивает
  // его принудительно один раз на вкладку/файл — иначе «Изменения» появлялись
  // только после перезахода во вкладку (снимок приходил от соседней панели).
  const statusRepos = useGitStore((s) => s.statusByProject[projectId ?? ''])
  const loadGitStatus = useGitStore((s) => s.loadStatus)

  useEffect(() => {
    if (!projectId) return
    void loadGitStatus(projectId, { force: true })
  }, [projectId, filePath, loadGitStatus])

  const gitTarget = useMemo(
    () => (filePath ? gitTargetFor(statusRepos, filePath) : null),
    [statusRepos, filePath],
  )

  // Режимы: превью — только разметка; исходник — любой читаемый текст;
  // «Изменения» — файл в зарегистрированном репозитории и не `ignored`.
  // Пока снимка статуса нет — кнопку не прячем (иначе она «мигает»).
  const canShowText = !isMedia && !isBinary
  const showPreviewMode = canShowText && (isMarkdown || isHtml)
  const showSourceMode = canShowText
  const showDiffMode = Boolean(projectId && filePath) && (statusRepos === undefined || gitTarget !== null)

  const requestedMode = parseFileViewMode(tab.data.viewMode)
  const fallbackMode = defaultFileViewMode(kind)
  const viewMode: FileViewMode = (() => {
    if (!requestedMode) return fallbackMode
    if (requestedMode === 'preview' && !showPreviewMode) {
      return showSourceMode ? 'source' : fallbackMode
    }
    if (requestedMode === 'source' && !showSourceMode) {
      return showPreviewMode ? 'preview' : fallbackMode
    }
    return requestedMode
  })()

  const setViewMode = useCallback(
    (mode: FileViewMode) => {
      if (tab.data.viewMode === mode) return
      updateTabData(tab.id, { viewMode: mode })
      // Снимка нет — «Изменения» всё равно работают: догружаем статус,
      // diff-цель появится и запрос уйдёт сам.
      if (mode === 'diff' && projectId && !gitTarget) {
        void loadGitStatus(projectId, { force: true })
      }
    },
    [tab.id, tab.data.viewMode, updateTabData, projectId, gitTarget, loadGitStatus],
  )

  // Diff файла: репозиторий/путь — из снимка статуса, `staged` — только индекс.
  useEffect(() => {
    if (viewMode !== 'diff' || !projectId) return
    if (!gitTarget) {
      setDiff(null)
      setDiffError(null)
      setDiffLoading(false)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    setDiffError(null)
    synthApi
      .getGitDiff(projectId, gitTarget.repoPath, {
        path: gitTarget.repoRelativePath,
        staged: gitTarget.staged,
      })
      .then((result) => {
        if (cancelled) return
        setDiff(result)
        setDiffLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setDiffError((e as Error).message)
        setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    viewMode,
    projectId,
    gitTarget?.repoPath,
    gitTarget?.repoRelativePath,
    gitTarget?.staged,
    diffNonce,
  ])

  // Относительные `src`/`href` внутри `.md` резолвятся от каталога документа
  // в workspace (ведущий `/` — корень workspace, выход выше корня — `null`).
  const assetDir = useMemo(() => (filePath ? splitFilePath(filePath).dir : ''), [filePath])
  // Документ для `srcDoc` собирается один раз на содержимое: файл читается до
  // 5 МиБ, конкатенацию на каждый рендер не делаем.
  const sandboxedHtml = useMemo(
    () => (content === null ? '' : buildSandboxedHtmlDocument(content)),
    [content],
  )
  const resolveAsset = useCallback(
    (target: string): string | null => {
      if (!projectId) return null
      const resolved = resolveRelativePath(assetDir, target)
      return resolved ? synthApi.rawFileUrl(projectId, resolved) : null
    },
    [assetDir, projectId],
  )
  // Ссылка на файл проекта (`data-file-path` из markdown) открывает вкладку —
  // как клик по файлу в дереве. Параметры `href="#"` — чтобы остаться в SPA.
  const handleMarkdownClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const link = target.closest<HTMLAnchorElement>('a[data-file-path]')
      if (!link) return
      event.preventDefault()
      const assetPath = link.getAttribute('data-file-path')
      if (!assetPath || !projectId) return
      // В атрибуте — путь из markdown (как в нём написан): резолвим от каталога
      // документа; выход выше корня workspace даёт `null` — тихий no-op.
      const path = resolveRelativePath(assetDir, assetPath)
      if (!path) return
      openFileTab(openTab, { projectId, filePath: path })
    },
    [assetDir, openTab, projectId],
  )

  const handleEdit = useCallback(() => {
    if (!projectId || !filePath) return
    openFileEditorTab(openTab, { projectId, filePath })
  }, [openTab, projectId, filePath])

  useEffect(() => {
    setContent(null)
    setIsBinary(false)
    setBinarySize(0)
    setTooLarge(null)
    setPreviewFailed(false)
    setError(null)

    if (!projectId || !filePath) {
      setLoading(false)
      setError(t('file.loadError'))
      return
    }

    let cancelled = false
    setLoading(true)

    if (isMedia) {
      // Предпросмотр может быть отвергнут до загрузки байтов: 413 по
      // `storage.maxPreviewBytes`, 404/403. Показываем причину и «Скачать».
      synthApi
        .probeRawFile(projectId, filePath)
        .then((probe) => {
          if (cancelled) return
          if (!probe.ok && probe.status !== 0) {
            if (probe.status === 413 && probe.reason === 'preview_size') {
              setTooLarge({ size: probe.size, limit: probe.limit ?? 0, reason: 'preview_size' })
            } else {
              setError(probe.message || t('file.previewFailed'))
            }
          }
          setLoading(false)
        })
        .catch(() => {
          // Проверка недоступна — пробуем показать элемент; его собственная
          // ошибка (`onError`) переведёт экран в «не удалось показать».
          if (!cancelled) setLoading(false)
        })
      return () => {
        cancelled = true
      }
    }

    synthApi
      .readFile(projectId, filePath)
      .then((result) => {
        if (cancelled) return
        if (result.encoding === 'binary') {
          setIsBinary(true)
          setBinarySize(result.size)
          setContent(null)
        } else {
          setIsBinary(false)
          setContent(result.content)
        }
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        if (isTooLargeError(e)) {
          // Файл больше лимита чтения (или бинарный) — понятное сообщение
          // вместо пустого экрана.
          setTooLarge({
            size: Number(e.details?.size ?? 0),
            limit: Number(e.details?.maxReadBytes ?? e.details?.maxPreviewBytes ?? 0),
            reason: String(e.details?.reason ?? 'size'),
          })
        } else {
          setError((e as Error).message)
        }
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, filePath, isMedia, t])

  /** Панель: слева — режимы и действия (все с иконками), справа — подсказки. */
  const toolbar = (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1"
      data-testid="file-toolbar"
    >
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('file.viewModeGroupAria')}>
        {showPreviewMode && (
          <ToolButton
            icon="eye"
            label={t('file.viewMode.preview')}
            active={viewMode === 'preview'}
            onClick={() => setViewMode('preview')}
            testId="file-view-mode-preview"
          />
        )}
        {showSourceMode && (
          <ToolButton
            icon="code-s-slash"
            label={t('file.viewMode.source')}
            active={viewMode === 'source'}
            onClick={() => setViewMode('source')}
            testId="file-view-mode-source"
          />
        )}
        {showDiffMode && (
          <ToolButton
            icon="arrow-left-right"
            label={t('file.viewMode.diff')}
            active={viewMode === 'diff'}
            onClick={() => setViewMode('diff')}
            testId="file-view-mode-diff"
          />
        )}

        {viewMode === 'diff' && diff && (diff.additions !== undefined || diff.deletions !== undefined) && (
          <span className="flex items-center gap-2 px-1 text-[0.6875rem] font-mono" data-testid="file-diff-stats">
            <span className="text-status-success">+{diff.additions ?? 0}</span>
            <span className="text-status-error">−{diff.deletions ?? 0}</span>
          </span>
        )}
        {viewMode === 'diff' && diff?.binary && (
          <span
            className="rounded border border-sidebar-border px-1 text-[0.625rem] uppercase tracking-wide text-muted-foreground"
            data-testid="file-diff-binary"
          >
            {t('diff.binary')}
          </span>
        )}
        {viewMode === 'diff' && (
          <button
            type="button"
            onClick={() => setDiffNonce((n) => n + 1)}
            data-testid="file-diff-refresh"
            className={TOOL_BUTTON_CLASS}
            title={t('file.diffRefresh')}
          >
            <Icon
              name={diffLoading ? 'loader-2' : 'refresh'}
              className={cn('size-3.5 shrink-0', diffLoading && 'animate-spin')}
            />
            <span className="whitespace-nowrap">{t('file.diffRefresh')}</span>
          </button>
        )}

        {canEditFile && (
          <button
            type="button"
            onClick={handleEdit}
            data-testid="file-edit"
            title={t('file.edit')}
            className={TOOL_BUTTON_CLASS}
          >
            <Icon name="edit-2" className="size-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t('file.edit')}</span>
          </button>
        )}
        {projectId && filePath && (
          <a
            href={synthApi.downloadFile(projectId, filePath)}
            download={fileName}
            data-testid="file-download"
            title={t('file.download')}
            className={TOOL_BUTTON_CLASS}
          >
            <Icon name="download" className="size-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t('file.download')}</span>
          </a>
        )}
        {isMarkdown && content !== null && viewMode !== 'diff' && (
          <div
            role="group"
            aria-label={t('file.widthToggleAria')}
            className="flex items-center gap-1"
          >
            <button
              type="button"
              onClick={() => setFileViewerWidth('column')}
              aria-pressed={fileViewerWidth === 'column'}
              aria-label={t('file.widthColumn')}
              title={t('file.widthColumn')}
              data-testid="file-width-column"
              className={cn(
                TOOL_BUTTON_CLASS,
                fileViewerWidth === 'column' && TOOL_BUTTON_ACTIVE_CLASS,
              )}
            >
              <Icon name="layout-left" className="size-3.5 shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => setFileViewerWidth('full')}
              aria-pressed={fileViewerWidth === 'full'}
              aria-label={t('file.widthFull')}
              title={t('file.widthFull')}
              data-testid="file-width-full"
              className={cn(
                TOOL_BUTTON_CLASS,
                fileViewerWidth === 'full' && TOOL_BUTTON_ACTIVE_CLASS,
              )}
            >
              <Icon name="layout-right" className="size-3.5 shrink-0" />
            </button>
          </div>
        )}
      </div>

      {/* Правый край — только подсказки, не действия. */}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {isHtml && viewMode !== 'source' && (
          <span className="px-2 text-xs text-muted-foreground">{t('file.htmlSandboxed')}</span>
        )}
        {isMedia && projectId && filePath && (
          <a
            href={synthApi.rawFileUrl(projectId, filePath)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {t('file.openInNewTab')}
          </a>
        )}
      </div>
    </div>
  )

  const rootClass =
    'flex flex-1 h-full w-full min-w-0 flex-col overflow-hidden bg-background'

  const centered = (children: React.ReactNode) => (
    <div className="flex flex-1 items-center justify-center">{children}</div>
  )

  const loadingScreen = centered(
    <div className="flex flex-col items-center gap-3 text-muted-foreground">
      <Icon name="loader-2" className="size-8 animate-spin" />
      <span className="text-sm">{t('common.loading')}...</span>
    </div>,
  )

  // Режим «Изменения» не зависит от чтения содержимого файла: diff приходит
  // с сервера, поэтому он рисуется даже для бинарного/слишком большого файла.
  if (viewMode === 'diff') {
    let diffBody: React.ReactNode
    if (!gitTarget) {
      if (statusRepos === undefined) {
        diffBody = loadingScreen
      } else {
        diffBody = centered(
          <div className="flex flex-col items-center gap-3 px-4 text-center text-sm text-muted-foreground">
            <Icon name="arrow-left-right" className="size-8" />
            <span data-testid="file-diff-empty">{t('git.changes.emptyDiff')}</span>
          </div>,
        )
      }
    } else if (diffLoading && !diff) {
      diffBody = loadingScreen
    } else if (diffError) {
      diffBody = centered(
        <div className="flex max-w-md flex-col items-center gap-3 px-4 text-center text-muted-foreground">
          <Icon name="alert-triangle" className="size-8 text-status-error" />
          <span className="text-sm" data-testid="file-diff-error">
            {t('file.diffError')}
          </span>
          <span className="text-xs opacity-70">{diffError}</span>
          <button
            type="button"
            onClick={() => setDiffNonce((n) => n + 1)}
            data-testid="file-diff-retry"
            className={TOOL_BUTTON_CLASS}
          >
            <Icon name="refresh" className="size-3.5 shrink-0" />
            <span>{t('file.diffRetry')}</span>
          </button>
        </div>,
      )
    } else if (diff) {
      diffBody = (
        <div className="min-h-0 flex-1 overflow-auto">
          <DiffView
            diff={diff.diff}
            variant="page"
            truncated={diff.diff_truncated}
            emptyText={t('git.changes.emptyDiff')}
            testId="file-diff-content"
            truncatedTestId="file-diff-truncated"
          />
        </div>
      )
    } else {
      diffBody = centered(
        <span className="text-sm text-muted-foreground" data-testid="file-diff-empty">
          {t('git.changes.emptyDiff')}
        </span>,
      )
    }

    return (
      <div className={rootClass} data-testid="file-viewer-root">
        {toolbar}
        {diffBody}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Icon name="loader-2" className="size-8 animate-spin" />
          <span className="text-sm">{t('common.loading')}...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={rootClass} data-testid="file-viewer-root">
        {toolbar}
        {centered(
          <div className="flex max-w-md flex-col items-center gap-3 px-4 text-center text-muted-foreground">
            <Icon name="alert-triangle" className="size-8 text-status-error" />
            <span className="text-sm">{error}</span>
          </div>,
        )}
      </div>
    )
  }

  if (tooLarge) {
    const isBinaryReason = tooLarge.reason === 'binary'
    const isPreviewSize = tooLarge.reason === 'preview_size'
    return (
      <div className={rootClass} data-testid="file-viewer-root">
        {toolbar}
        {centered(
          <div className="flex max-w-md flex-col items-center gap-3 px-4 text-center text-muted-foreground">
            <Icon name="file-3" className="size-12" />
            <span className="text-sm" data-testid="file-too-large">
              {isBinaryReason
                ? t('file.binaryNotReadable')
                : isPreviewSize
                  ? t('file.previewTooLarge', {
                      size: formatSize(tooLarge.size),
                      limit: formatSize(tooLarge.limit),
                    })
                  : t('file.tooLarge', {
                      size: formatSize(tooLarge.size),
                      limit: formatSize(tooLarge.limit),
                    })}
            </span>
          </div>,
        )}
      </div>
    )
  }

  if (previewFailed) {
    return (
      <div className={rootClass} data-testid="file-viewer-root">
        {toolbar}
        {centered(
          <div className="flex max-w-md flex-col items-center gap-3 px-4 text-center text-muted-foreground">
            <Icon name="alert-triangle" className="size-12 text-status-error" />
            <span className="text-sm" data-testid="file-preview-failed">
              {t('file.previewFailed')}
            </span>
          </div>,
        )}
      </div>
    )
  }

  // Медиа: inline-предпросмотр через `/fs/raw` (Range/ETag — на сервере).
  if (isMedia && projectId && filePath) {
    const url = synthApi.rawFileUrl(projectId, filePath)
    const handleMediaError = () => setPreviewFailed(true)
    return (
      <div className={rootClass} data-testid="file-viewer-root">
        {toolbar}
        {/* Картинка живёт в своём контейнере с паном и зумом, поэтому скролл
            снаружи выключен (`overflow-auto` остаётся для остальных медиа). */}
        <div
          className={
            kind === 'image'
              ? 'flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4'
              : 'flex min-h-0 flex-1 items-center justify-center overflow-auto p-4'
          }
        >
          {kind === 'image' && (
            <ImageViewer src={url} alt={fileName} onError={handleMediaError} />
          )}
          {kind === 'video' && (
            <video
              controls
              preload="metadata"
              src={url}
              className="max-h-full max-w-full"
              onError={handleMediaError}
            />
          )}
          {kind === 'audio' && (
            <audio controls preload="metadata" src={url} onError={handleMediaError} />
          )}
          {kind === 'pdf' && (
            <iframe src={url} className="h-full w-full border-0" title={fileName} />
          )}
        </div>
      </div>
    )
  }

  if (isBinary) {
    return (
      <div className={rootClass} data-testid="file-viewer-root">
        {toolbar}
        {centered(
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Icon name="file-3" className="size-12" />
            <span className="text-sm">{t('file.binaryFile', { size: String(binarySize) })}</span>
          </div>,
        )}
      </div>
    )
  }

  // HTML-документ проекта: изоляция — атрибут `sandbox` (граница), meta-CSP —
  // второй слой. `allow-scripts`/`allow-same-origin`/`allow-forms` не выдаём:
  // отчёт агента не исполняет код и не ходит в сеть от нашего origin.
  if (isHtml && content !== null) {
    return (
      <div className={rootClass} data-testid="file-viewer-root">
        {toolbar}
        {/* У iframe своего внешнего скролла нет — прокручивается сам документ. */}
        <div className="min-h-0 w-full flex-1">
          {viewMode === 'source' ? (
            <TextViewer content={content} filePath={filePath ?? ''} />
          ) : (
            <iframe
              title={fileName}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              srcDoc={sandboxedHtml}
              className="h-full w-full border-0 bg-white"
              data-testid="html-preview"
            />
          )}
        </div>
      </div>
    )
  }

  const showMarkdownPreview = isMarkdown && content !== null && viewMode === 'preview'
  return (
    <div className={rootClass} data-testid="file-viewer-root">
      {toolbar}
      <div className="min-h-0 w-full flex-1 overflow-auto">
        {showMarkdownPreview ? (
          <div
            className={
              fileViewerWidth === 'column'
                ? 'p-4 min-w-0 w-full mx-auto max-w-[108ch]'
                : 'p-4 min-w-0 w-full max-w-full'
            }
            onClick={handleMarkdownClick}
          >
            <MarkdownContent content={content ?? ''} resolveAsset={resolveAsset} />
          </div>
        ) : content !== null ? (
          <TextViewer content={content} filePath={filePath ?? ''} />
        ) : null}
      </div>
    </div>
  )
}
