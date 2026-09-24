import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { WorkspaceResolver } from './workspace-resolver.js';

const ROOT = resolve('/srv/synth/data/workspaces');

function makeResolver(): WorkspaceResolver {
  return new WorkspaceResolver(ROOT, async () => null);
}

describe('WorkspaceResolver.validateWorkspacePath (AD-075)', () => {
  it('относительный путь → нормализуется как есть', () => {
    const res = makeResolver().validateWorkspacePath('my-project');
    expect(res).toEqual({ ok: true, workspace: 'my-project' });
  });

  it('относительный вложенный путь с ./ → нормализуется', () => {
    const res = makeResolver().validateWorkspacePath('./nested/dir/');
    expect(res).toEqual({ ok: true, workspace: 'nested/dir' });
  });

  it('абсолютный путь внутри root → относительный (не срезает / вслепую)', () => {
    const res = makeResolver().validateWorkspacePath(join(ROOT, 'inside'));
    expect(res).toEqual({ ok: true, workspace: 'inside' });
  });

  it('абсолютный путь == root → 400', () => {
    const res = makeResolver().validateWorkspacePath(ROOT);
    expect(res).toMatchObject({ ok: false, status: 400, code: 'VALIDATION_ERROR' });
  });

  it('абсолютный путь вне root → 403 WORKSPACE_OUTSIDE_ROOT_DENIED', () => {
    const res = makeResolver().validateWorkspacePath('/etc/passwd');
    expect(res).toMatchObject({ ok: false, status: 403, code: 'WORKSPACE_OUTSIDE_ROOT_DENIED' });
  });

  it('абсолютный путь-префикс-сосед (rootfoo) → 403 (containment, не startsWith)', () => {
    const res = makeResolver().validateWorkspacePath(`${ROOT}foo`);
    expect(res).toMatchObject({ ok: false, status: 403, code: 'WORKSPACE_OUTSIDE_ROOT_DENIED' });
  });

  it('относительный traversal ../ → 403', () => {
    const res = makeResolver().validateWorkspacePath('../evil');
    expect(res).toMatchObject({ ok: false, status: 403, code: 'WORKSPACE_OUTSIDE_ROOT_DENIED' });
  });

  it('пустой путь → 400', () => {
    const res = makeResolver().validateWorkspacePath('   ');
    expect(res).toMatchObject({ ok: false, status: 400, code: 'VALIDATION_ERROR' });
  });
});
