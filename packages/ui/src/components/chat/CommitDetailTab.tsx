import { useEffect, useState } from 'react'
import { useGitStore } from '@/stores/gitStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import type { CenterTab } from '@/stores/useUIStore'
import type { CommitDetail } from '@synth/shared'

interface CommitDetailTabProps {
  tab: CenterTab
}

export function CommitDetailTab({ tab }: CommitDetailTabProps) {
  const { t, locale } = useI18n()
  const { loadCommitDetail } = useGitStore()
  const [commit, setCommit] = useState<CommitDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const projectId = tab.data.projectId
  const repoPath = tab.data.repoPath || ''
  const commitHash = tab.data.commitHash || ''

  useEffect(() => {
    if (!projectId || !commitHash) {
      setLoading(false)
      setError(t('commit.hash'))
      return
    }

    setLoading(true)
    setError(null)

    loadCommitDetail(projectId, repoPath, commitHash)
      .then((detail) => {
        if (detail) {
          setCommit(detail)
        } else {
          setError(t('errors.notFound.route'))
        }
        setLoading(false)
      })
      .catch((e) => {
        setError((e as Error).message)
        setLoading(false)
      })
  }, [projectId, repoPath, commitHash, loadCommitDetail, t])

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

  if (error || !commit) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Icon name="alert-triangle" className="size-8 text-red-500" />
          <span className="text-sm">{error || t('errors.notFound.route')}</span>
        </div>
      </div>
    )
  }

  const dateStr = new Date(commit.date).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU')

  return (
    <div className="flex h-full flex-col bg-background overflow-y-auto">
      {/* Заголовок */}
      <div className="p-4 pb-2 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <pre className="text-sm text-foreground font-sans whitespace-pre-wrap break-words leading-relaxed">
              {commit.message}
            </pre>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="text-[10px] opacity-60">{t('commit.hash')}:</span>
            <code className="font-mono text-[10px] bg-interactive rounded px-1 py-px">{commit.shortHash}</code>
          </span>
          <span className="flex items-center gap-1">
            <span className="text-[10px] opacity-60">{t('commit.author')}:</span>
            {commit.author}
          </span>
          <span className="flex items-center gap-1">
            <span className="text-[10px] opacity-60">{t('git.branch')}:</span>
            <code className="font-mono text-[10px] bg-interactive rounded px-1 py-px">{commit.branch}</code>
          </span>
          <span className="flex items-center gap-1">
            <span className="text-[10px] opacity-60">{t('commit.date')}:</span>
            {dateStr}
          </span>
        </div>
      </div>

      {/* Файлы */}
      {commit.files.length > 0 && (
        <div className="px-4 pb-2">
          <div className="text-[11px] text-muted-foreground mb-1.5 flex items-center gap-2">
            <Icon name="file-text" className="size-3" />
            <span>{t('commit.filesCount', { count: String(commit.files.length) })}</span>
          </div>
          <div className="space-y-0.5">
            {commit.files.map((f) => (
              <div key={f.path} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={`w-3.5 text-center text-[10px] font-mono ${
                  f.status === 'added' ? 'text-green-500' :
                  f.status === 'deleted' ? 'text-red-500' :
                  f.status === 'renamed' ? 'text-yellow-500' :
                  'text-foreground'
                }`}>
                  {f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : f.status === 'renamed' ? 'R' : 'M'}
                </span>
                <span className="truncate">{f.path}</span>
                {f.additions > 0 && <span className="text-[10px] text-green-500">+{f.additions}</span>}
                {f.deletions > 0 && <span className="text-[10px] text-red-500">-{f.deletions}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Дифф */}
      {commit.diff && (
        <div className="flex-1 min-h-0 border-t border-sidebar-border">
          <pre className="p-4 text-xs font-mono text-muted-foreground whitespace-pre overflow-x-auto leading-relaxed">
            {commit.diff.split('\n').map((line, i) => (
              <span
                key={i}
                className={
                  line.startsWith('+') && !line.startsWith('+++') ? 'text-green-500' :
                  line.startsWith('-') && !line.startsWith('---') ? 'text-red-500' :
                  line.startsWith('@@') ? 'text-blue-400' :
                  ''
                }
              >
                {line}{'\n'}
              </span>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}
