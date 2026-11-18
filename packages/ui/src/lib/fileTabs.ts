/**
 * Идентификаторы и открытие файловых вкладок.
 *
 * Id — единый ключ вкладки: дерево файлов, Git-вкладка, ссылки из markdown и
 * просмотрщик должны открывать **одну и ту же** вкладку (иначе на один файл
 * появляется несколько панелей с расходящимся состоянием).
 */
import type { FileKind } from '@itphx/synth-shared/types'
import type { CenterTab } from '@/stores/useUIStore'

/**
 * Режим файловой вкладки (`CenterTab.data.viewMode`).
 *
 * `preview` — рендер markdown/HTML, `source` — текст с номерами строк и
 * подсветкой, `diff` — изменения файла в рабочем дереве. Режим — данные
 * вкладки, а не локальное состояние: «открыть в diff» из дерева/панели Git
 * переключает уже открытую вкладку через `updateTabData`.
 */
export type FileViewMode = 'preview' | 'source' | 'diff'

/** Все режимы (для валидации данных, пришедших из сохранённого состояния). */
export const FILE_VIEW_MODES: readonly FileViewMode[] = ['preview', 'source', 'diff']

/** Id вкладки просмотра файла проекта (`file-<project>/<path>`). */
export function fileViewerTabId(projectId: string, filePath: string): string {
  return `file-${projectId}/${filePath}`
}

/** Id вкладки редактора файла проекта (`edit-<project>/<path>`). */
export function fileEditorTabId(projectId: string, filePath: string): string {
  return `edit-${projectId}/${filePath}`
}

/** Имя файла из пути — заголовок вкладки. */
export function fileNameOf(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

/**
 * Режим по умолчанию по семейству файла: разметка — превью, всё остальное
 * (текст, код, неизвестное) — исходник.
 */
export function defaultFileViewMode(kind: FileKind): FileViewMode {
  return kind === 'markdown' || kind === 'html' ? 'preview' : 'source'
}

/** Нормализация режима из данных вкладки (сохранённое/чужое значение — `null`). */
export function parseFileViewMode(value: unknown): FileViewMode | null {
  return typeof value === 'string' && (FILE_VIEW_MODES as readonly string[]).includes(value)
    ? (value as FileViewMode)
    : null
}

type OpenTab = (tab: CenterTab) => void

export interface FileTabTarget {
  projectId: string
  /** Путь файла относительно корня workspace. */
  filePath: string
  viewMode?: FileViewMode
}

/** Открыть (или активировать) вкладку просмотра файла. */
export function openFileTab(openTab: OpenTab, target: FileTabTarget): void {
  const { projectId, filePath, viewMode } = target
  openTab({
    id: fileViewerTabId(projectId, filePath),
    type: 'file-viewer',
    title: fileNameOf(filePath),
    data: viewMode ? { projectId, filePath, viewMode } : { projectId, filePath },
  })
}

/**
 * Открыть файл сразу в режиме «Изменения» — та же вкладка `file-viewer`
 * (не отдельная `git-diff`): переключение режима, а не новая панель.
 */
export function openFileDiffTab(openTab: OpenTab, target: Omit<FileTabTarget, 'viewMode'>): void {
  openFileTab(openTab, { ...target, viewMode: 'diff' })
}

/** Открыть (или активировать) вкладку редактора файла. */
export function openFileEditorTab(openTab: OpenTab, target: Omit<FileTabTarget, 'viewMode'>): void {
  const { projectId, filePath } = target
  openTab({
    id: fileEditorTabId(projectId, filePath),
    type: 'file-editor',
    title: fileNameOf(filePath),
    data: { projectId, filePath },
  })
}
