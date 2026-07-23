#!/usr/bin/env node
/**
 * UI E2E тест для Synth — проверка создания проектов и сессий через браузер.
 *
 * Использование:
 *   node test/ui-e2e.mjs [url] [api-key]
 *
 * По умолчанию: http://localhost:5002, admin-key-123
 */

const BASE_URL = process.argv[2] || 'http://localhost:5002';
const API_KEY = process.argv[3] || 'admin-key-123';
const API_URL = BASE_URL.replace(/:5002/, ':5000');

let pass = 0;
let fail = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message}`);
    fail++;
  }
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_URL}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function main() {
  console.log('=== UI E2E Smoke Tests ===\n');

  // 1. Проверка Health
  console.log('--- Backend Health ---');
  await check('GET /health returns 200', async () => {
    const { status } = await api('GET', '/health');
    if (status !== 200) throw new Error(`Got ${status}`);
  });

  // 2. Проекты: CRUD через API
  console.log('\n--- Projects API ---');
  let projectId;

  await check('POST /projects creates project', async () => {
    const { status, data } = await api('POST', '/api/v2/projects', {
      name: 'UI Test Project',
      description: 'Created by UI e2e test',
    });
    if (status !== 201) throw new Error(`Expected 201, got ${status}: ${JSON.stringify(data)}`);
    if (!data.id) throw new Error('No project id returned');
    projectId = data.id;
  });

  await check('GET /projects lists projects', async () => {
    const { status, data } = await api('GET', '/api/v2/projects');
    if (status !== 200) throw new Error(`Expected 200, got ${status}`);
    if (!Array.isArray(data)) throw new Error('Expected array');
    if (!data.find(p => p.id === projectId)) throw new Error('Created project not in list');
  });

  await check('GET /projects/:id returns project', async () => {
    const { status, data } = await api('GET', `/api/v2/projects/${projectId}`);
    if (status !== 200) throw new Error(`Expected 200, got ${status}`);
    if (data.name !== 'UI Test Project') throw new Error(`Wrong name: ${data.name}`);
  });

  await check('PUT /projects/:id updates project', async () => {
    const { status, data } = await api('PUT', `/api/v2/projects/${projectId}`, {
      name: 'Updated UI Project',
    });
    if (status !== 200) throw new Error(`Expected 200, got ${status}`);
    if (data.name !== 'Updated UI Project') throw new Error(`Wrong name: ${data.name}`);
  });

  await check('GET /projects/:id/stats returns stats', async () => {
    const { status } = await api('GET', `/api/v2/projects/${projectId}/stats`);
    if (status !== 200) throw new Error(`Expected 200, got ${status}`);
  });

  // 3. Сессии: CRUD через API
  console.log('\n--- Sessions API ---');
  let sessionId;
  let forkId;

  await check('POST /sessions creates session', async () => {
    const { status, data } = await api('POST', '/api/v2/sessions', {
      name: 'UI Test Session',
      project_id: projectId,
    });
    if (status !== 201) throw new Error(`Expected 201, got ${status}`);
    if (!data.id) throw new Error('No session id returned');
    sessionId = data.id;
  });

  await check('GET /sessions lists sessions', async () => {
    const { status, data } = await api('GET', '/api/v2/sessions');
    if (status !== 200) throw new Error(`Expected 200, got ${status}`);
    if (!Array.isArray(data)) throw new Error('Expected array');
    if (!data.find(s => s.id === sessionId)) throw new Error('Created session not in list');
  });

  await check('GET /sessions/:id returns session', async () => {
    const { status, data } = await api('GET', `/api/v2/sessions/${sessionId}`);
    if (status !== 200) throw new Error(`Expected 200, got ${status}`);
    if (data.title !== 'UI Test Session') throw new Error(`Wrong title: ${data.title}`);
  });

  await check('PATCH /sessions/:id updates title', async () => {
    const { status, data } = await api('PATCH', `/api/v2/sessions/${sessionId}`, {
      title: 'Updated Session',
    });
    if (status !== 200) throw new Error(`Expected 200, got ${status}`);
    if (data.title !== 'Updated Session') throw new Error(`Wrong title: ${data.title}`);
  });

  await check('GET /sessions/:id/status returns status', async () => {
    const { status, data } = await api('GET', `/api/v2/sessions/${sessionId}/status`);
    if (status !== 200) throw new Error(`Expected 200, got ${status}`);
    if (typeof data.blocked !== 'boolean') throw new Error('blocked should be boolean');
  });

  await check('POST /sessions/:id/fork creates fork', async () => {
    const { status, data } = await api('POST', `/api/v2/sessions/${sessionId}/fork`, {});
    if (status !== 201) throw new Error(`Expected 201, got ${status}`);
    if (!data.id) throw new Error('No fork id returned');
    if (!data.parent_id && !data.parentId) throw new Error('Fork should have parentId');
    forkId = data.id;
  });

  await check('GET /sessions/:id/children returns forks', async () => {
    const { status, data } = await api('GET', `/api/v2/sessions/${sessionId}/children`);
    if (status !== 200) throw new Error(`Expected 200, got ${status}`);
    if (!Array.isArray(data)) throw new Error('Expected array');
    if (data.length < 1) throw new Error('Should have at least 1 child');
  });

  await check('GET /sessions/:id/tree returns tree', async () => {
    const { status, data } = await api('GET', `/api/v2/sessions/${sessionId}/tree`);
    if (status !== 200) throw new Error(`Expected 200, got ${status}`);
    if (!data.session) throw new Error('Tree should have session');
    if (!Array.isArray(data.children)) throw new Error('Tree should have children');
  });

  await check('POST /sessions/:id/clear clears messages', async () => {
    const { status } = await api('POST', `/api/v2/sessions/${sessionId}/clear`);
    if (status !== 200) throw new Error(`Expected 200, got ${status}`);
  });

  // 4. Удаление
  console.log('\n--- Cleanup ---');

  await check('DELETE /sessions/:fork removes fork', async () => {
    const { status } = await api('DELETE', `/api/v2/sessions/${forkId}`);
    if (status !== 204) throw new Error(`Expected 204, got ${status}`);
  });

  await check('DELETE /sessions/:id removes session', async () => {
    const { status } = await api('DELETE', `/api/v2/sessions/${sessionId}`);
    if (status !== 204) throw new Error(`Expected 204, got ${status}`);
  });

  await check('DELETE /projects/:id removes project', async () => {
    const { status } = await api('DELETE', `/api/v2/projects/${projectId}`);
    if (status !== 204) throw new Error(`Expected 204, got ${status}`);
  });

  // 5. 404 проверки
  console.log('\n--- 404 Handling ---');

  await check('GET deleted session returns 404', async () => {
    const { status } = await api('GET', `/api/v2/sessions/${sessionId}`);
    if (status !== 404) throw new Error(`Expected 404, got ${status}`);
  });

  await check('GET deleted project returns 404', async () => {
    const { status } = await api('GET', `/api/v2/projects/${projectId}`);
    if (status !== 404) throw new Error(`Expected 404, got ${status}`);
  });

  // 6. Auth проверки
  console.log('\n--- Auth ---');

  await check('GET /projects without auth returns 401', async () => {
    const res = await fetch(`${API_URL}/api/v2/projects`);
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
