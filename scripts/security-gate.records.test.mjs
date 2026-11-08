/**
 * Тесты приёмки машинных правил записи аудита (`scripts/security-gate.mjs --lint-records`).
 *
 * Фикстуры — во временном каталоге (`os.tmpdir()`), реальные записи/политика не меняются.
 * `--root` — настоящий репозиторий: гейт проверяет, что `record.commit` — предок HEAD и что
 * `artifacts.ci_run` содержит sha коммита из линии истории записи; фиктивный commit в tmp-каталоге
 * дал бы только предупреждение «commit отсутствует в локальной истории».
 *
 * Запуск: node --test scripts/security-gate.records.test.mjs
 *         (pnpm security:records:test)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = resolve(REPO_ROOT, 'scripts/security-gate.mjs');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).trim();

/** Временный каталог: policy.json + releases/<version>.json. */
function makeFixture(record) {
  const dir = mkdtempSync(join(tmpdir(), 'synth-security-records-'));
  const recordsDir = join(dir, 'releases');
  mkdirSync(recordsDir, { recursive: true });
  const policyPath = join(dir, 'policy.json');
  writeFileSync(
    policyPath,
    `${JSON.stringify(
      {
        schema: 'synth.security.policy/v1',
        recordDir: recordsDir,
        requiredCheckIds: ['dependencies'],
        authMatrix: { files: ['dummy-matrix.test.ts'], minFiles: 1, minTests: 1 },
        secretScan: { modes: ['worktree'] },
        dependencies: {
          mode: 'ratchet',
          profile: 'post-upgrade',
          countsRequiredFrom: '0.13.4',
          profiles: { 'post-upgrade': { baseline: { critical: 0, high: 0 }, failOnDirect: true } },
        },
        recordCiRun: { requireCommitMatchFrom: '0.13.5' },
        recordWording: { requireObservableFrom: '0.13.4' },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(recordsDir, '0.13.4.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { dir, policyPath };
}

/** Валидная (для машинных правил) запись; тесты точечно ломают одно поле. */
function record({
  result = 'pnpm audit --json: critical 0, high 0 (--prod 0/0/0/0)',
  counts = { critical: 0, high: 0 },
} = {}) {
  return {
    schema: 'synth.security.audit/v1',
    version: '0.13.4',
    commit: HEAD,
    date: '2026-11-08',
    auditor: { name: 'fixture-auditor', role: 'AUDITOR', mode: 'read-only' },
    status: 'approved',
    summary: 'Фикстура для тестов машинных правил записи.',
    checks: {
      dependencies: {
        status: 'pass',
        command: 'pnpm audit --json',
        counts,
        result,
        date: '2026-11-08',
      },
    },
    artifacts: {
      evidence: 'tmp/security/evidence.json',
      ci_run: `2012022 — ci.yaml, commit ${HEAD}, success (14/14)`,
    },
  };
}

function lint(policyPath) {
  const res = spawnSync(
    process.execPath,
    [GATE, '--lint-records', '--root', REPO_ROOT, '--policy', policyPath],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return { status: res.status, output: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
}

test('запись с «ожидается» в result отвергается (exit 1)', () => {
  const { dir, policyPath } = makeFixture(
    record({ result: 'Гейт пройден; после этого коммита ожидается зелёный прогон обоих workflow' }),
  );
  try {
    const { status, output } = lint(policyPath);
    assert.equal(status, 1, output);
    assert.match(output, /предположительная формулировка/);
    assert.match(output, /checks\.dependencies\.result/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('counts.high больше baseline.high → exit 1', () => {
  const { dir, policyPath } = makeFixture(record({ counts: { critical: 0, high: 3 } }));
  try {
    const { status, output } = lint(policyPath);
    assert.equal(status, 1, output);
    assert.match(output, /превышает baseline/);
    assert.match(output, /counts\.high=3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('с 0.13.5 прогон не на коммите записи — ошибка (exit 1)', () => {
  const prev = execFileSync('git', ['rev-parse', 'HEAD~1'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const fixture = record();
  fixture.version = '0.13.5';
  fixture.artifacts.ci_run = `2012022 — ci.yaml, commit ${prev}, success (14/14)`;
  const { dir, policyPath } = makeFixture(fixture);
  try {
    const { status, output } = lint(policyPath);
    assert.equal(status, 1, output);
    assert.match(output, /прогон не на коммите записи/);
    assert.match(output, /требуется совпадение sha с record\.commit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('корректная запись проходит (exit 0)', () => {
  const { dir, policyPath } = makeFixture(record());
  try {
    const { status, output } = lint(policyPath);
    assert.equal(status, 0, output);
    assert.match(output, /\[OK {2}\] 0\.13\.4\.json/);
    assert.match(output, /с ошибками: 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
