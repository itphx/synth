#!/usr/bin/env node
/**
 * Проставляет тело GitVerse Release для тега релиза (+ best-effort ассет).
 *
 * Зачем собственный скрипт вместо actions/create-release@v1:
 *   - GitVerse сам создаёт релиз для тега в момент push тега, поэтому
 *     POST /releases для уже существующего git-тега отвечает 409 TAG_EXISTS,
 *     а action падает: «Release with tag ... not found. Creating a new one…»
 *     → 404 → «context canceled ... failed to get release from gitverse ... 404».
 *   - Загрузка ассетов через API сейчас отвечает 500 INTERNAL_ERROR, поэтому
 *     ассет (cli.js) грузится best-effort: при неудаче — предупреждение,
 *     джоба завершается успешно.
 *
 * Алгоритм: найти релиз по tag_name (с пагинацией)
 *   → найден: PATCH { name: "Release v<ver>", body }
 *   → не найден: POST /releases (tag_name, name, body, target_commitish);
 *     при 409 — повторить поиск и PATCH (гонка с авто-созданием GitVerse).
 *
 * Использование в CI (release.yaml, джоба create-release):
 *   GV_TOKEN=<token> GV_REPO=itphx/synth RELEASE_TAG=v0.10.0 \
 *     RELEASE_BODY_FILE=tmp/release-body.md RELEASE_ASSET=packages/synth/dist/cli.js \
 *     node scripts/publish-release.mjs
 *
 * Локальная проверка без мутаций:
 *   node scripts/publish-release.mjs --dry-run
 *
 * Переменные окружения:
 *   GV_TOKEN           — токен GitVerse (обязателен)
 *   GV_REPO            — owner/repo (по умолчанию itphx/synth)
 *   RELEASE_TAG        — тег релиза, напр. v0.10.0 (обязателен)
 *   RELEASE_BODY_FILE  — путь к готовому телу релиза (обязателен)
 *   RELEASE_ASSET      — необязательный ассет (имя = basename файла)
 *   RELEASE_TARGET     — target_commitish для создания (по умолчанию = тег)
 *   RELEASE_PRERELEASE — true/1 — пометить pre-release (необязательно)
 *   GV_API_URL         — базовый URL API (по умолчанию https://api.gitverse.ru)
 *
 * Коды выхода: 0 — тело релиза проставлено (или --dry-run), 1 — ошибка.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const API = process.env.GV_API_URL || 'https://api.gitverse.ru';
const repo = process.env.GV_REPO || 'itphx/synth';
const token = process.env.GV_TOKEN;
const tag = process.env.RELEASE_TAG;
const bodyFile = process.env.RELEASE_BODY_FILE;
const assetPath = process.env.RELEASE_ASSET || '';
const target = process.env.RELEASE_TARGET || tag;
const prerelease = /^(1|true|yes)$/i.test(process.env.RELEASE_PRERELEASE || '');
const dryRun = process.argv.slice(2).includes('--dry-run');
const PER_PAGE = 50;

function fail(msg) {
  console.error(`[release] ОШИБКА: ${msg}`);
  process.exit(1);
}

if (!token) fail('GV_TOKEN не задан');
if (!tag) fail('RELEASE_TAG не задан (напр. v0.10.0)');
if (!bodyFile) fail('RELEASE_BODY_FILE не задан');
if (!existsSync(bodyFile)) fail(`файл тела релиза не найден: ${bodyFile}`);

const body = readFileSync(bodyFile, 'utf8');
const releaseName = `Release ${tag}`;

let asset = null;
if (assetPath) {
  if (!existsSync(assetPath)) {
    console.warn(`[release] Предупреждение: RELEASE_ASSET ${assetPath} не найден — ассет пропущен`);
  } else {
    asset = { path: assetPath, name: basename(assetPath), buffer: readFileSync(assetPath) };
  }
}

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.gitverse.object+json;version=1',
    ...extra,
  };
}

class ApiError extends Error {
  constructor(status, method, path, bodyText) {
    super(`${method} ${path} -> ${status}${bodyText ? ` ${bodyText.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
    this.status = status;
  }
}

async function request(method, path, { json, form } = {}) {
  const init = { method, headers: headers() };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (form !== undefined) {
    init.body = form; // multipart: fetch сам выставит Content-Type с boundary
  }
  const res = await fetch(`${API}/repos/${repo}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, method, path, text);
  return text ? JSON.parse(text) : null;
}

/** Все релизы (с пагинацией), нормализованные в массив. */
async function listReleases() {
  const out = [];
  for (let page = 1; ; page++) {
    const data = await request('GET', `/releases?per_page=${PER_PAGE}&page=${page}`);
    const items = Array.isArray(data) ? data : data?.releases || data?.data || [];
    out.push(...items);
    if (items.length < PER_PAGE) break;
  }
  return out;
}

