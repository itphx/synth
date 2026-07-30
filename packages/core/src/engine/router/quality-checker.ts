/**
 * QualityChecker — проверка качества ответа LLM (AD-034).
 * Двухэтапная проверка: min_length, constraint, self_check.
 * Этапы вызываются последовательно, при первом FAIL — останавливаемся.
 */

import type { BaseProvider } from '../../providers/base.js';
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
            ? `Длина ответа ${content.length} >= ${minLength}`
            : `Ответ короче ${minLength} символов (${content.length})`;
          results.push({ check: 'min_length', pass: passed, detail });
          if (!passed) {
            return { pass: false, reason: `Ответ короче ${minLength} символов`, checkResults: results };
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
            constraintDetail = 'Ответ пустой или содержит только пробелы';
          } else {
            for (const pattern of errorPatterns) {
              if (pattern.test(trimmed)) {
                constraintPass = false;
                constraintDetail = `Ответ содержит явную ошибку парсинга: ${trimmed.slice(0, 100)}`;
                break;
              }
            }
            if (constraintPass) {
              constraintDetail = 'Ограничения пройдены';
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
              detail: 'Self-check пропущен: провайдер не указан',
            });
            break;
          }

          try {
            const selfCheckPrompt = `Оцени качество этого ответа по шкале 1-10. Ответь только числом.\n\nОтвет: ${content}`;
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
                detail: `Не удалось распарсить оценку: "${scoreStr.slice(0, 50)}" — считаем пройденным`,
              });
            } else if (score < 5) {
              results.push({
                check: 'self_check',
                pass: false,
                detail: `Self-check оценка: ${score}/10 (порог: 5)`,
              });
              return {
                pass: false,
                reason: `Самооценка модели низкая: ${score}/10`,
                checkResults: results,
              };
            } else {
              results.push({
                check: 'self_check',
                pass: true,
                detail: `Self-check оценка: ${score}/10`,
              });
            }
          } catch (err) {
            warning('ROUTER', `Self-check failed: ${err}`);
            results.push({
              check: 'self_check',
              pass: true,
              detail: `Ошибка self-check: ${String(err).slice(0, 100)} — считаем пройденным`,
            });
          }
          break;
        }
      }
    }

    return { pass: true, reason: 'Все проверки пройдены', checkResults: results };
  }
}
