import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домены `workspace` (`lib/api/workspace.ts`, ADR-075), `skills`/`commands`/
 * `skill-bundles` (`ADRs 046`). Ценно — условный `confirmOutsideRoot` (409-политика),
 * query-параметры discovery и `encodeFilePath` для supporting-файлов скиллов.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('workspaceApi — рабочая директория и корень workspace (ADR-075)', () => {
  it('getWorkspaceSetting / setWorkspaceSetting: GET и PUT /settings/workspace', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ workspace: '/ws' }))
    await synthApi.getWorkspaceSetting()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/settings/workspace', expect.objectContaining({}))

    await synthApi.setWorkspaceSetting('/ws/new')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/workspace',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ workspace: '/ws/new' }) }),
    )
  })

  it('getWorkspaceRoot: includeHidden добавляет query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ root: '/r', entries: [] }))

    await synthApi.getWorkspaceRoot()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/fs/workspace-root', expect.objectContaining({}))

    await synthApi.getWorkspaceRoot(true)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/fs/workspace-root?includeHidden=true',
      expect.objectContaining({}),
    )
  })

  it('browseWorkspaceRoot: пустые параметры не добавляют query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ root: '/r', path: '', entries: [] }))

    await synthApi.browseWorkspaceRoot()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/fs/workspace-root/browse', expect.objectContaining({}))

    await synthApi.browseWorkspaceRoot('/abs/dir', true)
    const url = fetchMock.mock.calls[1]![0] as string
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('path')).toBe('/abs/dir')
    expect(params.get('includeHidden')).toBe('true')
  })

  it('mkdirWorkspaceRoot: confirmOutsideRoot в теле только при true', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ created: true, path: '/abs' }))

    await synthApi.mkdirWorkspaceRoot('/abs')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/fs/workspace-root/mkdir',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ path: '/abs' }) }),
    )

    await synthApi.mkdirWorkspaceRoot('/abs', true)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/fs/workspace-root/mkdir',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/abs', confirmOutsideRoot: true }),
      }),
    )
  })

  it('getWorkspacePolicy / setWorkspacePolicy / clearWorkspacePolicy', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ outsideRoot: 'confirm', isOverridden: false, defaults: 'confirm' }))
    await synthApi.getWorkspacePolicy()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/settings/workspace-policy', expect.objectContaining({}))

    await synthApi.setWorkspacePolicy({ outsideRoot: 'deny' })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/workspace-policy',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ outsideRoot: 'deny' }) }),
    )

    await synthApi.clearWorkspacePolicy()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/workspace-policy',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

describe('skillsApi — реестр и CRUD (ADR-046)', () => {
  it('getSkills: query строится только при параметрах', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ skills: [] }))
    await synthApi.getSkills()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/skills', expect.objectContaining({}))

    await synthApi.getSkills({ projectId: 'p1', diagnostics: true })
    const url = fetchMock.mock.calls[1]![0] as string
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('project_id')).toBe('p1')
    expect(params.get('diagnostics')).toBe('1')
  })

  it('getSkill: имя кодируется, projectId — в query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ name: 'x' }))

    await synthApi.getSkill('my skill', { projectId: 'p/1' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/skills/my%20skill?project_id=p%2F1',
      expect.objectContaining({}),
    )
  })

  it('createSkill / updateSkill: POST и PATCH с телами', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ name: 'x' }))

    await synthApi.createSkill({ name: 'x', description: 'd', body: 'b' })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/skills',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'x', description: 'd', body: 'b' }),
      }),
    )

    await synthApi.updateSkill('x', { description: 'd2' })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/skills/x',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ description: 'd2' }) }),
    )
  })

  it('getSkillFile: encodeFilePath сохраняет разделители пути', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ content: 'x' }))

    await synthApi.getSkillFile('my skill', 'scripts/my file.sh')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/skills/my%20skill/files/scripts/my%20file.sh',
      expect.objectContaining({}),
    )
  })

  it('putSkillFile: PUT .../files/* с телом {content}; deleteSkillFile: DELETE', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ name: 'n', path: 'a/b.txt' }))

    await synthApi.putSkillFile('n', 'a/b.txt', 'DATA')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/skills/n/files/a/b.txt',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ content: 'DATA' }) }),
    )

    await synthApi.deleteSkillFile('n', 'a/b.txt')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/skills/n/files/a/b.txt',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('reloadSkills: POST /skills/reload', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'reloaded' }))
    await synthApi.reloadSkills()
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/skills/reload', expect.objectContaining({ method: 'POST' }))
  })

  it('session/project scope: пути /sessions/:id/skills и /projects/:id/skills', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ session_id: 's1', skills: [] }))
    await synthApi.getSessionSkills('s1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/sessions/s1/skills', expect.objectContaining({}))

    await synthApi.getSessionSkillsEffective('s1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/sessions/s1/skills/effective', expect.objectContaining({}))

    const patch = { name: 'sk', enabled: false }
    await synthApi.updateSessionSkills('s1', patch)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/skills',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(patch) }),
    )

    await synthApi.getProjectSkills('p1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/projects/p1/skills', expect.objectContaining({}))

    await synthApi.updateProjectSkills('p1', { defaultOn: ['sk'] })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/projects/p1/skills',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ defaultOn: ['sk'] }) }),
    )
  })

  it('getSkillsSettings / updateSkillsSettings / resetSkillsSettings', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ disabled: { capabilities: [], tools: [] }, policy: 'auto' }))
    await synthApi.getSkillsSettings()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/settings/skills', expect.objectContaining({}))

    const input = { disabled: { capabilities: [], tools: [] }, policy: 'available' }
    await synthApi.updateSkillsSettings(input as never)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/skills',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(input) }),
    )

    await synthApi.resetSkillsSettings()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/skills',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

describe('commandsApi / skillBundlesApi (ADR-046)', () => {
  it('getCommands: query только при параметрах', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ commands: [] }))
    await synthApi.getCommands()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/commands', expect.objectContaining({}))

    await synthApi.getCommands({ projectId: 'p1', diagnostics: true })
    const url = fetchMock.mock.calls[1]![0] as string
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('project_id')).toBe('p1')
    expect(params.get('diagnostics')).toBe('1')
  })

  it('skill-bundles: GET/POST/PATCH/DELETE, имя кодируется', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ bundles: [] }))
    await synthApi.getSkillBundles()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/skill-bundles', expect.objectContaining({}))

    await synthApi.getSkillBundle('my bundle')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/skill-bundles/my%20bundle', expect.objectContaining({}))

    await synthApi.createSkillBundle({ name: 'b', skills: [] } as never)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/skill-bundles',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'b', skills: [] }) }),
    )

    // PATCH подмешивает name в тело (Omit<SkillBundle,'name'> → +name).
    await synthApi.updateSkillBundle('b', { skills: ['x'] } as never)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/skill-bundles/b',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ skills: ['x'], name: 'b' }) }),
    )

    await synthApi.deleteSkillBundle('b')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/skill-bundles/b',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
