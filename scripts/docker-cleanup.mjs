#!/usr/bin/env node
/**
 * ОДНОРАЗОВЫЙ инструмент: чистка исторических тегов Docker-образов в gitverse-реестре.
 *
 * Образы больше НЕ публикуются в gitverse.ru и ghcr.io — единственный реестр
 * теперь Gitea (`git.itphx.ru/itphx`, публичный, без ограничений на размер).
 * Поэтому в релизном CI (release.yaml) этот скрипт больше не вызывается:
 * шаг «Очистка старых Docker-образов» удалён из джобы `build-docker`.
 * Скрипт сохранён, чтобы разово вычистить накопленные версии в gitverse.
 *
 * Историческая причина: хранилище container registry GitVerse было ограничено,
 * старые образы копились от релиза к релизу и при переполнении registry
 * отвечал 403 на публикацию (лимит ~500 МБ на репозиторий).
 *
 * Использование (разово, вручную):
 *   GV_TOKEN=<token> node scripts/docker-cleanup.mjs synth synth-backend synth-ui
 *
 * Переменные окружения:
 *   GV_REGISTRY — хост реестра (по умолчанию gitverse.ru)
 *   GV_OWNER    — владелец пакетов в реестре (по умолчанию itphx)
 *   GV_TOKEN    — токен с правами на container registry (обязателен)
 *   GV_KEEP_TAGS — теги через запятую, которые НЕ удаляются (обычно версия,
 *                 которая публикуется этим прогоном). Без этого «очистили →
 *                 не хватило квоты → публикация упала» оставляет реестр пустым
 *                 (так случилось на 0.12.4: synth-backend остался без версий).
 */

const registry = process.env.GV_REGISTRY || 'gitverse.ru';
const owner = process.env.GV_OWNER || 'itphx';
const token = process.env.GV_TOKEN;
if (!token) {
  console.error('GV_TOKEN не задан');
  process.exit(1);
}

const keepTags = new Set(
  (process.env.GV_KEEP_TAGS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
);

const images = process.argv.slice(2);
if (!images.length) {
  console.error('Укажите имена образов, например: synth synth-backend synth-ui');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${owner}:${token}`).toString('base64');

async function req(method, path) {
  const res = await fetch(`https://${registry}/v2/${path}`, {
    method,
    headers: {
      Authorization: auth,
      Accept: 'application/vnd.docker.distribution.manifest.v2+json',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res;
}

for (const img of images) {
  const repo = `${owner}/${img}`;
  const list = await req('GET', `${repo}/tags/list`);
  if (!list) {
    console.log(`[skip] ${repo}: образ в реестре отсутствует`);
    continue;
  }
  const tags = (await list.json()).tags || [];
  console.log(`[clean] ${repo}: теги ${tags.length ? tags.join(', ') : '(пусто)'}`);
  for (const tag of tags) {
    if (keepTags.has(tag)) {
      console.log(`  = ${tag}: сохранён (GV_KEEP_TAGS)`);
      continue;
    }
    const head = await req('HEAD', `${repo}/manifests/${tag}`);
    const digest = head && head.headers.get('docker-content-digest');
    if (!digest) {
      console.warn(`  ! ${tag}: не удалось получить digest, пропуск`);
      continue;
    }
    const del = await req('DELETE', `${repo}/manifests/${digest}`);
    console.log(`  - ${tag} (${digest.slice(0, 19)}...) -> ${del.status}`);
  }
}

console.log('[clean] готово');
