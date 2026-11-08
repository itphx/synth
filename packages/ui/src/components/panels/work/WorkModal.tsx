import { useCallback, useEffect, useMemo, useState } from 'react'

import type { TodoItem, TodoPriority, TodoStatus } from '@itphx/synth-shared/types'
import type { ProjectPlan } from '@itphx/synth-shared/types'
import {
  synthApi,
  type ProjectLogEntryDto,
} from '@/lib/api/synthApi'
import { confirm as globalConfirm } from '@/lib/confirm'
import { useI18n } from '@/lib/i18n'
import { MARKDOWN_LIMITS } from '@/lib/markdown/limits'
import { useProjectsStore } from '@/stores/projectsStore'
import { useProjectLogStore } from '@/stores/projectLogStore'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Tabs } from '@/components/ui/settings/controls/Tabs'
import { InvariantsEditor } from './InvariantsEditor'
import { JournalList } from './JournalList'
import { MarkdownEditor } from './MarkdownEditor'
import { PlanBoard } from './PlanBoard'
import { TodoSummary } from './TodoSummary'
import { WorkStats } from './WorkStats'

/** Вкладки модального рабочего окна (PROP-054). */
export type WorkTab = 'board' | 'todos' | 'journal' | 'invariants' | 'stats'

export interface WorkModalProps {
  /** Открыто ли окно. */
  open: boolean
  /** Смена состояния (закрытие по крестику/Esc). */
  onOpenChange: (open: boolean) => void
  /** Проект (план, журнал, инварианты). */
  projectId?: string | null
  /** Сессия (ToDo). */
  sessionId?: string | null
  /** Вкладка при открытии. */
  initialTab?: WorkTab
  /** Право изменять содержимое проекта (owner/EDITOR/LEAD/ADMIN). */
  canEdit?: boolean
  /**
   * Право изменять ToDo сессии (write-доступ к сессии).
   *
   * Отдельный флаг: права проекта и права сессии — разные оси (ADR-089,
   * инвариант 21). Без флага вкладка ToDo — только для чтения.
   */
  canEditTodos?: boolean
  /**
   * Подтверждение удаления. По умолчанию — глобальный `confirm()`
   * (`lib/confirm.ts`); тесты/интегратор могут подставить свой.
   */
  confirmAction?: (opts: { title: string; message: string }) => Promise<boolean>
  /** Обработчик ошибки мутации (тост). */
  onError?: (error: unknown) => void
  /** Маркер для тестов. */
  testId?: string
}

/** Код конфликта версии плана (`409 PLAN_VERSION_CONFLICT`). */
const PLAN_VERSION_CONFLICT = 'PLAN_VERSION_CONFLICT'

/**
 * Модальное рабочее окно (PROP-054): доска, журнал, инварианты, статистика.
 *
 * Окно само читает и меняет данные (точечный API плана/ToDo/журнала/
 * инвариантов). Права мутаций — по `canEdit` (серверная проверка — на границе).
 */
