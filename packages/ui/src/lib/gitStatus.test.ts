import { describe, expect, it } from 'vitest'
import type { GitRepoWorktreeStatus, GitWorktreeFile } from '@itphx/synth-shared/types'
import {
  buildStatusIndex,
  dirStatus,
  fileStatus,
  hasVcsDot,
  repoForFile,
} from './gitStatus'

function file(path: string, kind: GitWorktreeFile['kind'], staged = false, unstaged = true): GitWorktreeFile {
  return { path, kind, staged, unstaged }
}

function repo(path: string, files: GitWorktreeFile[]): GitRepoWorktreeStatus {
  return { path, files }
}

describe('gitStatus — индекс статуса рабочего дерева', () => {
  it('корневой репозиторий: пути файлов остаются как есть', () => {
    const index = buildStatusIndex([repo('', [file('src/a.ts', 'modified')])])
    expect(fileStatus(index, 'src/a.ts')).toEqual({
      kind: 'modified',
      staged: false,
      unstaged: true,
      repoPath: '',
      repoRelativePath: 'src/a.ts',
    })
  })

  it('вложенный репозиторий: путь индексируется от корня workspace', () => {
    const index = buildStatusIndex([repo('vendor/lib', [file('index.ts', 'added')])])
    expect(fileStatus(index, 'vendor/lib/index.ts')).toMatchObject({
      kind: 'added',
      repoPath: 'vendor/lib',
      repoRelativePath: 'index.ts',
    })
  })

  it('вложенные репозитории: побеждает самый длинный repo.path', () => {
    const index = buildStatusIndex([
      repo('', [file('sub/inner/a.ts', 'modified')]),
      repo('sub/inner', [file('a.ts', 'added')]),
    ])
    expect(fileStatus(index, 'sub/inner/a.ts')).toMatchObject({
      kind: 'added',
      repoPath: 'sub/inner',
      repoRelativePath: 'a.ts',
    })
  })

  it('путь с несколькими сегментами каталогов не путается', () => {
    const index = buildStatusIndex([repo('', [file('a/b/c.txt', 'deleted')])])
    expect(fileStatus(index, 'a/b/c.txt')?.kind).toBe('deleted')
    expect(fileStatus(index, 'a/b')?.kind).toBeUndefined()
  })

  it('хвостовой слэш у игнорируемого каталога нормализуется', () => {
    const index = buildStatusIndex([repo('', [file('node_modules/', 'ignored')])])
    expect(fileStatus(index, 'node_modules')).toMatchObject({ kind: 'ignored' })
  })

  it('dirStatus: запись ровно по пути каталога даёт вид каталогу (node_modules)', () => {
    const index = buildStatusIndex([repo('', [file('node_modules/', 'ignored')])])
    expect(dirStatus(index, 'node_modules')).toEqual({ kind: 'ignored', count: 0 })
  })

  it('dirStatus: запись ровно по пути каталога даёт вид новому каталогу (Test/)', () => {
    // `--untracked-files=all` перечисляет файлы поимённо, но запись о каталоге
    // тоже возможна — каталог не должен остаться без метки.
    const index = buildStatusIndex([repo('', [file('Test/', 'untracked')])])
    expect(dirStatus(index, 'Test')).toEqual({ kind: 'untracked', count: 0 })
  })

  it('dirStatus: ignored из потомков не приглушает родителя', () => {
    const index = buildStatusIndex([
      repo('', [
        file('synth/node_modules/', 'ignored'),
        file('synth/node_modules/lib/a.js', 'ignored'),
      ]),
    ])
    // Родитель `synth` не приглушается, корень — тоже.
    expect(dirStatus(index, 'synth')).toBeNull()
    expect(dirStatus(index, '')).toBeNull()
    expect(dirStatus(index, 'synth/node_modules')).toEqual({ kind: 'ignored', count: 0 })
  })

  it('dirStatus: каталог с untracked-файлами — untracked (зелёный), count без них', () => {
    const index = buildStatusIndex([
      repo('', [
        file('Test/Test.txt', 'untracked'),
        file('Test/other.txt', 'untracked'),
      ]),
    ])
    expect(dirStatus(index, 'Test')).toEqual({ kind: 'untracked', count: 0 })
    expect(dirStatus(index, '')).toEqual({ kind: 'untracked', count: 0 })
  })

  it('dirStatus агрегирует потомков по приоритету', () => {
    const index = buildStatusIndex([
      repo('', [
        file('src/a.ts', 'modified'),
        file('src/b.ts', 'added'),
        file('src/c.ts', 'conflict'),
      ]),
    ])
    expect(dirStatus(index, 'src')).toEqual({ kind: 'conflict', count: 3 })
  })

  it('dirStatus: порядок приоритета conflict > deleted > added > modified > typechange > renamed > untracked', () => {
    const order = [
      'conflict',
      'deleted',
      'added',
      'modified',
      'typechange',
      'renamed',
      'untracked',
    ] as const
    for (let i = 0; i < order.length; i += 1) {
      const files = order.slice(i).map((kind, n) => file(`src/${n}.ts`, kind))
      const index = buildStatusIndex([repo('', files)])
      expect(dirStatus(index, 'src')?.kind).toBe(order[i])
    }
  })

  it('dirStatus не считает untracked/ignored в count', () => {
    const index = buildStatusIndex([
      repo('', [
        file('src/a.ts', 'modified'),
        file('src/gen.ts', 'untracked'),
        file('src/cache/', 'ignored'),
      ]),
    ])
    expect(dirStatus(index, 'src')).toEqual({ kind: 'modified', count: 1 })
  })

  it('dirStatus: только untracked даёт зелёный вид и нулевой count', () => {
    const index = buildStatusIndex([repo('', [file('logs/a.log', 'untracked')])])
    expect(dirStatus(index, 'logs')).toEqual({ kind: 'untracked', count: 0 })
  })

  it('dirStatus пустого/неизменённого каталога — null', () => {
    const index = buildStatusIndex([repo('', [file('src/a.ts', 'modified')])])
    expect(dirStatus(index, 'docs')).toBeNull()
    expect(dirStatus(index, 'src/other.ts')).toBeNull()
  })

  it('dirStatus корня агрегирует весь workspace (count для шапки проекта)', () => {
    const index = buildStatusIndex([
      repo('', [file('a.ts', 'modified')]),
      repo('vendor/lib', [file('b.ts', 'added'), file('c.ts', 'untracked')]),
    ])
    expect(dirStatus(index, '')).toEqual({ kind: 'added', count: 2 })
  })

  it('hasVcsDot: точка только у tracked-видов', () => {
    for (const kind of ['added', 'modified', 'deleted', 'renamed', 'typechange', 'conflict'] as const) {
      expect(hasVcsDot(kind)).toBe(true)
    }
    expect(hasVcsDot('untracked')).toBe(false)
    expect(hasVcsDot('ignored')).toBe(false)
  })

  it('repoForFile: граница `/` соблюдается (sub не матчит submarine)', () => {
    const repos = [repo('sub', [])]
    expect(repoForFile(repos, 'submarine/x.ts')).toBeNull()
    expect(repoForFile(repos, 'sub/x.ts')).toEqual({ repoPath: 'sub', repoRelativePath: 'x.ts' })
  })

  it('repoForFile: побеждает более длинный репозиторий', () => {
    const repos = [repo('', []), repo('sub', []), repo('sub/inner', [])]
    expect(repoForFile(repos, 'sub/inner/a.ts')).toEqual({
      repoPath: 'sub/inner',
      repoRelativePath: 'a.ts',
    })
    expect(repoForFile(repos, 'sub/a.ts')).toEqual({ repoPath: 'sub', repoRelativePath: 'a.ts' })
    expect(repoForFile(repos, 'top.ts')).toEqual({ repoPath: '', repoRelativePath: 'top.ts' })
  })

  it('repoForFile: файл вне репозиториев — null', () => {
    expect(repoForFile([], 'a.ts')).toBeNull()
    expect(repoForFile([repo('sub', [])], '')).toBeNull()
  })
})
