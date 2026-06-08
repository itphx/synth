import type { IconName } from '@/components/icon/Icon'

const TOOL_ICON_MAP: Record<string, IconName> = {
  read_file: 'file-text',
  write_file: 'file-code',
  edit_file: 'pencil-ai',
  create_directory: 'folder-add',
  delete_file: 'delete-bin',
  list_directory: 'folder-open',
  glob: 'search-eye',
  grep_files: 'search',
  execute_shell: 'terminal-box',
  web_fetch: 'global',
  web_search: 'global',
  git_status: 'git-branch',
  git_diff: 'git-repository',
  git_log: 'git-repository',
  git_commit: 'git-commit',
  git_push: 'git-branch',
  git_pull: 'git-branch',
  git_checkout: 'git-branch',
  task: 'brain',
}

export function getToolIcon(toolName: string): IconName {
  return TOOL_ICON_MAP[toolName] || 'tools'
}

export function getToolDisplayName(toolName: string): string {
  const names: Record<string, string> = {
    read_file: 'Read',
    write_file: 'Write',
    edit_file: 'Edit',
    create_directory: 'Mkdir',
    delete_file: 'Delete',
    list_directory: 'List',
    glob: 'Glob',
    grep_files: 'Grep',
    execute_shell: 'Shell',
    web_fetch: 'Fetch',
    web_search: 'Search',
    git_status: 'Status',
    git_diff: 'Diff',
    git_log: 'Log',
    git_commit: 'Commit',
    git_push: 'Push',
    git_pull: 'Pull',
    git_checkout: 'Checkout',
    task: 'Task',
  }
  return names[toolName] || toolName
}
