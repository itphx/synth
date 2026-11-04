import { describe, it, expect } from 'vitest';
import {
  isRemoteRef,
  toLocalId,
  toRemoteRef,
  annotateOrigin,
  rewriteRemoteItem,
  toRemote,
  mergeItems,
  remoteErrorToHttp,
  toRemoteMemoryIndex,
  toRemoteSessionMemory,
  toRemotePipeline,
  toRemotePipelinePage,
  toRemotePipelineDetail,
  toRemotePipelineRun,
  toRemotePipelineRunPage,
  toRemotePipelineRunDetail,
  toRemoteWorktree,
  toRemoteWorktreeList,
} from './aggregate.js';
import { RemoteError } from './types.js';

describe('isRemoteRef / toLocalId / toRemoteRef', () => {
  it('isRemoteRef: префикс remote: распознаётся, локальные — нет', () => {
    expect(isRemoteRef('remote:abc')).toBe(true);
    expect(isRemoteRef('remote:')).toBe(true);
    expect(isRemoteRef('abc')).toBe(false);
    expect(isRemoteRef('')).toBe(false);
  });

  it('toLocalId: снимает префикс только у remote-ссылок', () => {
    expect(toLocalId('remote:ses-1')).toBe('ses-1');
    expect(toLocalId('ses-1')).toBe('ses-1');
    expect(toLocalId('')).toBe('');
  });

  it('toRemoteRef: добавляет префикс, если его ещё нет (идемпотентность)', () => {
    expect(toRemoteRef('ses-1')).toBe('remote:ses-1');
    expect(toRemoteRef('remote:ses-1')).toBe('remote:ses-1');
  });
});

describe('annotateOrigin', () => {
  it('добавляет origin без мутации исходного объекта', () => {
    const item = { id: 'a', name: 'A' };
    const result = annotateOrigin(item, 'local');
    expect(result).toEqual({ id: 'a', name: 'A', origin: 'local' });
    expect(item).not.toHaveProperty('origin');
  });
});

describe('rewriteRemoteItem / toRemote', () => {
  it('переписывает id, project_id, parent_id, references[].session_id', () => {
    const item = {
      id: 'ses-1',
      name: 'S',
      project_id: 'prj-1',
      parent_id: 'ses-0',
      references: [{ session_id: 'ses-2', label: 'x' }, { session_id: null }],
      other: 'не трогаем',
    };
    const rewritten = rewriteRemoteItem(item);
    expect(rewritten.id).toBe('remote:ses-1');
    expect(rewritten.project_id).toBe('remote:prj-1');
    expect(rewritten.parent_id).toBe('remote:ses-0');
    expect(rewritten.references[0]!.session_id).toBe('remote:ses-2');
    // null-ссылка не переписывается
    expect(rewritten.references[1]!.session_id).toBeNull();
    expect(rewritten.other).toBe('не трогаем');
  });

  it('не переписывает уже remote-ссылки (идемпотентность)', () => {
    const item = { id: 'remote:x', project_id: 'remote:p' };
    const rewritten = rewriteRemoteItem(item);
    expect(rewritten.id).toBe('remote:x');
    expect(rewritten.project_id).toBe('remote:p');
  });

  it('toRemote: переписывает ссылки и добавляет origin: remote', () => {
    const remote = toRemote({ id: 'ses-1', project_id: 'p1' });
    expect(remote).toEqual({ id: 'remote:ses-1', project_id: 'remote:p1', origin: 'remote' });
  });

  it('пустые/отсутствующие поля не ломаются', () => {
    const remote = toRemote({ id: 'ses-1' });
    expect(remote).toEqual({ id: 'remote:ses-1', origin: 'remote' });
  });
});

describe('mergeItems', () => {
  const local = [
    { id: 'loc-1', name: 'Локальная', project_id: null },
    { id: 'loc-2', name: 'Локальная 2', project_id: 'prj-l' },
  ];
  const remote = [
    { id: 'rem-1', name: 'Удалённая', project_id: 'prj-r', parent_id: 'rem-0' },
    { id: 'rem-2', name: 'Удалённая 2', project_id: 'prj-other' },
  ];

  it('объединяет: локальные как есть + удалённые с remote-ссылками и origin', () => {
    const merged = mergeItems(local, remote);
    expect(merged).toHaveLength(4);
    expect(merged[0]).toEqual({ id: 'loc-1', name: 'Локальная', project_id: null, origin: 'local' });
    expect(merged[3]).toEqual({
      id: 'remote:rem-2',
      name: 'Удалённая 2',
      project_id: 'remote:prj-other',
      origin: 'remote',
    });
  });

  it('не мутирует исходные массивы', () => {
    mergeItems(local, remote);
    expect(local[0]).not.toHaveProperty('origin');
    expect(remote[0]!.id).toBe('rem-1');
  });

  it('remoteProjectId: фильтрует удалённые по project_id (remote-ref)', () => {
    const merged = mergeItems([], remote, { remoteProjectId: 'remote:prj-r' });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'remote:rem-1', project_id: 'remote:prj-r', origin: 'remote' });
  });

  it('remoteProjectId не влияет на локальные (их проект не remote-ref)', () => {
    const merged = mergeItems(local, remote, { remoteProjectId: 'remote:prj-l' });
    // Локальная сессия с project_id=prj-l остаётся, удалённых с remote:prj-l нет
    const localWithProject = merged.filter((m) => m.origin === 'local' && m.project_id === 'prj-l');
    expect(localWithProject).toHaveLength(1);
    const remoteWithProject = merged.filter((m) => m.origin === 'remote' && m.project_id === 'remote:prj-l');
    expect(remoteWithProject).toHaveLength(0);
  });

  it('пустые списки → пустой результат', () => {
    expect(mergeItems([], [])).toEqual([]);
  });
});

