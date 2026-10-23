/**
 * PROP-108 Ф1: тесты контента полномочий — `provides.authority` пакета.
 *
 * Проверяются три доменных примера из PROP-108 §«Доменная нейтральность»
 * (разработка ПО / клинические процессы / финансы и закупки) и отказ на
 * неизвестном действии/цели/роли (строгая схема + кросс-валидация).
 */
import { describe, expect, it } from 'vitest';

import { validateAuthorityContent } from './authority.js';
import { validatePackManifest, packManifestSchema } from './pack.js';

/** Манифест пакета с контентом полномочий (`kind: 'pack'`, `packType: 'policies'`). */
function manifestWithAuthority(authority: unknown): Record<string, unknown> {
  return {
    name: 'domain-authority',
    version: '0.1.0',
    kind: 'pack',
    packType: 'policies',
    description: 'Доменные роли и действия',
    provides: { authority },
  };
}

describe('provides.authority — доменные примеры из PROP-108', () => {
  it('разработка ПО: действия/цели/роли принимаются', () => {
    const manifest = manifestWithAuthority({
      actions: [
        { id: 'read', mutating: false, requires: [] },
        { id: 'write', mutating: true, requires: [] },
        { id: 'execute', mutating: true, requires: [] },
        { id: 'commit', mutating: true, requires: ['write'] },
        { id: 'publish', mutating: true, requires: [] },
      ],
      roles: [
        {
          id: 'developer',
          domain: 'software',
          grants: [
            { action: 'read', targetPattern: 'path:src/**', effect: 'allow' },
            { action: 'write', targetPattern: 'path:src/**', effect: 'allow' },
            { action: 'execute', targetPattern: 'workspace:**', effect: 'allow' },
            { action: 'commit', targetPattern: 'path:.git', effect: 'allow' },
          ],
        },
        {
          id: 'reviewer',
          domain: 'software',
          grants: [
            { action: 'read', targetPattern: 'path:src/**', effect: 'allow' },
            { action: 'publish', targetPattern: 'external:registry/*', effect: 'ask' },
          ],
        },
        {
          id: 'release-manager',
          domain: 'software',
          grants: [
            { action: 'publish', targetPattern: 'external:registry/*', effect: 'allow' },
            { action: 'read', targetPattern: 'mcp:git/*', effect: 'allow' },
          ],
        },
      ],
      targets: [],
      agents: [{ id: 'dev-assistant', roles: ['developer'], ceiling: ['read', 'write'] }],
    });

    const parsed = packManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);

    const problems = validatePackManifest(manifest);
    expect(problems).toEqual([]);
  });

  it('клинические процессы: доменные цели `record`/`document` объявляются', () => {
    const manifest = manifestWithAuthority({
      actions: [
        { id: 'read', mutating: false, requires: [] },
        { id: 'write', mutating: true, requires: [] },
        { id: 'sign', mutating: true, requires: ['write'] },
        { id: 'approve', mutating: true, requires: [] },
        { id: 'delegate', mutating: true, requires: [] },
      ],
      roles: [
        {
          id: 'clinician',
          domain: 'clinic',
          grants: [
            { action: 'read', targetPattern: 'record:*', effect: 'allow' },
            {
              action: 'write',
              targetPattern: 'record:*',
              effect: 'allow',
              constraints: { requireConfirm: true },
            },
            { action: 'sign', targetPattern: 'document:*', effect: 'allow' },
          ],
        },
        {
          id: 'nurse',
          domain: 'clinic',
          grants: [
            { action: 'read', targetPattern: 'record:*', effect: 'allow' },
            { action: 'write', targetPattern: 'record:*', effect: 'ask' },
          ],
        },
        {
          id: 'registrar',
          domain: 'clinic',
          grants: [
            { action: 'approve', targetPattern: 'document:*', effect: 'allow' },
            { action: 'delegate', targetPattern: 'record:*', effect: 'allow' },
          ],
        },
      ],
      targets: [
        { kind: 'record', resolver: 'clinic:patient-record' },
        { kind: 'document', resolver: 'clinic:document' },
      ],
      agents: [{ id: 'clinic-assistant', roles: ['clinician'], ceiling: ['read'] }],
    });

    const parsed = packManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);

    expect(validatePackManifest(manifest)).toEqual([]);
  });

  it('финансы и закупки: `invoice`/`payment`/`report` — доменные цели', () => {
    const manifest = manifestWithAuthority({
      actions: [
        { id: 'read', mutating: false, requires: [] },
        { id: 'approve', mutating: true, requires: [] },
        { id: 'execute', mutating: true, requires: [] },
        { id: 'publish', mutating: true, requires: [] },
      ],
      roles: [
        {
          id: 'accountant',
          domain: 'finance',
          grants: [
            { action: 'read', targetPattern: 'invoice:*', effect: 'allow' },
            { action: 'read', targetPattern: 'report:*', effect: 'allow' },
          ],
        },
        {
          id: 'controller',
          domain: 'finance',
          grants: [
            { action: 'approve', targetPattern: 'invoice:*', effect: 'allow' },
            { action: 'read', targetPattern: 'report:*', effect: 'allow' },
          ],
        },
        {
          id: 'treasurer',
          domain: 'finance',
          grants: [
            { action: 'execute', targetPattern: 'payment:*', effect: 'allow' },
            { action: 'publish', targetPattern: 'report:*', effect: 'allow' },
          ],
        },
      ],
      targets: [
        { kind: 'invoice', resolver: 'finance:invoice' },
        { kind: 'payment', resolver: 'finance:payment' },
        { kind: 'report', resolver: 'finance:report' },
      ],
      agents: [],
    });

    const parsed = packManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);

    expect(validatePackManifest(manifest)).toEqual([]);
  });
});

