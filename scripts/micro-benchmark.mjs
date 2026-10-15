/**
 * Micro-benchmark для микро-слоя ADR-035 (RulesModel + TaskClassifier).
 *
 * Запуск: npx tsx scripts/micro-benchmark.mjs
 *
 * Прогоняет фиксированный набор запросов и выводит:
 *   запрос | task_class | уровень | confidence | latency_ms
 *
 * В конце — сводка: обработано микро / fallback / средняя latency /
 * распределение по уровням.
 *
 * Не падает, если embedding или micro-llm не смогли загрузиться —
 * тестируется только rules-слой.
 */
import { DictionaryStore } from '../packages/core/src/engine/router/dictionary-store.js';
import { TaskClassifier } from '../packages/core/src/engine/router/micro/task-classifier.js';
import { RulesModel } from '../packages/core/src/engine/router/micro/models/rules-model.js';
import { performance } from 'node:perf_hooks';

// ── Тестовые запросы ──────────────────────────────────────────
const QUERIES = [
  // Простые (small_talk + enum_decision)
  { msg: 'привет',              expectedLevel: 'small_talk' },
  { msg: 'спасибо',             expectedLevel: 'small_talk' },
  { msg: 'да',                  expectedLevel: 'enum_decision' },
  { msg: 'пока',                expectedLevel: 'small_talk' },
  { msg: 'здравствуйте',       expectedLevel: 'small_talk' },
  { msg: 'нет',                 expectedLevel: 'enum_decision' },
  { msg: 'ок',                  expectedLevel: 'enum_decision' },
  { msg: 'хорошо',             expectedLevel: 'enum_decision' },
  { msg: 'утверждаю',           expectedLevel: 'enum_decision' },
  { msg: 'отклоняю',            expectedLevel: 'enum_decision' },
  { msg: 'спланируй архитектуру', expectedLevel: 'enum_decision' },
  { msg: 'до свидания',         expectedLevel: 'small_talk' },
  { msg: 'добрый день',         expectedLevel: 'small_talk' },
  { msg: 'thx',                 expectedLevel: 'small_talk' },
  { msg: 'bye',                 expectedLevel: 'small_talk' },

  // Пограничные (classify)
  { msg: 'как исправить баг в auth.ts', expectedLevel: 'classify' },
  { msg: 'нужен ревью',                  expectedLevel: 'classify' },
  { msg: 'что такое замыкание в JS',     expectedLevel: 'classify' },
  { msg: 'почему падает сборка',         expectedLevel: 'classify' },
  { msg: 'как работает GC в Python',     expectedLevel: 'classify' },

  // Сложные (llm_task — уходит в роутер)
  { msg: 'напиши тест для функции sum',  expectedLevel: 'llm_task' },
  { msg: 'реализуй OAuth',              expectedLevel: 'llm_task' },
  { msg: 'найди ошибку в этом коде',    expectedLevel: 'llm_task' },
  { msg: 'рефакторинг модуля auth',      expectedLevel: 'llm_task' },
  { msg: 'hello world',                 expectedLevel: 'small_talk' },
];

// ── Хелпер — создание MicroInput ─────────────────────────────
function makeInput(msg, lang = 'ru') {
  return {
    userMessage: msg,
    language: lang,
    sessionSettings: {
      temperature: 0.7, maxTokens: 4096, debugEnabled: false, streamEnabled: true,
      contextOptimization: 'none', slidingWindowMode: 'messages', slidingWindowMessageLimit: 10,
      slidingWindowTokenThreshold: 80, summarizationEnabled: false, summarizationTriggerMode: 'messages',
      summarizeAfterN: 10, summarizeTokenThreshold: 50, summarizationHeadMessages: 2,
      summarizationTailMessages: 3, showInterview: true, websocketEnabled: true,
      routingEnabled: true, routingStrategy: 'auto',
      routingContent: { coding: { provider: '', model: '' }, chat: { provider: '', model: '' }, research: { provider: '', model: '' } },
      routingEscalation: { enabled: true, fallbackProvider: '', fallbackModel: '', checks: ['min_length', 'constraint'], minLength: 10 },
      routingCost: { enabled: false, cheapProvider: '', cheapModel: '', maxCheapTokens: 500 },
      subagentRouting: { enabled: true },
      microFirst: true, microConfidenceThreshold: 0.8,
    },
  };
}

