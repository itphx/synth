import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TerminalDto } from '@/lib/api/terminals'

const apiMock = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  input: vi.fn(),
  resize: vi.fn(),
  update: vi.fn(),
  close: vi.fn(),
  outputSince: vi.fn(),
}

vi.mock('@/lib/api/terminals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/terminals')>()
  return { ...actual, terminalsApi: apiMock }
})

const { useTerminalsStore, selectTerminal, selectTerminalList } = await import('./terminalsStore')

function terminal(overrides: Partial<TerminalDto> = {}): TerminalDto {
  return {
    id: 't1',
    projectId: 'p1',
    sessionId: null,
    ownerId: 'local',
    cwd: '/work',
    shell: '/bin/bash',
    status: 'running',
    cols: 80,
    rows: 24,
    title: null,
    can_write: true,
    attached_clients: 1,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    exitCode: null,
    signal: null,
    target: 'inline',
    ...overrides,
  }
}

/** Страница списка терминалов (сервер отдаёт объект-страницу). */
function page(terminals: TerminalDto[]) {
  return {
    terminals,
    total: terminals.length,
    offset: 0,
    limit: 50,
    nextOffset: null,
  }
}

describe('стор терминалов (PROP-132)', () => {
  beforeEach(() => {
    useTerminalsStore.setState({ terminalsById: {}, order: [], loading: false, error: null })
    vi.clearAllMocks()
  })

  it('load заполняет реестр и порядок', async () => {
    apiMock.list.mockResolvedValue(
      page([
        terminal({ id: 'a', lastActivityAt: 1_700_000_001_000 }),
        terminal({ id: 'b', lastActivityAt: 1_700_000_002_000 }),
      ]),
    )
    await useTerminalsStore.getState().load({ projectId: 'p1' })
    const state = useTerminalsStore.getState()
    expect(apiMock.list).toHaveBeenCalledWith({ projectId: 'p1' })
    expect(Object.keys(state.terminalsById).sort()).toEqual(['a', 'b'])
    // Свежие сверху.
    expect(state.order).toEqual(['b', 'a'])
  })

  it('load сохраняет ошибку', async () => {
    apiMock.list.mockRejectedValue(new Error('boom'))
    await useTerminalsStore.getState().load()
    expect(useTerminalsStore.getState().error).toBe('boom')
    expect(useTerminalsStore.getState().loading).toBe(false)
  })

  it('create добавляет терминал в начало списка', async () => {
    apiMock.create.mockResolvedValue(terminal({ id: 'new' }))
    const created = await useTerminalsStore.getState().create({ projectId: 'p1' })
    expect(created?.id).toBe('new')
    expect(useTerminalsStore.getState().order[0]).toBe('new')
  })

  it('terminal.created (плоский payload) заводит запись', () => {
    const store = useTerminalsStore.getState()
    store.applyEvent('terminal.created', {
      terminal_id: 'x',
      project_id: 'p1',
      status: 'running',
      cols: 100,
      rows: 30,
      title: 'one',
    })
    const created = selectTerminal(useTerminalsStore.getState(), 'x')
    expect(created?.id).toBe('x')
    expect(created?.projectId).toBe('p1')
    expect(created?.cols).toBe(100)
    expect(created?.title).toBe('one')
  })

  it('terminal.updated — точечный патч, не замена записи', () => {
    const store = useTerminalsStore.getState()
    store.applyEvent('terminal.created', { terminal: terminal({ id: 'x', cwd: '/work' }) })
    store.applyEvent('terminal.updated', { terminal_id: 'x', cols: 120, rows: 40 })
    const updated = selectTerminal(useTerminalsStore.getState(), 'x')
    expect(updated?.cols).toBe(120)
    expect(updated?.rows).toBe(40)
    // Поля, которых событие не несло, остались прежними.
    expect(updated?.cwd).toBe('/work')
  })

  it('terminal.exited ставит статус и код выхода', () => {
    const store = useTerminalsStore.getState()
    store.applyEvent('terminal.created', { terminal: terminal({ id: 'x' }) })
    store.applyEvent('terminal.exited', { terminal_id: 'x', exit_code: 3 })
    const exited = selectTerminal(useTerminalsStore.getState(), 'x')
    expect(exited?.status).toBe('exited')
    expect(exited?.exitCode).toBe(3)
  })

  it('terminal.deleted убирает терминал', () => {
    const store = useTerminalsStore.getState()
    store.applyEvent('terminal.created', { terminal: terminal({ id: 'x' }) })
    store.applyEvent('terminal.deleted', { terminal_id: 'x' })
    expect(selectTerminal(useTerminalsStore.getState(), 'x')).toBeUndefined()
    expect(useTerminalsStore.getState().order).not.toContain('x')
  })

  it('terminal.data не обрабатывается — потока вывода по шине нет', () => {
    const store = useTerminalsStore.getState()
    store.applyEvent('terminal.created', { terminal: terminal({ id: 'x' }) })
    store.applyEvent('terminal.data', { terminal_id: 'x', data: 'chunk' })
    // В сторе только метаданные — вывода там нет и не будет.
    expect(JSON.stringify(useTerminalsStore.getState().terminalsById)).not.toContain('chunk')
  })

  it('close убирает терминал из реестра', async () => {
    apiMock.close.mockResolvedValue(undefined)
    const store = useTerminalsStore.getState()
    store.applyEvent('terminal.created', { terminal: terminal({ id: 'x' }) })
    await useTerminalsStore.getState().close('x')
    expect(apiMock.close).toHaveBeenCalledWith('x')
    expect(selectTerminal(useTerminalsStore.getState(), 'x')).toBeUndefined()
  })

  it('селекторы отдают упорядоченный список', () => {
    const store = useTerminalsStore.getState()
    store.applyEvent('terminal.created', {
      terminal: terminal({ id: 'a', lastActivityAt: 1 }),
    })
    store.applyEvent('terminal.created', {
      terminal: terminal({ id: 'b', lastActivityAt: 2 }),
    })
    expect(selectTerminalList(useTerminalsStore.getState()).map((t) => t.id)).toEqual(['b', 'a'])
  })
})