describe('remoteErrorToHttp', () => {
  it('OFFLINE → 502', () => {
    expect(remoteErrorToHttp(new RemoteError('нет связи', 'OFFLINE'))).toEqual({ status: 502, code: 'OFFLINE' });
  });

  it('UNAUTHORIZED → 401', () => {
    expect(remoteErrorToHttp(new RemoteError('нет авторизации', 'UNAUTHORIZED'))).toEqual({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('HTTP_404 → 404 с сохранением кода', () => {
    expect(remoteErrorToHttp(new RemoteError('не найдено', 'HTTP_404'))).toEqual({ status: 404, code: 'HTTP_404' });
  });

  it('не-RemoteError → null', () => {
    expect(remoteErrorToHttp(new Error('обычная ошибка'))).toBeNull();
    expect(remoteErrorToHttp('строка')).toBeNull();
  });
});

describe('camelCase-хелперы правой панели (гибрид)', () => {
  it('toRemoteMemoryIndex: id и projectId → remote:', () => {
    expect(toRemoteMemoryIndex({ id: 'idx-1', projectId: 'p-1', name: 'docs' })).toEqual({
      id: 'remote:idx-1',
      projectId: 'remote:p-1',
      name: 'docs',
    });
  });

  it('toRemoteSessionMemory: scope и индексы → remote:, origin добавляется', () => {
    const result = toRemoteSessionMemory({
      scope: { projectId: 'p-1' },
      indexes: {
        total: 1,
        items: [{ id: 'idx-1', projectId: 'p-1', scope: 'project' }],
      },
      facts: { active: 2 },
    });
    expect(result.origin).toBe('remote');
    expect(result.scope.projectId).toBe('remote:p-1');
    expect(result.indexes.items[0]!.id).toBe('remote:idx-1');
    expect(result.indexes.items[0]!.projectId).toBe('remote:p-1');
    // исходный объект не мутирован
    expect(result.facts.active).toBe(2);
  });

  it('toRemotePipeline / toRemotePipelinePage: id и projectId → remote:', () => {
    expect(toRemotePipeline({ id: 'pl-1', projectId: 'p-1' })).toEqual({
      id: 'remote:pl-1',
      projectId: 'remote:p-1',
    });
    const page = toRemotePipelinePage({
      pipelines: [{ id: 'pl-1', projectId: 'p-1' }],
      total: 1,
      offset: 0,
      limit: 100,
      next_offset: null,
    });
    expect(page.pipelines[0]!.id).toBe('remote:pl-1');
    expect(page.pipelines[0]!.projectId).toBe('remote:p-1');
    expect(page.total).toBe(1);
  });

  it('toRemotePipelineDetail: pipeline, published и versions → remote:', () => {
    const detail = toRemotePipelineDetail({
      pipeline: { id: 'pl-1', projectId: 'p-1' },
      published: { pipelineId: 'pl-1', version: 1 },
      versions: [{ pipelineId: 'pl-1', version: 1 }],
    });
    expect(detail.pipeline.id).toBe('remote:pl-1');
    expect(detail.published?.pipelineId).toBe('remote:pl-1');
    expect(detail.versions[0]!.pipelineId).toBe('remote:pl-1');
  });

  it('toRemotePipelineRun*: id/projectId/pipelineId → remote:', () => {
    expect(toRemotePipelineRun({ id: 'run-1', projectId: 'p-1', pipelineId: 'pl-1' })).toEqual({
      id: 'remote:run-1',
      projectId: 'remote:p-1',
      pipelineId: 'remote:pl-1',
    });
    const page = toRemotePipelineRunPage({ runs: [{ id: 'run-1', pipelineId: 'pl-1' }] });
    expect(page.runs[0]!.id).toBe('remote:run-1');
    const detail = toRemotePipelineRunDetail({ run: { id: 'run-1', projectId: 'p-1' }, events: [] });
    expect(detail.run?.id).toBe('remote:run-1');
    expect(detail.run?.projectId).toBe('remote:p-1');
  });

  it('toRemoteWorktreeList: projectId/attachedSessionId → remote:, id worktree не префиксуется', () => {
    const payload = toRemoteWorktreeList({
      worktrees: [{ id: 'wt-1', projectId: 'p-1', attachedSessionId: 's-1', name: 'feature' }],
    });
    expect(payload.worktrees[0]).toEqual({
      id: 'wt-1',
      projectId: 'remote:p-1',
      attachedSessionId: 'remote:s-1',
      name: 'feature',
    });
    expect(toRemoteWorktree({ id: 'wt-2', projectId: 'p-2' })).toEqual({
      id: 'wt-2',
      projectId: 'remote:p-2',
    });
  });
});
