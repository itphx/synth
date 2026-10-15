#!/usr/bin/env node
/**
 * Проставляет тело релиза (GitVerse или GitHub) для тега релиза
 * (+ best-effort ассеты).
 *
 * Поддерживает две платформы (флаг --platform, по умолчанию gitverse — обратная
 * совместимость с джобой create-release в .gitverse/workflows/release.yaml):
 *
 *   gitverse — API https://api.gitverse.ru, заголовок
 *     Accept: application/vnd.gitverse.object+json;version=1, токен GV_TOKEN.
 *     Зачем собственный скрипт вместо actions/create-release@v1: GitVerse сам
 *     создаёт релиз для тега в момент push тега, поэтому POST /releases для уже
 *     существующего git-тега отвечает 409 TAG_EXISTS, а action падает. Здесь
 *     релиз ищется по tag_name (с пагинацией) и делается идемпотентный PATCH,
 *     при отсутствии — POST, а при 409 — повторный поиск и PATCH. Загрузка
 *     ассетов в GitVerse сейчас отвечает 500 — ассет грузится best-effort.
 *
 *   github — API https://api.github.com (релизы) и https://uploads.github.com
 *     (ассеты), заголовки Accept: application/vnd.github+json +
 *     X-GitHub-Api-Version + User-Agent, токен GH_TOKEN. Релиз ищется через
 *     GET /releases/tags/{tag} (404 — нет), создаётся POST /releases, иначе
 *     PATCH /releases/{id}. Ассеты грузятся raw-телом на uploads.github.com;
 *     при 422 (уже существует) ассет пересоздаётся (delete + upload), а не
 *     роняет джобу.
 *
 * Использование в CI (release.yaml, джоба create-release — GitVerse):
 *   GV_TOKEN=<token> GV_REPO=itphx/synth RELEASE_TAG=v0.10.0 \
 *     RELEASE_BODY_FILE=tmp/release-body.md RELEASE_ASSET=packages/synth/dist/cli.js \
 *     node scripts/publish-release.mjs
 *
 * Использование в CI (release.yaml, джоба publish-github — GitHub):
 *   GH_TOKEN=<token> GH_REPO=itphx/synth RELEASE_TAG=v0.10.0 \
 *     RELEASE_BODY_FILE=tmp/release-body.md RELEASE_ASSETS="tmp/assets/*" \
 *     node scripts/publish-release.mjs --platform github
 *
 * Локальная проверка без мутаций:
 *   node scripts/publish-release.mjs --dry-run
 *   node scripts/publish-release.mjs --platform github --dry-run
 *
 * Переменные окружения:
 *   RELEASE_TAG        — тег релиза, напр. v0.10.0 (обязателен)
 *   RELEASE_BODY_FILE  — путь к готовому телу релиза (обязателен)
 *   RELEASE_ASSET      — один необязательный ассет (имя = basename файла)
 *   RELEASE_ASSETS     — необязательный список ассетов (через пробел/запятую/перевод строки)
 *   RELEASE_TARGET     — target_commitish для создания (по умолчанию = тег)
 *   RELEASE_PRERELEASE — true/1 — пометить pre-release (необязательно)
 *   RELEASE_PLATFORM   — gitverse|github (то же, что --platform)
 *
 *   GitVerse: GV_TOKEN (обязателен), GV_REPO, GV_API_URL
 *   GitHub:   GH_TOKEN (или GITHUB_TOKEN, обязателен), GH_REPO
 *   GitHub:   GH_API_URL / GH_UPLOADS_URL — переопределение хостов API/загрузки (тесты; по умолчанию api.github.com / uploads.github.com)
 *
 * Коды выхода: 0 — тело релиза проставлено (или --dry-run), 1 — ошибка.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';

// --- Аргументы и платформа ---------------------------------------------------

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');

function argValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? '';
}

function fail(msg) {
  console.error(`[release] ОШИБКА: ${msg}`);
  process.exit(1);
}

function usage() {
  console.log(`publish-release.mjs — тело релиза + best-effort ассеты (GitVerse/GitHub)

Использование:
  node scripts/publish-release.mjs [--platform gitverse|github] [--dry-run]

Флаги:
  --platform <p>   платформа релиза: gitverse (по умолчанию) | github
  --dry-run        показать план, не выполнять мутаций
  -h, --help       эта справка

Токены/репозиторий берутся из окружения: GV_TOKEN/GV_REPO (gitverse),
GH_TOKEN/GH_REPO (github). См. комментарий в шапке скрипта.`);
}

if (argv.includes('-h') || argv.includes('--help')) {
  usage();
  process.exit(0);
}

const platform = argValue('--platform') || process.env.RELEASE_PLATFORM || 'gitverse';
if (platform !== 'gitverse' && platform !== 'github') {
  fail(`неизвестная платформа '${platform}' (ожидается gitverse|github)`);
}
const isGithub = platform === 'github';

const API = isGithub
  ? process.env.GH_API_URL || 'https://api.github.com'
  : process.env.GV_API_URL || 'https://api.gitverse.ru';
// GitHub грузит ассеты только на отдельный хост uploads.github.com.
// GH_UPLOADS_URL — переопределение (тесты/спецконтуры), по умолчанию штатный хост.
const UPLOADS_API = process.env.GH_UPLOADS_URL || 'https://uploads.github.com';
const repo = isGithub
  ? process.env.GH_REPO || process.env.GV_REPO || 'itphx/synth'
  : process.env.GV_REPO || 'itphx/synth';
const token = isGithub ? process.env.GH_TOKEN || process.env.GITHUB_TOKEN : process.env.GV_TOKEN;
const tag = process.env.RELEASE_TAG;
const bodyFile = process.env.RELEASE_BODY_FILE;
const target = process.env.RELEASE_TARGET || tag;
const prerelease = /^(1|true|yes)$/i.test(process.env.RELEASE_PRERELEASE || '');
const PER_PAGE = 50;

if (!token) fail(isGithub ? 'GH_TOKEN не задан' : 'GV_TOKEN не задан');
if (!tag) fail('RELEASE_TAG не задан (напр. v0.10.0)');
if (!bodyFile) fail('RELEASE_BODY_FILE не задан');
if (!existsSync(bodyFile)) fail(`файл тела релиза не найден: ${bodyFile}`);

const body = readFileSync(bodyFile, 'utf8');
const releaseName = isGithub ? `Synth ${tag.replace(/^v/, '')}` : `Release ${tag}`;

// Ассеты: RELEASE_ASSET (один, исторически) + RELEASE_ASSETS (список).
const assetPaths = [
  ...new Set(
    [process.env.RELEASE_ASSET || '', ...(process.env.RELEASE_ASSETS || '').split(/[\s,]+/)]
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
const assets = [];
for (const path of assetPaths) {
  if (!existsSync(path)) {
    console.warn(`[release] Предупреждение: ассет ${path} не найден — пропущен`);
    continue;
  }
  assets.push({ path, name: basename(path), buffer: readFileSync(path) });
}

// --- HTTP --------------------------------------------------------------------

function headers(extra = {}) {
  if (isGithub) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'synth-release-script',
      ...extra,
    };
  }
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

async function request(method, path, { json, form, raw, contentType, base } = {}) {
  const init = { method, headers: headers() };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (form !== undefined) {
    init.body = form; // multipart: fetch сам выставит Content-Type с boundary
  } else if (raw !== undefined) {
    if (contentType) init.headers['Content-Type'] = contentType;
    init.body = raw; // бинарное тело (GitHub uploads)
  }
  const res = await fetch(`${base || API}/repos/${repo}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, method, path, text);
  return text ? JSON.parse(text) : null;
}

/** Все релизы GitVerse (с пагинацией), нормализованные в массив. */
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
  if (isGithub) {
    try {
      return await request('GET', `/releases/tags/${encodeURIComponent(t)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null; // релиза нет
      throw err;
    }
  }
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

function createPayload() {
  return { tag_name: tag, name: releaseName, body, target_commitish: target, prerelease };
}

/** Content-Type ассета по имени файла (для GitHub uploads). */
function contentTypeFor(name) {
  if (/\.(tgz|tar\.gz)$/i.test(name)) return 'application/gzip';
  if (/^SHA256SUMS$/.test(name) || /\.(txt|sha256)$/i.test(name)) return 'text/plain';
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.ya?ml$/i.test(name)) return 'application/yaml';
  if (/\.js$/i.test(name)) return 'application/javascript';
  return 'application/octet-stream';
}

/** Список ассетов релиза (GitHub) — для замены существующего по имени. */
async function listAssets(releaseId) {
  const list = await request('GET', `/releases/${releaseId}/assets`);
  return Array.isArray(list) ? list : [];
}

async function uploadAsset(releaseId, a) {
  if (!isGithub) {
    const form = new FormData();
    form.set('file', new Blob([a.buffer]), a.name);
    return request('POST', `/releases/${releaseId}/assets`, { form });
  }

  const uploadPath = `/releases/${releaseId}/assets?name=${encodeURIComponent(a.name)}`;
  const opts = { raw: a.buffer, contentType: contentTypeFor(a.name), base: UPLOADS_API };
  try {
    return await request('POST', uploadPath, opts);
  } catch (err) {
    // 422 already_exists — заменяем ассет (delete + повторная загрузка).
    if (err instanceof ApiError && err.status === 422) {
      console.log(`[release] Ассет ${a.name} уже существует — заменяю`);
      const existing = (await listAssets(releaseId)).find((x) => x && x.name === a.name);
      if (existing?.id) {
        await request('DELETE', `/releases/assets/${existing.id}`);
        return request('POST', uploadPath, opts);
      }
    }
    throw err;
  }
}

// --- Основной сценарий -------------------------------------------------------

async function main() {
  console.log(
    `[release] Платформа ${platform}, репозиторий ${repo}, тег ${tag}${dryRun ? ' (dry-run)' : ''}`,
  );
  console.log(`[release] Тело: ${bodyFile} (${body.length} симв.)${prerelease ? ', pre-release' : ''}`);
  for (const a of assets) {
    console.log(`[release] Ассет: ${a.name} (${statSync(a.path).size} байт)`);
  }

  const existing = await findRelease(tag);

  let releaseId;
  if (existing) {
    console.log(`[release] Найден релиз id=${existing.id} по тегу ${tag} (name="${existing.name}")`);
    if (dryRun) {
      console.log(`[dry-run] PATCH ${API}/repos/${repo}/releases/${existing.id}`);
      console.log(`[dry-run]   name="${releaseName}", тело ${body.length} симв.`);
      console.log(
        `[dry-run]   ассеты: ${assets.length ? assets.map((a) => `${a.name} (${a.buffer.length} байт, best-effort)`).join(', ') : '—'}`,
      );
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
      console.log(
        `[dry-run]   tag_name="${tag}", name="${releaseName}", target_commitish="${target}", тело ${body.length} симв.`,
      );
      console.log(
        `[dry-run]   ассеты: ${assets.length ? assets.map((a) => `${a.name} (${a.buffer.length} байт, best-effort)`).join(', ') : '—'}`,
      );
      console.log('[dry-run] мутаций не выполнено');
      return;
    }
    try {
      const created = await request('POST', '/releases', { json: createPayload() });
      releaseId = created?.id;
      console.log(`[release] Создан релиз id=${releaseId}`);
    } catch (err) {
      // GitVerse: релиз для тега создаёт сам при push тега → 409 TAG_EXISTS.
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

  for (const a of assets) {
    try {
      await uploadAsset(releaseId, a);
      console.log(`[release] Ассет ${a.name} загружен`);
    } catch (err) {
      console.warn(
        `[release] Предупреждение: ассет ${a.name} не загружен (${err.message}) — тело релиза проставлено, ассет пропущен`,
      );
    }
  }

  const check = await request('GET', `/releases/${releaseId}`);
  console.log(
    `[release] Проверка: id=${check?.id}, тег ${check?.tag_name}, тело ${(check?.body || '').length} симв., ассетов ${(check?.assets || []).length}`,
  );
  console.log('[release] готово');
}

main().catch((err) => fail(err?.message || String(err)));
