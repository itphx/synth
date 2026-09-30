import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useInstructionsStore } from '@/stores/instructionsStore'
import { formatTokens } from '@/lib/formatStats'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon/Icon'
import type { InstructionFileInfo, InstructionFileStatus } from '@/lib/api/synthApi'

const STATUS_CLASS: Record<InstructionFileStatus, string> = {
  loaded: 'bg-muted text-muted-foreground',
  truncated: 'bg-muted text-foreground',
  blocked: 'bg-destructive/15 text-destructive',
  dedup: 'bg-muted text-muted-foreground/70',
  skipped: 'bg-muted text-muted-foreground/70',
  untrusted: 'bg-destructive/15 text-destructive',
  'skipped-install-tree': 'bg-muted text-muted-foreground/70',
  excluded: 'bg-muted text-muted-foreground/70',
  'fetch-error': 'bg-destructive/15 text-destructive',
}

/**
 * AD-069 §9.3: компактный индикатор проектных инструкций.
 *
 * Показывает сводку (файлы + символы), пустое состояние с причиной
 * (`enabled:false` / сессия без проекта) и по разворачиванию — список файлов
 * с относительным путём, размером, статусом и результатом threat-scan.
 * Данные — из `instructionsStore` (обновляется WS-событием
 * `context.instructions_loaded`).
 */
export function ProjectInstructions({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const info = useInstructionsStore((s) => s.infoBySession[sessionId]) ?? null
  const loading = useInstructionsStore((s) => s.loadingBySession[sessionId] ?? false)
  const error = useInstructionsStore((s) => s.errorBySession[sessionId] ?? null)
  const load = useInstructionsStore((s) => s.load)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    void load(sessionId)
  }, [load, sessionId])

  if (!info) {
    if (error) {
      return (
        <div className="flex items-center gap-2" data-testid="instructions-error">
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {t('sessionTab.instructions.loadError')}
          </span>
          <button
            type="button"
            onClick={() => void load(sessionId)}
            className="shrink-0 rounded px-2 py-0.5 text-[0.6875rem] text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
          >
            {t('sessionTab.instructions.retry')}
          </button>
        </div>
      )
    }
    if (loading) {
      return <div className="text-xs text-muted-foreground">{t('common.loading')}</div>
    }
    return null
  }

  if (!info.enabled) {
    return (
      <div className="text-xs text-muted-foreground" data-testid="instructions-disabled">
        {t('sessionTab.instructions.disabled')}
      </div>
    )
  }

  if (info.files.length === 0) {
    const noProject = info.diagnostics.some((d) => d.code === 'no-project')
    const diagnostic = noProject
      ? undefined
      : info.diagnostics.find((d) => d.level === 'error' || d.level === 'warning')
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-2" data-testid="instructions-empty">
        <div className="text-xs text-muted-foreground">
          {t(noProject ? 'sessionTab.instructions.noProject' : 'sessionTab.instructions.empty')}
        </div>
        {diagnostic && (
          <div className="mt-0.5 text-[0.625rem] text-muted-foreground/60 break-words">
            {diagnostic.message}
          </div>
        )}
      </div>
    )
  }

  const totalChars = info.files.reduce((sum, file) => sum + file.chars, 0)
  const truncatedCount = info.files.filter((file) => file.truncated || file.status === 'truncated').length
  const blockedCount = info.files.filter((file) => file.status === 'blocked' || file.scan?.blocked).length

  return (
    <div className="min-w-0" data-testid="instructions-block">
      <button
        type="button"
        data-testid="instructions-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full min-w-0 items-start gap-1.5 text-left"
      >
        <Icon
          name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          {t('sessionTab.instructions.summary', {
            count: info.files.length,
            chars: formatTokens(totalChars),
          })}
          {truncatedCount > 0 && (
            <> · <span className="text-foreground">{t('sessionTab.instructions.truncatedCount', { count: truncatedCount })}</span></>
          )}
          {blockedCount > 0 && (
            <> · <span className="text-destructive">{t('sessionTab.instructions.blockedCount', { count: blockedCount })}</span></>
          )}
        </span>
      </button>

      {expanded && (
        <ul className="mt-1.5 space-y-1" data-testid="instructions-files">
          {info.files.map((file, index) => (
            <InstructionFileRow key={`${file.kind}:${file.path}:${index}`} file={file} />
          ))}
        </ul>
      )}
    </div>
  )
}

function InstructionFileRow({ file }: { file: InstructionFileInfo }) {
  const { t } = useI18n()
  const displayPath = file.kind === 'url' ? (file.label ?? file.url ?? file.path) : file.path
  const title = file.kind === 'url' ? (file.url ?? file.path) : file.path

  return (
    <li
      data-testid="instructions-file"
      className="min-w-0 rounded-lg border border-border/60 bg-input px-2 py-1.5"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon
          name={file.kind === 'url' ? 'link' : 'file-text'}
          className="size-3 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={title} dir="ltr">
          {displayPath}
        </span>
        <span
          className="shrink-0 text-[0.625rem] text-muted-foreground tabular-nums"
          title={t('sessionTab.instructions.chars')}
        >
          {formatTokens(file.chars)}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-5">
        <span
          data-testid="instructions-status"
          className={cn(
            'rounded px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide',
            STATUS_CLASS[file.status],
          )}
        >
          {t(`sessionTab.instructions.status.${file.status}`)}
        </span>
        {file.truncated && (
          <span className="text-[0.5625rem] text-foreground">
            {t('sessionTab.instructions.truncated')}
          </span>
        )}
        {file.scan?.suspicious && (
          <span
            data-testid="instructions-suspicious"
            className="text-[0.5625rem] text-destructive"
            title={file.scan.matches.join(' | ') || undefined}
          >
            {t('sessionTab.instructions.suspicious')}
            {file.scan.matches.length > 0 && ` (${file.scan.matches.length})`}
          </span>
        )}
      </div>
    </li>
  )
}