export function WorkModal({
  open,
  onOpenChange,
  projectId,
  sessionId,
  initialTab = 'board',
  canEdit = false,
  canEditTodos = false,
  confirmAction,
  onError,
  testId,
}: WorkModalProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<WorkTab>(initialTab)

  const [plan, setPlan] = useState<ProjectPlan | null>(null)
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [invariants, setInvariants] = useState('')
  // Деталь проекта в сторе — источник истины для инвариантов: событие
  // `project.updated { kind: 'invariants' }` обновляет её, и открытое окно
  // не должно показывать устаревший текст.
  const storeInvariants = useProjectsStore((s) => (
    projectId ? s.projects.find((p) => p.id === projectId)?.invariants : undefined
  ))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Журнал — общий стор проекта: страница общая для панели и модального
  // окна, поэтому событие `project.updated { kind: 'log' }` обновляет и
  // открытое окно (инвариант 27).
  const journal = useProjectLogStore((s) => (projectId ? s.byProject[projectId] : undefined))
  const refreshJournal = useProjectLogStore((s) => s.refresh)
  const loadMoreJournal = useProjectLogStore((s) => s.loadMore)
  const entries: ProjectLogEntryDto[] = journal?.entries ?? []
  const journalTotal = journal?.total ?? 0

  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')

  const askConfirm = useCallback(
    (opts: { title: string; message: string }) => {
      if (confirmAction) return confirmAction(opts)
      return globalConfirm(opts)
    },
    [confirmAction],
  )

  const reportError = useCallback(
    (err: unknown) => {
      const code = (err as { code?: string } | null)?.code
      if (code === PLAN_VERSION_CONFLICT) {
        setError(t('work.error.conflict'))
        // 409 — план изменился (модель/другой клиент): перечитываем актуальный,
        // чтобы следующая правка шла с новой версией.
        if (projectId) {
          void synthApi
            .getProjectPlan(projectId)
            .then((response) => setPlan(response.plan ?? null))
            .catch(() => {})
        }
      } else {
        setError(t('work.error.save'))
      }
      onError?.(err)
    },
    [onError, projectId, t],
  )

  const loadPlan = useCallback(async () => {
    if (!projectId) {
      setPlan(null)
      return
    }
    const response = await synthApi.getProjectPlan(projectId)
    setPlan(response.plan ?? null)
  }, [projectId])

  const loadTodos = useCallback(async () => {
    if (!sessionId) {
      setTodos([])
      return
    }
    const response = await synthApi.getSessionTodos(sessionId)
    setTodos(response.todos ?? [])
  }, [sessionId])

  const loadJournal = useCallback(async () => {
    if (!projectId) return
    await refreshJournal(projectId)
  }, [projectId, refreshJournal])

  const loadInvariants = useCallback(async () => {
    if (!projectId) {
      setInvariants('')
      return
    }
    const response = await synthApi.getProjectInvariants(projectId)
    setInvariants(response.invariants ?? '')
  }, [projectId])

  useEffect(() => {
    if (saving) return
    if (typeof storeInvariants === 'string' && storeInvariants !== invariants) {
      setInvariants(storeInvariants)
    }
  }, [storeInvariants, saving, invariants])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.allSettled([loadPlan(), loadTodos(), loadJournal(), loadInvariants()])
      .then((results) => {
        if (cancelled) return
        const failed = results.find((r) => r.status === 'rejected')
        if (failed) setError(t('work.error.load'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, loadPlan, loadTodos, loadJournal, loadInvariants, t])

  useEffect(() => {
    setTab(initialTab)
  }, [initialTab])

  const moveItem = useCallback(
    async (itemId: string, columnId: string) => {
      if (!projectId || !plan) return
      setSaving(true)
      try {
        const response = await synthApi.moveProjectPlanItem(projectId, itemId, {
          columnId,
          version: plan.version,
        })
        setPlan(response.plan ?? null)
      } catch (err) {
        reportError(err)
        try {
          await loadPlan()
        } catch {
          // План не перечитался — сообщение уже показано.
        }
      } finally {
        setSaving(false)
      }
    },
    [loadPlan, plan, projectId, reportError],
  )

  const deleteItem = useCallback(
    async (itemId: string) => {
      if (!projectId) return
      const ok = await askConfirm({
        title: t('work.confirm.deleteItemTitle'),
        message: t('work.confirm.deleteItemMessage'),
      })
      if (!ok) return
      setSaving(true)
      try {
        const response = await synthApi.deleteProjectPlanItem(projectId, itemId)
        setPlan(response.plan ?? null)
      } catch (err) {
        reportError(err)
      } finally {
        setSaving(false)
      }
    },
    [askConfirm, projectId, reportError, t],
  )

  const addItem = useCallback(
    async (columnId: string, title: string) => {
      if (!projectId) return
      setSaving(true)
      try {
        const response = await synthApi.createProjectPlanItem(projectId, { title, columnId })
        setPlan(response.plan ?? null)
      } catch (err) {
        reportError(err)
      } finally {
        setSaving(false)
      }
    },
    [projectId, reportError],
  )

  const renameColumn = useCallback(
    async (columnId: string, name: string) => {
      if (!projectId) return
      setSaving(true)
      try {
        const response = await synthApi.updateProjectPlanColumn(projectId, columnId, { name })
        setPlan(response.plan ?? null)
      } catch (err) {
        reportError(err)
      } finally {
        setSaving(false)
      }
    },
    [projectId, reportError],
  )

  const deleteColumn = useCallback(
    async (columnId: string) => {
      if (!projectId || !plan) return
      const column = plan.columns.find((entry) => entry.id === columnId)
      if (!column) return
      const count = plan.items.filter((item) => item.columnId === columnId).length
      const ok = await askConfirm({
        title: t('work.confirm.deleteColumnTitle'),
        message: t('work.confirm.deleteColumnMessage', { name: column.name, count }),
      })
      if (!ok) return
      setSaving(true)
      try {
        const response = await synthApi.deleteProjectPlanColumn(projectId, columnId, {
          moveItemsTo: null,
          version: plan.version,
        })
        setPlan(response.plan ?? null)
      } catch (err) {
        reportError(err)
      } finally {
        setSaving(false)
      }
    },
    [askConfirm, plan, projectId, reportError, t],
  )

  const addColumn = useCallback(async () => {
    if (!projectId) return
    setSaving(true)
    try {
      const response = await synthApi.createProjectPlanColumn(projectId, {
        name: t('work.board.defaultColumnName'),
      })
      setPlan(response.plan ?? null)
    } catch (err) {
      reportError(err)
    } finally {
      setSaving(false)
    }
  }, [projectId, reportError, t])

  const startEditItem = useCallback(
    (itemId: string) => {
      const item = plan?.items.find((entry) => entry.id === itemId)
      if (!item) return
      setEditingItemId(itemId)
      setEditTitle(item.title)
      setEditDescription(item.description ?? '')
    },
    [plan],
  )

  const saveItem = useCallback(async () => {
    if (!projectId || !editingItemId) return
    setSaving(true)
    try {
      const response = await synthApi.updateProjectPlanItem(projectId, editingItemId, {
        title: editTitle.trim() || undefined,
        description: editDescription,
      })
      setPlan(response.plan ?? null)
      setEditingItemId(null)
    } catch (err) {
      reportError(err)
    } finally {
      setSaving(false)
    }
  }, [editDescription, editTitle, editingItemId, projectId, reportError])

  const addJournalEntry = useCallback(
    async (text: string) => {
      if (!projectId) return
      setSaving(true)
      try {
        await synthApi.createProjectLogEntry(projectId, { text })
        await loadJournal()
      } catch (err) {
        reportError(err)
      } finally {
        setSaving(false)
      }
    },
    [loadJournal, projectId, reportError],
  )

  const editJournalEntry = useCallback(
    async (entryId: string, text: string) => {
      if (!projectId) return
      setSaving(true)
      try {
        await synthApi.updateProjectLogEntry(projectId, entryId, { text })
        await loadJournal()
      } catch (err) {
        reportError(err)
      } finally {
        setSaving(false)
      }
    },
    [loadJournal, projectId, reportError],
  )

  const deleteJournalEntry = useCallback(
    async (entryId: string) => {
      if (!projectId) return
      const ok = await askConfirm({
        title: t('work.confirm.deleteEntryTitle'),
        message: t('work.confirm.deleteEntryMessage'),
      })
      if (!ok) return
      setSaving(true)
      try {
        await synthApi.deleteProjectLogEntry(projectId, entryId)
        await loadJournal()
      } catch (err) {
        reportError(err)
      } finally {
        setSaving(false)
      }
    },
    [askConfirm, loadJournal, projectId, reportError, t],
  )

  const saveInvariants = useCallback(
    async (value: string) => {
      if (!projectId) return
      setSaving(true)
      try {
        const response = await synthApi.putProjectInvariants(projectId, { invariants: value })
        setInvariants(response.invariants ?? value)
      } catch (err) {
        reportError(err)
      } finally {
        setSaving(false)
      }
    },
    [projectId, reportError],
  )

  // --- ToDo сессии (право — отдельное: write-доступ к сессии) ---

  const addTodo = useCallback(
    async (content: string, status: TodoStatus) => {
      if (!sessionId) return
      setSaving(true)
      try {
        const response = await synthApi.createSessionTodo(sessionId, { content, status })
        setTodos(response.todos ?? [])
      } catch (err) {
        reportError(err)
      } finally {
        setSaving(false)
      }
    },
    [reportError, sessionId],
  )

  const updateTodo = useCallback(
    async (
      todoId: string,
      patch: { content?: string; status?: TodoStatus; priority?: TodoPriority },
    ) => {
      if (!sessionId) return
      setSaving(true)
      try {
        const response = await synthApi.updateSessionTodo(sessionId, todoId, patch)
        setTodos(response.todos ?? [])
      } catch (err) {
        reportError(err)
      } finally {
        setSaving(false)
      }
    },
    [reportError, sessionId],
  )

  const deleteTodo = useCallback(
    async (todoId: string) => {
      if (!sessionId) return
      const ok = await askConfirm({
        title: t('work.confirm.deleteTodoTitle'),
        message: t('work.confirm.deleteTodoMessage'),
      })
      if (!ok) return
      setSaving(true)
      try {
        const response = await synthApi.deleteSessionTodo(sessionId, todoId)
        setTodos(response.todos ?? [])
      } catch (err) {
        reportError(err)
      } finally {
        setSaving(false)
      }
    },
    [askConfirm, reportError, sessionId, t],
  )

  const clearTodos = useCallback(async () => {
    if (!sessionId) return
    const ok = await askConfirm({
      title: t('work.confirm.clearTodosTitle'),
      message: t('work.confirm.clearTodosMessage'),
    })
    if (!ok) return
    setSaving(true)
    try {
      const response = await synthApi.clearSessionTodos(sessionId, {
        statuses: ['completed', 'cancelled'],
      })
      setTodos(response.todos ?? [])
    } catch (err) {
      reportError(err)
    } finally {
      setSaving(false)
    }
  }, [askConfirm, reportError, sessionId, t])

  /** Порядок пунктов ToDo (массив) — переупорядочивание в модальном окне. */
  const moveTodo = useCallback(
    async (todoId: string, direction: -1 | 1) => {
      if (!sessionId) return
      const ids = todos.map((todo) => todo.id)
      const index = ids.indexOf(todoId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= ids.length) return
      const next = [...ids]
      next.splice(index, 1)
      next.splice(target, 0, todoId)
      setSaving(true)
      try {
        const response = await synthApi.reorderSessionTodos(sessionId, next)
        setTodos(response.todos ?? [])
      } catch (err) {
        reportError(err)
      } finally {
        setSaving(false)
      }
    },
    [reportError, sessionId, todos],
  )

  const tabs = useMemo(
    () => [
      { value: 'board', label: t('work.modal.tab.board'), title: t('work.modal.tab.board') },
      { value: 'todos', label: t('work.modal.tab.todos'), title: t('work.modal.tab.todos') },
      { value: 'journal', label: t('work.modal.tab.journal'), title: t('work.modal.tab.journal') },
      { value: 'invariants', label: t('work.modal.tab.invariants'), title: t('work.modal.tab.invariants') },
      { value: 'stats', label: t('work.modal.tab.stats'), title: t('work.modal.tab.stats') },
    ],
    [t],
  )

  const editingItem = editingItemId
    ? plan?.items.find((entry) => entry.id === editingItemId) ?? null
    : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[90vh] max-h-[90vh] w-[90vw] max-w-[90vw] gap-3 p-4"
        data-testid={testId ?? 'work-modal'}
      >
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 items-center justify-between gap-2 pr-8">
            <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">{t('work.modal.title')}</h2>
          </div>

          <Tabs
            items={tabs}
            value={tab}
            onChange={(next) => setTab(next as WorkTab)}
            ariaLabel={t('work.modal.title')}
            wrap
          />

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-testid="work-modal-error">
              {error}
            </div>
          )}

          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid={`work-modal-body-${tab}`}>
            {tab === 'board' && (
              <div className="flex min-w-0 flex-col gap-2">
                {editingItem && (
                  <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface-inset p-2" data-testid="work-modal-item-editor">
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      aria-label={t('work.board.itemTitle')}
                      data-testid="work-modal-item-title"
                      className="min-w-0 rounded border border-border bg-input px-2 py-1 text-base text-foreground sm:text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <MarkdownEditor
                      value={editDescription}
                      onChange={setEditDescription}
                      onSave={() => void saveItem()}
                      onCancel={() => setEditingItemId(null)}
                      saving={saving}
                      limit={MARKDOWN_LIMITS.planDescription}
                      label={t('work.board.itemDescription')}
                      testId="work-modal-item-description"
                    />
                  </div>
                )}
                <PlanBoard
                  plan={plan}
                  readOnly={!canEdit}
                  onMoveItem={(itemId, columnId) => void moveItem(itemId, columnId)}
                  onEditItem={canEdit ? startEditItem : undefined}
                  onDeleteItem={canEdit ? (itemId) => void deleteItem(itemId) : undefined}
                  onAddItem={canEdit ? (columnId, title) => void addItem(columnId, title) : undefined}
                  onRenameColumn={canEdit ? (columnId, name) => void renameColumn(columnId, name) : undefined}
                  onDeleteColumn={canEdit ? (columnId) => void deleteColumn(columnId) : undefined}
                  onAddColumn={canEdit ? () => void addColumn() : undefined}
                  testId="work-modal-board"
                />
              </div>
            )}

            {tab === 'todos' && (
              <TodoSummary
                todos={todos}
                canEdit={canEditTodos}
                onAdd={(content, status) => void addTodo(content, status)}
                onUpdate={(todoId, patch) => void updateTodo(todoId, patch)}
                onDelete={(todoId) => void deleteTodo(todoId)}
                onClearCompleted={() => void clearTodos()}
                onMoveUp={(todoId) => void moveTodo(todoId, -1)}
                onMoveDown={(todoId) => void moveTodo(todoId, 1)}
                testId="work-modal-todos"
              />
            )}

            {tab === 'journal' && (
              <JournalList
                entries={entries}
                total={journalTotal}
                hasMore={journal?.nextOffset !== null && journal?.nextOffset !== undefined}
                loading={loading}
                loadingMore={journal?.loadingMore ?? false}
                error={journal?.error ?? null}
                onLoadMore={() => {
                  if (projectId) void loadMoreJournal(projectId)
                }}
                onAdd={canEdit ? (text) => void addJournalEntry(text) : undefined}
                onEdit={canEdit ? (entryId, text) => void editJournalEntry(entryId, text) : undefined}
                onDelete={canEdit ? (entryId) => void deleteJournalEntry(entryId) : undefined}
                bodyMode="render"
                testId="work-modal-journal"
              />
            )}

            {tab === 'invariants' && (
              <InvariantsEditor
                value={invariants}
                onSave={(value) => void saveInvariants(value)}
                saving={saving}
                readOnly={!canEdit}
                testId="work-modal-invariants"
              />
            )}

            {tab === 'stats' && (
              <WorkStats
                plan={plan}
                todos={todos}
                journalEntries={entries}
                journalTotal={journalTotal}
                testId="work-modal-stats"
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