describe('provides.authority — отказ на неизвестном', () => {
  it('грант на незаявленное действие → проблема', () => {
    const problems = validateAuthorityContent({
      actions: [{ id: 'read', mutating: false, requires: [] }],
      roles: [
        {
          id: 'clinician',
          domain: 'clinic',
          grants: [{ action: 'sign', targetPattern: 'document:*', effect: 'allow' }],
        },
      ],
      targets: [{ kind: 'document' }],
    });

    expect(problems.join('\n')).toContain('неизвестное действие «sign»');
  });

  it('грант на незаявленный вид цели → проблема', () => {
    const problems = validateAuthorityContent({
      actions: [{ id: 'read', mutating: false, requires: [] }],
      roles: [
        {
          id: 'clinician',
          domain: 'clinic',
          grants: [{ action: 'read', targetPattern: 'record:*', effect: 'allow' }],
        },
      ],
      targets: [],
    });

    expect(problems.join('\n')).toContain('неизвестный вид цели «record»');
  });

  it('агент на незаявленную роль → проблема', () => {
    const problems = validateAuthorityContent({
      actions: [{ id: 'read', mutating: false, requires: [] }],
      roles: [],
      targets: [],
      agents: [{ id: 'clinic-assistant', roles: ['clinician'] }],
    });

    expect(problems.join('\n')).toContain('неизвестная роль «clinician»');
  });

  it('манифест с неизвестным действием в `provides.authority` не проходит валидацию', () => {
    const problems = validatePackManifest(
      manifestWithAuthority({
        actions: [{ id: 'read', mutating: false, requires: [] }],
        roles: [
          {
            id: 'clinician',
            domain: 'clinic',
            grants: [{ action: 'sign', targetPattern: 'document:*', effect: 'allow' }],
          },
        ],
        targets: [{ kind: 'document' }],
        agents: [],
      }),
    );

    expect(problems.join('\n')).toContain('неизвестное действие «sign»');
  });

  it('лишний ключ в `provides.authority` → ошибка разбора (строгая схема)', () => {
    const parsed = packManifestSchema.safeParse(
      manifestWithAuthority({
        actions: [],
        roles: [],
        targets: [],
        agents: [],
        unexpected: true,
      }),
    );

    expect(parsed.success).toBe(false);
  });
});
