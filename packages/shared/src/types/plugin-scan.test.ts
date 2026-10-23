/**
 * PROP-068 §4.2/§4.3 + ADR-090: тесты контрактов сканера расширений.
 *
 * Проверяется канон, на который опираются ядро и UI:
 * - матрица `severity → verdict` (границы вердикта);
 * - вердикт бандла = **максимум** severity по находкам;
 * - квоты структуры и их влияние на вердикт;
 * - матрица install-policy (`trust × verdict`) и её новая ячейка
 *   `kind: 'plugin'` (ADR-090).
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLUGIN_SCAN_QUOTAS,
  INSTALL_POLICY_ACTIONS,
  INSTALL_POLICY_TRUST_LEVELS,
  PLUGIN_SCAN_CATEGORIES,
  PLUGIN_SCAN_QUOTA_SEVERITIES,
  PLUGIN_SCAN_QUOTAS,
  PLUGIN_SCAN_SEVERITIES,
  PLUGIN_SCAN_SEVERITY_VERDICTS,
  installPolicyDecision,
  severityToVerdict,
  verdictFromFindings,
  verdictRank,
} from './plugin-scan.js';
import type {
  InstallPolicyAction,
  InstallPolicyTrustLevel,
  PluginScanFinding,
  PluginScanSeverity,
} from './plugin-scan.js';
import type { PluginScanVerdict } from './plugin-audit.js';

/** Находка заданной серьёзности. */
function finding(severity: PluginScanSeverity, file = 'a.js'): PluginScanFinding {
  return { category: 'injection', severity, file, line: 1, description: 'тестовая находка' };
}

describe('PLUGIN_SCAN_CATEGORIES — оси классификации находок', () => {
  it('шесть базовых категорий + invisible_unicode', () => {
    expect(PLUGIN_SCAN_CATEGORIES).toEqual([
      'exfiltration',
      'injection',
      'destructive',
      'persistence',
      'network',
      'obfuscation',
      'invisible_unicode',
    ]);
  });
});

describe('матрица severity → verdict (PROP-068 §4.3)', () => {
  it('все severity имеют свой вердикт', () => {
    expect(Object.keys(PLUGIN_SCAN_SEVERITY_VERDICTS).sort()).toEqual(
      [...PLUGIN_SCAN_SEVERITIES].sort(),
    );
  });

  it('границы вердиктов: info|low → safe, medium → caution, high|critical → dangerous', () => {
    expect(severityToVerdict('info')).toBe('safe');
    expect(severityToVerdict('low')).toBe('safe');
    expect(severityToVerdict('medium')).toBe('caution');
    expect(severityToVerdict('high')).toBe('dangerous');
    expect(severityToVerdict('critical')).toBe('dangerous');
  });

  it('таблица совпадает с функцией severityToVerdict', () => {
    for (const severity of PLUGIN_SCAN_SEVERITIES) {
      expect(PLUGIN_SCAN_SEVERITY_VERDICTS[severity], severity).toBe(severityToVerdict(severity));
    }
  });

  it('ранг вердикта упорядочен: safe < caution < dangerous', () => {
    expect(verdictRank('safe')).toBeLessThan(verdictRank('caution'));
    expect(verdictRank('caution')).toBeLessThan(verdictRank('dangerous'));
  });
});

describe('verdictFromFindings — вердикт = максимум severity', () => {
  it('находок нет → safe', () => {
    expect(verdictFromFindings([])).toBe('safe');
  });

  it('только info/low → safe', () => {
    expect(verdictFromFindings([finding('info'), finding('low')])).toBe('safe');
  });

  it('medium → caution', () => {
    expect(verdictFromFindings([finding('info'), finding('medium')])).toBe('caution');
  });

  it('high/critical → dangerous', () => {
    expect(verdictFromFindings([finding('high')])).toBe('dangerous');
    expect(verdictFromFindings([finding('critical')])).toBe('dangerous');
  });

  it('порядок находок не влияет на вердикт', () => {
    const a = verdictFromFindings([finding('info'), finding('critical'), finding('low')]);
    const b = verdictFromFindings([finding('critical'), finding('low'), finding('info')]);
    expect(a).toBe('dangerous');
    expect(a).toBe(b);
  });
});

