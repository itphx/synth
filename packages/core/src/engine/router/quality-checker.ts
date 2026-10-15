/**
 * QualityChecker — проверка качества ответа LLM (ADR-034).
 * Двухэтапная проверка: min_length, constraint, self_check.
 * Этапы вызываются последовательно, при первом FAIL — останавливаемся.
 */

import type { BaseProvider } from '../../providers/base.js';
import { t as sm } from '../system-messages.js';
import { warning } from '../../logger.js';

export interface QualityCheckInput {
  content: string;
  checks: ('min_length' | 'constraint' | 'self_check')[];
  minLength: number;
  provider?: BaseProvider;
}

export interface QualityCheckResult {
  pass: boolean;
  reason: string;
  checkResults: { check: string; pass: boolean; detail: string }[];
}

export class QualityChecker {
  async check(input: QualityCheckInput): Promise<QualityCheckResult> {
    const { content, checks, minLength, provider } = input;
    const results: QualityCheckResult['checkResults'] = [];

    for (const check of checks) {
      switch (check) {
        case 'min_length': {
          const passed = content.length >= minLength;
          const detail = passed
            ? sm('qc.min_length_ok', { length: String(content.length), min: String(minLength) })
            : sm('qc.min_length_fail_detail', { min: String(minLength), length: String(content.length) });
          results.push({ check: 'min_length', pass: passed, detail });
          if (!passed) {
            return { pass: false, reason: sm('qc.min_length_fail', { min: String(minLength) }), checkResults: results };
          }
          break;
        }

        case 'constraint': {
          const trimmed = content.trim();
          const errorPatterns = [
            /^{[ \n]*"error"/mi,
            /^{[ \n]*"message"[ \n]*:[ \n]*"error"/mi,
            /^Error:/mi,
          ];
          let constraintPass = trimmed.length > 0;
          let constraintDetail = '';

          if (!constraintPass) {
            constraintDetail = sm('qc.constraint_empty');
          } else {
            for (const pattern of errorPatterns) {
              if (pattern.test(trimmed)) {
                constraintPass = false;
                constraintDetail = sm('qc.constraint_parse_error', { snippet: trimmed.slice(0, 100) });
                break;
              }
            }
            if (constraintPass) {
              constraintDetail = sm('qc.constraint_ok');
            }
          }

          results.push({ check: 'constraint', pass: constraintPass, detail: constraintDetail });
          if (!constraintPass) {
            return { pass: false, reason: constraintDetail, checkResults: results };
          }
          break;
        }

        case 'self_check': {
          if (!provider) {
            results.push({
              check: 'self_check',
              pass: true,
              detail: sm('qc.self_check_skipped'),
            });
            break;
          }

          try {
            const selfCheckPrompt = `Rate the quality of this answer on a scale of 1-10. Reply with the number only.\n\nAnswer: ${content}`;
            const messages = [
              {
                id: '',
                role: 'user',
                content: selfCheckPrompt,
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                disabled: false,
                pinned: false,
                branchId: '',
              },
            ];

            const response = await provider.chat(messages, undefined, undefined, false);
            const scoreStr = response.content.trim();
            const score = parseInt(scoreStr, 10);

            if (isNaN(score)) {
              results.push({
                check: 'self_check',
                pass: true,
                detail: sm('qc.self_check_unparsed', { score: scoreStr.slice(0, 50) }),
              });
            } else if (score < 5) {
              results.push({
                check: 'self_check',
                pass: false,
                detail: sm('qc.self_check_low', { score: String(score) }),
              });
              return {
                pass: false,
                reason: sm('qc.self_check_low_reason', { score: String(score) }),
                checkResults: results,
              };
            } else {
              results.push({
                check: 'self_check',
                pass: true,
                detail: sm('qc.self_check_ok', { score: String(score) }),
              });
            }
          } catch (err) {
            warning('ROUTER', `Self-check failed: ${err}`);
            results.push({
              check: 'self_check',
              pass: true,
              detail: sm('qc.self_check_error', { error: String(err).slice(0, 100) }),
            });
          }
          break;
        }
      }
    }

    return { pass: true, reason: sm('qc.all_passed'), checkResults: results };
  }
}