async function findRelease(t) {
  const releases = await listReleases();
  return releases.find((r) => r && r.tag_name === t) || null;
}

/** Поиск с повторами — релиз мог создаться GitVerse асинхронно после 409. */
async function findReleaseWithRetry(t, attempts = 5, delayMs = 2000) {
  for (let i = 1; i <= attempts; i++) {
    const found = await findRelease(t);
    if (found) return found;
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

function patchPayload() {
  return { name: releaseName, body, prerelease };
}

async function uploadAsset(releaseId, a) {
  const form = new FormData();
  form.set('file', new Blob([a.buffer]), a.name);
  return request('POST', `/releases/${releaseId}/assets`, { form });
}

async function main() {
  console.log(`[release] Репозиторий ${repo}, тег ${tag}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`[release] Тело: ${bodyFile} (${body.length} симв.)${prerelease ? ', pre-release' : ''}`);
  if (asset) console.log(`[release] Ассет: ${asset.name} (${statSync(asset.path).size} байт)`);

  const existing = await findRelease(tag);

  let releaseId;
  if (existing) {
    console.log(`[release] Найден релиз id=${existing.id} по тегу ${tag} (name="${existing.name}")`);
    if (dryRun) {
      console.log(`[dry-run] PATCH ${API}/repos/${repo}/releases/${existing.id}`);
      console.log(`[dry-run]   name="${releaseName}", тело ${body.length} симв.`);
      console.log(`[dry-run]   ассет ${asset ? `${asset.name} (${asset.buffer.length} байт, best-effort)` : '—'}`);
      console.log('[dry-run] мутаций не выполнено');
      return;
    }
    await request('PATCH', `/releases/${existing.id}`, { json: patchPayload() });
    console.log(`[release] PATCH ok — тело релиза обновлено (${body.length} симв.)`);
    releaseId = existing.id;
  } else {
    console.log(`[release] Релиз по тегу ${tag} не найден — будет создан`);
    if (dryRun) {
      console.log(`[dry-run] POST ${API}/repos/${repo}/releases`);
      console.log(`[dry-run]   tag_name="${tag}", name="${releaseName}", target_commitish="${target}", тело ${body.length} симв.`);
      console.log(`[dry-run]   ассет ${asset ? `${asset.name} (${asset.buffer.length} байт, best-effort)` : '—'}`);
      console.log('[dry-run] мутаций не выполнено');
      return;
    }
    try {
      const created = await request('POST', '/releases', {
        json: { tag_name: tag, name: releaseName, body, target_commitish: target, prerelease },
      });
      releaseId = created?.id;
      console.log(`[release] Создан релиз id=${releaseId}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        console.log('[release] 409 TAG_EXISTS — релиз создаёт GitVerse; повторяем поиск и PATCH');
        const again = await findReleaseWithRetry(tag);
        if (!again) fail(`после 409 релиз по тегу ${tag} так и не найден`);
        await request('PATCH', `/releases/${again.id}`, { json: patchPayload() });
        console.log(`[release] PATCH ok — тело релиза обновлено (${body.length} симв.)`);
        releaseId = again.id;
      } else {
        throw err;
      }
    }
  }

  if (asset) {
    try {
      await uploadAsset(releaseId, asset);
      console.log(`[release] Ассет ${asset.name} загружен`);
    } catch (err) {
      console.warn(`[release] Предупреждение: ассет ${asset.name} не загружен (${err.message}) — тело релиза проставлено, ассет пропущен`);
    }
  }

  const check = await request('GET', `/releases/${releaseId}`);
  console.log(
    `[release] Проверка: id=${check?.id}, тег ${check?.tag_name}, тело ${(check?.body || '').length} симв., ассетов ${(check?.assets || []).length}`,
  );
  console.log('[release] готово');
}

main().catch((err) => fail(err?.message || String(err)));
