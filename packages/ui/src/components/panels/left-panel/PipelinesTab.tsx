import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useUIStore, OTHER_PROJECTS_COLLAPSE_KEY } from '@/stores/useUIStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { useActiveProject } from '@/hooks/useActiveProject'
import { usePipelinesStore } from '@/stores/pipelinesStore'
import type { ProjectData } from '@/lib/api/synthApi'
import { resolveIconName, resolveIconColor } from '@/lib/entityIcon'
import { canEditProjectContent } from '@/lib/projectAccess'
import { TreeNode, TreeChildren, TreeContainer } from '@/components/tree'
import { CurrentProjectHeader, ScopeHint, OtherProjectsGroup } from './scope-parts'
import { CreatePipelineDialog } from '@/components/pipelines/CreatePipelineDialog'

/**
 * Вкладка «Пайплайны» левой панели (ADR-101, Э7).
 *
 * Дерево **проект → пайплайн**: показываются только проекты, к которым у
 * пользователя есть доступ (сервер уже отфильтровал список — `GET /projects`),
 * и только те, что попали в скоуп (`onlyActiveProject` — тот же паттерн
 * варианта C, что у вкладок Files/Git).
 *
 * Права: запись (создание/правка/публикация/запуск/HITL) — по праву изменения
 * содержимого проекта (`OWNER`/`EDITOR`/`LEAD`/`ADMIN`); у `VIEWER` кнопок
 * записи нет (см. `lib/projectAccess.ts`).
 */
export function PipelinesTab() {
  const { t } = useI18n()
  const projects = useProjectsStore((s) => s.projects)
  const loadProjects = useProjectsStore((s) => s.loadProjects)
  const user = useAuthStore((s) => s.user)
  const openTab = useUIStore((s) => s.openTab)
  const onlyActiveProject = useUIStore((s) => s.onlyActiveProject)
  const collapsedProjects = useUIStore((s) => s.collapsedProjects)
  const toggleProjectCollapse = useUIStore((s) => s.toggleProjectCollapse)
  const { projectId: activeProjectId, source: activeProjectSource } = useActiveProject()

  const pipelinesByProject = usePipelinesStore((s) => s.pipelinesByProject)
  const loadProjectPipelines = usePipelinesStore((s) => s.loadProjectPipelines)

  /** Раскрытые проекты (локально: список пайплайнов — лёгкий, персист не нужен). */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [createTarget, setCreateTarget] = useState<ProjectData | null>(null)

  useEffect(() => { void loadProjects() }, [loadProjects])

  const toggleExpanded = useCallback((projectId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }, [])

  // Текущий проект (вариант C) — закреплён и раскрыт.
  const currentProject = useMemo(
    () => (activeProjectId ? projects.find((p) => p.id === activeProjectId) ?? null : null),
    [projects, activeProjectId],
  )
  const otherProjects = useMemo(
    () => projects.filter((p) => p.id !== currentProject?.id),
    [projects, currentProject],
  )

  useEffect(() => {
    if (!currentProject) return
    setExpanded((prev) => (prev.has(currentProject.id) ? prev : new Set(prev).add(currentProject.id)))
  }, [currentProject])

  // Пайплайны подгружаются при раскрытии проекта.
  useEffect(() => {
    expanded.forEach((projectId) => { void loadProjectPipelines(projectId) })
  }, [expanded, loadProjectPipelines])

  const openPipeline = useCallback((project: ProjectData, pipelineId: string, name: string) => {
    openTab({
      id: `pipeline-${project.id}-${pipelineId}`,
      type: 'pipeline',
      title: name,
      data: { projectId: project.id, pipelineId },
    })
  }, [openTab])

  const renderProject = (project: ProjectData) => {
    const isExpanded = expanded.has(project.id)
    const pipelines = pipelinesByProject[project.id] ?? []
    const canEdit = canEditProjectContent(project, user)

    return (
      <div key={project.id}>
        <TreeNode
          id={`pipeline-project:${project.id}`}
          label={project.name}
          icon={resolveIconName(project.icon) ?? 'folder-3'}
          iconColor={resolveIconColor(project.color)}
          iconSize="md"
          isExpanded={isExpanded}
          hasChildren={true}
          onToggle={() => toggleExpanded(project.id)}
          actions={canEdit ? [
            {
              id: 'new-pipeline',
              icon: 'add',
              title: t('pipelines.create'),
              onClick: () => setCreateTarget(project),
            },
          ] : undefined}
        />
        {isExpanded && (
          pipelines.length === 0 ? (
            // Пустое состояние проекта — с действием «создать пайплайн»
            // (у VIEWER действия нет). Свой блок, а не `TreeChildren`:
            // `TreeChildren` при `totalCount === 0` рисует только текст.
            <div className="ml-[0.9375rem] border-l border-sidebar-border pl-4">
              <div className="flex flex-col items-start gap-1 px-2 py-1.5">
                <span className="text-xs text-muted-foreground">{t('pipelines.emptyProject')}</span>
                {canEdit && (
                  <button
                    onClick={() => setCreateTarget(project)}
                    className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
                  >
                    <Icon name="add" className="h-3 w-3" />
                    {t('pipelines.create')}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <TreeChildren borderOnHover totalCount={pipelines.length}>
              {pipelines.map((pipeline) => (
                <TreeNode
                  key={pipeline.id}
                  id={`pipeline:${project.id}:${pipeline.id}`}
                  label={pipeline.name}
                  icon="links-line"
                  subtitle={pipeline.publishedVersion
                    ? t('pipelines.publishedVersion', { version: String(pipeline.publishedVersion) })
                    : t('pipelines.draftOnly')}
                  onClick={() => openPipeline(project, pipeline.id, pipeline.name)}
                />
              ))}
            </TreeChildren>
          )
        )}
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <TreeContainer>
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Icon name="links-line" className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('pipelines.empty')}</p>
        </div>
      </TreeContainer>
    )
  }

  return (
    <TreeContainer>
      {createTarget && (
        <CreatePipelineDialog
          project={createTarget}
          onClose={() => setCreateTarget(null)}
          onCreated={(pipeline) => {
            setCreateTarget(null)
            void loadProjectPipelines(createTarget.id, { force: true })
            openPipeline(createTarget, pipeline.id, pipeline.name)
          }}
        />
      )}

      {!currentProject ? (
        <>
          {activeProjectSource === 'session' && !activeProjectId && (
            <ScopeHint text={t('leftPanel.currentProject.none')} />
          )}
          {activeProjectSource !== null && !!activeProjectId && (
            <ScopeHint text={t('leftPanel.currentProject.noWorkspace')} />
          )}
          {projects.map(renderProject)}
        </>
      ) : (
        <>
          <CurrentProjectHeader label={t('leftPanel.currentProject')} />
          {renderProject(currentProject)}
          {!onlyActiveProject && otherProjects.length > 0 && (
            <OtherProjectsGroup
              label={t('leftPanel.otherProjects', { count: String(otherProjects.length) })}
              title={collapsedProjects.has(OTHER_PROJECTS_COLLAPSE_KEY)
                ? t('leftPanel.otherProjects.expand')
                : t('leftPanel.otherProjects.collapse')}
              collapsed={collapsedProjects.has(OTHER_PROJECTS_COLLAPSE_KEY)}
              onToggle={() => toggleProjectCollapse(OTHER_PROJECTS_COLLAPSE_KEY)}
            >
              {otherProjects.map(renderProject)}
            </OtherProjectsGroup>
          )}
        </>
      )}
    </TreeContainer>
  )
}