describe('квоты структуры бандла (PROP-068 §4.3)', () => {
  it('канонические значения квот', () => {
    expect(PLUGIN_SCAN_QUOTAS).toEqual({
      maxFileCount: 50,
      maxTotalSizeKb: 1024,
      maxSingleFileKb: 256,
    });
  });

  it('квоты по умолчанию совпадают с каноном', () => {
    expect(DEFAULT_PLUGIN_SCAN_QUOTAS).toEqual(PLUGIN_SCAN_QUOTAS);
  });

  it('превышение числа файлов/суммарного размера → понижение вердикта до caution', () => {
    expect(severityToVerdict(PLUGIN_SCAN_QUOTA_SEVERITIES.fileCount)).toBe('caution');
    expect(severityToVerdict(PLUGIN_SCAN_QUOTA_SEVERITIES.totalSize)).toBe('caution');
  });

  it('превышение размера одного файла → повышение вердикта до dangerous', () => {
    expect(severityToVerdict(PLUGIN_SCAN_QUOTA_SEVERITIES.singleFile)).toBe('dangerous');
  });

  it('находка нарушения квоты сама даёт соответствующий вердикт', () => {
    expect(verdictFromFindings([finding(PLUGIN_SCAN_QUOTA_SEVERITIES.fileCount)])).toBe('caution');
    expect(verdictFromFindings([finding(PLUGIN_SCAN_QUOTA_SEVERITIES.singleFile)])).toBe('dangerous');
  });
});

describe('installPolicyDecision — матрица trust × verdict (PROP-068 §4.2)', () => {
  /** Ожидаемая матрица для контент-паков (канон PROP-068 §4.2). */
  const CONTENT_MATRIX: Record<
    InstallPolicyTrustLevel,
    Record<PluginScanVerdict, InstallPolicyAction>
  > = {
    builtin: { safe: 'allow', caution: 'allow', dangerous: 'allow' },
    verified: { safe: 'allow', caution: 'allow', dangerous: 'block' },
    trusted: { safe: 'allow', caution: 'allow', dangerous: 'block' },
    community: { safe: 'allow', caution: 'block', dangerous: 'block' },
    'agent-created': { safe: 'allow', caution: 'allow', dangerous: 'ask' },
  };

  it('все ячейки матрицы совпадают с каноном', () => {
    for (const trust of INSTALL_POLICY_TRUST_LEVELS) {
      for (const verdict of ['safe', 'caution', 'dangerous'] as const) {
        expect(installPolicyDecision({ trust, verdict }), `${trust}/${verdict}`).toBe(
          CONTENT_MATRIX[trust][verdict],
        );
      }
    }
  });

  it('kind по умолчанию — content', () => {
    expect(installPolicyDecision({ trust: 'community', verdict: 'caution' })).toBe('block');
  });

  it('неизвестный уровень доверия → fail-closed (как community)', () => {
    const unknown = 'unknown-level' as InstallPolicyTrustLevel;
    expect(installPolicyDecision({ trust: unknown, verdict: 'safe' })).toBe('allow');
    expect(installPolicyDecision({ trust: unknown, verdict: 'caution' })).toBe('block');
    expect(installPolicyDecision({ trust: unknown, verdict: 'dangerous' })).toBe('block');
  });
});

describe('installPolicyDecision — ячейка kind: plugin (ADR-090)', () => {
  it('safe → allow, caution → ask, dangerous → block', () => {
    expect(installPolicyDecision({ trust: 'trusted', verdict: 'safe', kind: 'plugin' })).toBe('allow');
    expect(installPolicyDecision({ trust: 'trusted', verdict: 'caution', kind: 'plugin' })).toBe('ask');
    expect(installPolicyDecision({ trust: 'trusted', verdict: 'dangerous', kind: 'plugin' })).toBe(
      'block',
    );
  });

  it('ячейка не зависит от уровня доверия', () => {
    for (const trust of INSTALL_POLICY_TRUST_LEVELS) {
      expect(installPolicyDecision({ trust, verdict: 'safe', kind: 'plugin' }), trust).toBe('allow');
      expect(installPolicyDecision({ trust, verdict: 'caution', kind: 'plugin' }), trust).toBe('ask');
      expect(installPolicyDecision({ trust, verdict: 'dangerous', kind: 'plugin' }), trust).toBe(
        'block',
      );
    }
  });

  it('неизвестный уровень доверия не ослабляет fail-closed', () => {
    const unknown = 'unknown-level' as InstallPolicyTrustLevel;
    expect(installPolicyDecision({ trust: unknown, verdict: 'dangerous', kind: 'plugin' })).toBe(
      'block',
    );
    expect(installPolicyDecision({ trust: unknown, verdict: 'caution', kind: 'plugin' })).toBe('ask');
  });
});

describe('реестры install-policy', () => {
  it('действия — allow/ask/block', () => {
    expect(INSTALL_POLICY_ACTIONS).toEqual(['allow', 'ask', 'block']);
  });

  it('уровни доверия включают agent-created (ячейка матрицы обязательна)', () => {
    expect(INSTALL_POLICY_TRUST_LEVELS).toEqual([
      'builtin',
      'verified',
      'trusted',
      'community',
      'agent-created',
    ]);
  });
});