// ── Инициализация ─────────────────────────────────────────────
const dict = new DictionaryStore('/tmp/synth-micro-benchmark');
const classifier = new TaskClassifier(dict);
const rulesModel = new RulesModel(classifier);

// ── Таблица результатов ───────────────────────────────────────
const COLS = ['Запрос', 'Task Class', 'Уровень', 'Label', 'Confidence', 'Latency (ms)'];
const WIDTHS = [30, 14, 14, 14, 12, 14];

function pad(s, w) {
  return String(s).padEnd(w).slice(0, w);
}

function hr() {
  return WIDTHS.map((w, i) => (i === 0 ? '─'.repeat(w) : '─'.repeat(w + 2))).join('');
}

console.log('');
console.log(WIDTHS.map((w, i) => pad(COLS[i], w)).join(' | '));
console.log(hr());

// ── Прогон ────────────────────────────────────────────────────
const results = [];
let microHandled = 0;
let fallbackCount = 0;
let totalMicroLatency = 0;
const levelCounts = {};

for (const { msg, expectedLevel } of QUERIES) {
  const startNs = performance.now();
  const input = makeInput(msg);

  // Шаг 1: классификация
  const clsOut = classifier.classify(input);
  const taskClass = clsOut.taskClass;

  // Определяем уровень обработки
  let level;
  let label = '-';
  let confidence = '-';
  let latencyMs;

  if (taskClass === 'llm_task') {
    level = 'llm';
    fallbackCount++;
    latencyMs = Math.round((performance.now() - startNs) * 100) / 100;
  } else {
    // Шаг 2: обработка RulesModel
    const result = await rulesModel.handle(input, taskClass);

    if (result.status === 'OK') {
      level = 'micro';
      microHandled++;
      totalMicroLatency += result.latencyMs;
    } else {
      level = 'micro → LLM';
      fallbackCount++;
    }
    label = result.label || '-';
    confidence = result.confidence.toFixed(2);
    latencyMs = result.latencyMs;
  }

  levelCounts[level] = (levelCounts[level] || 0) + 1;

  const row = [msg, taskClass, level, label, confidence, latencyMs];
  results.push(row);

  console.log(WIDTHS.map((w, i) => pad(String(row[i]), w)).join(' | '));
}

// ── Сводка ────────────────────────────────────────────────────
console.log(hr());
console.log('');
console.log('═══════════════════════════════════════════');
console.log('              СВОДКА');
console.log('═══════════════════════════════════════════');
console.log(`Всего запросов:           ${QUERIES.length}`);
console.log(`Обработано микро (OK):    ${microHandled} (${(microHandled / QUERIES.length * 100).toFixed(1)}%)`);
console.log(`Fallback (LLM):           ${fallbackCount} (${(fallbackCount / QUERIES.length * 100).toFixed(1)}%)`);
console.log(`Средняя latency (микро):  ${microHandled > 0 ? (totalMicroLatency / microHandled).toFixed(2) + ' ms' : 'N/A'}`);
console.log('');
console.log('Распределение по уровням:');
for (const [lvl, cnt] of Object.entries(levelCounts).sort()) {
  const pct = (cnt / QUERIES.length * 100).toFixed(1);
  console.log(`  ${lvl.padEnd(16)} ${String(cnt).padStart(3)} (${pct}%)`);
}

// ── Проверка корректности ─────────────────────────────────────
console.log('');
console.log('Проверка классификации:');
let correct = 0;
let incorrect = 0;
for (let i = 0; i < QUERIES.length; i++) {
  const { msg, expectedLevel } = QUERIES[i];
  const actual = results[i][1]; // taskClass
  if (actual === expectedLevel) {
    correct++;
  } else {
    incorrect++;
    console.log(`  ✗ "${msg}" → ожидался ${expectedLevel}, получен ${actual}`);
  }
}
console.log(`  Совпадений: ${correct}/${QUERIES.length} (${(correct / QUERIES.length * 100).toFixed(1)}%)`);
console.log('');
