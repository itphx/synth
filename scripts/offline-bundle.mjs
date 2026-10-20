#!/usr/bin/env node
/**
 * offline-bundle.mjs — сборка offline-дистрибутивов Synth для закрытого контура.
 *
 * Собирает portable-архивы: приложение (hoisted pnpm deploy) + pinned Node 22 +
 * ripgrep + обёртки запуска + установщики + manifest/SHA256SUMS.
 *
 * Нативные пакеты (.deb/.rpm/.msi/.pkg) НЕ собираются — только tar.gz/zip и
 * offline Docker/Helm (вне зоны этого скрипта).
 *
 * Примеры:
 *   node scripts/offline-bundle.mjs --platform linux-x64
 *   node scripts/offline-bundle.mjs --platform all --out dist/offline
 *   node scripts/offline-bundle.mjs --platform win-x64 --node-dir /opt/node22 --rg-dir /opt/rg
 *   node scripts/offline-bundle.mjs --skip-build --platform linux-x64
 *
 * Сеть нужна только для скачивания Node/ripgrep. В закрытом build-окружении
 * используйте --node-cache/--rg-cache (предзаполненные архивы) или
 * --node-dir/--rg-dir (локальные распаковки).
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import https from 'node:https';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NODE_DIST_BASE = 'https://nodejs.org/dist';
const RG_RELEASE_BASE = 'https://github.com/BurntSushi/ripgrep/releases/download';

/** Portable-платформы. linux-arm64 собирается явно, но в `all` не входит:
 *  по решению владельца portable для arm64 Linux не выпускается (только Docker-образы). */
const PLATFORMS = {
  'linux-x64': { os: 'linux', arch: 'x64', nodeArchive: 'linux-x64.tar.xz', rgArchive: 'x86_64-unknown-linux-musl.tar.gz' },
  'linux-arm64': { os: 'linux', arch: 'arm64', nodeArchive: 'linux-arm64.tar.xz', rgArchive: 'aarch64-unknown-linux-gnu.tar.gz' },
  'darwin-x64': { os: 'darwin', arch: 'x64', nodeArchive: 'darwin-x64.tar.gz', rgArchive: 'x86_64-apple-darwin.tar.gz' },
  'darwin-arm64': { os: 'darwin', arch: 'arm64', nodeArchive: 'darwin-arm64.tar.gz', rgArchive: 'aarch64-apple-darwin.tar.gz' },
  'win-x64': { os: 'win32', arch: 'x64', nodeArchive: 'win-x64.zip', rgArchive: 'x86_64-pc-windows-msvc.zip' },
};

const ALL_PLATFORMS = ['linux-x64', 'darwin-x64', 'darwin-arm64', 'win-x64'];

/** Имя внутреннего файла сумм бандла (совпадает у производителя и потребителей:
 *  scripts/offline/install.sh, install.ps1, smoke-test.sh). */
const INNER_SUMS_NAME = 'files.sha256';

const USAGE = `offline-bundle.mjs — offline-дистрибутивы Synth (portable)

Использование:
  node scripts/offline-bundle.mjs [OPTIONS]

Опции:
  --platform <name|all>     linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64 |
                            win-x64 | all (default: all; all = linux-x64,
                            darwin-x64, darwin-arm64, win-x64 — без linux-arm64)
  --out <dir>               каталог артефактов (default: dist/offline)
  --node-version <ver>      версия Node 22 (default: latest-v22.x по SHASUMS256.txt)
  --node-cache <dir>        кэш архивов Node (default: \$XDG_CACHE_HOME/synth-offline/node)
  --node-dir <dir>          локальная распаковка Node вместо скачивания (offline)
  --rg-version <ver>        версия ripgrep (default: 14.1.1)
  --rg-cache <dir>          кэш архивов ripgrep (default: \$XDG_CACHE_HOME/synth-offline/ripgrep)
  --rg-dir <dir>            локальный rg вместо скачивания (offline)
  --docs-dir <dir>          готовая offline-документация (HTML/MD) для share/docs
  --clean                   очистить --out перед сборкой (удалить старые архивы)
  --skip-build              не запускать pnpm build (dist уже собран)
  --source-date-epoch <s>   фиксированный mtime для детерминированной упаковки
  -h, --help                эта справка
`;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    platform: 'all',
    out: path.join('dist', 'offline'),
    nodeVersion: null,
    nodeCache: null,
    nodeDir: null,
    rgVersion: '14.1.1',
    rgCache: null,
    rgDir: null,
    docsDir: null,
    clean: false,
    skipBuild: false,
    sourceDateEpoch: null,
  };

  const take = (i, name) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`опция ${name} требует значение`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : null;
    const value = (name) => (inline !== null ? inline : take(i++, name));

    switch (flag) {
      case '--platform':
        opts.platform = value('--platform');
        break;
      case '--out':
        opts.out = value('--out');
        break;
      case '--node-version':
        opts.nodeVersion = value('--node-version').replace(/^v/, '');
        break;
      case '--node-cache':
        opts.nodeCache = value('--node-cache');
        break;
      case '--node-dir':
        opts.nodeDir = value('--node-dir');
        break;
      case '--rg-version':
        opts.rgVersion = value('--rg-version').replace(/^v/, '');
        break;
      case '--rg-cache':
        opts.rgCache = value('--rg-cache');
        break;
      case '--rg-dir':
        opts.rgDir = value('--rg-dir');
        break;
      case '--docs-dir':
        opts.docsDir = value('--docs-dir');
        break;
      case '--clean':
        opts.clean = true;
        break;
      case '--skip-build':
        opts.skipBuild = true;
        break;
      case '--source-date-epoch':
        opts.sourceDateEpoch = Number(value('--source-date-epoch'));
        if (!Number.isInteger(opts.sourceDateEpoch) || opts.sourceDateEpoch <= 0) {
          throw new Error('--source-date-epoch должен быть целым числом секунд Unix');
        }
        break;
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`неизвестная опция: ${raw}`);
    }
  }

  if (opts.platform !== 'all' && !PLATFORMS[opts.platform]) {
    throw new Error(`неизвестная платформа: ${opts.platform} (допустимо: ${Object.keys(PLATFORMS).join(', ')}, all)`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

function step(msg) {
  process.stderr.write(`\n== ${msg}\n`);
}

function quoteWin(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const win = process.platform === 'win32';
  const r = win
    ? spawnSync([cmd, ...args].map(quoteWin).join(' '), { stdio: 'inherit', shell: true, ...opts })
    : spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw new Error(`не удалось запустить ${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} завершился с кодом ${r.status}`);
}

function capture(cmd, args, opts = {}) {
  const win = process.platform === 'win32';
  const r = win
    ? spawnSync([cmd, ...args].map(quoteWin).join(' '), { encoding: 'utf8', shell: true, ...opts })
    : spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw new Error(`не удалось запустить ${cmd}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`${cmd} завершился с кодом ${r.status}: ${(r.stderr || '').trim()}`);
  }
  return r.stdout;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function writeExecutable(file, content, mode = 0o755) {
  fs.writeFileSync(file, content, 'utf8');
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* Windows: режим не применим */
  }
}

function copyFile(src, dest, mode) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  if (mode !== undefined) {
    try {
      fs.chmodSync(dest, mode);
    } catch {
      /* Windows */
    }
  }
}

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full);
      if (entry.isSymbolicLink()) {
        out.push({ rel, type: 'symlink' });
      } else if (entry.isDirectory()) {
        out.push({ rel, type: 'dir' });
        stack.push(full);
      } else if (entry.isFile()) {
        out.push({ rel, type: 'file', size: fs.statSync(full).size });
      }
    }
  }
  return out;
}

function assertNoSymlinks(root) {
  const links = walk(root).filter((e) => e.type === 'symlink').map((e) => e.rel);
  if (links.length > 0) {
    throw new Error(
      `в бандле остались симлинки (${links.length}) — архив был бы невалиден в закрытом контуре:\n` +
        links.slice(0, 20).map((l) => `  - ${l}`).join('\n') +
        (links.length > 20 ? `\n  ... и ещё ${links.length - 20}` : ''),
    );
  }
}

function cacheRoot() {
  const base = process.env.XDG_CACHE_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.cache');
  return path.join(base, 'synth-offline');
}

function fetchText(url, timeoutMs = 30_000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'synth-offline-bundle' } }).then(
    async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} при загрузке ${url}`);
      return res.text();
    },
  );
}

function download(url, dest, label) {
  ensureDir(path.dirname(dest));
  return new Promise((resolve, reject) => {
    const follow = (target, hops) => {
      if (hops > 10) return reject(new Error(`слишком много редиректов: ${url}`));
      const req = https.get(
        target,
        { headers: { 'user-agent': 'synth-offline-bundle', accept: '*/*' } },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            return follow(new URL(res.headers.location, target).toString(), hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} при загрузке ${target}`));
          }
          const total = Number(res.headers['content-length'] || 0);
          let received = 0;
          let reported = 0;
          const part = `${dest}.part`;
          const out = createWriteStream(part);
          pipeline(res, out)
            .then(() => {
              fs.renameSync(part, dest);
              resolve();
            })
            .catch((err) => {
              rmrf(part);
              reject(err);
            });
          // Прогресс — после pipeline(), чтобы не перевести поток в flowing раньше времени.
          res.on('data', (chunk) => {
            received += chunk.length;
            if (total && received - reported >= total / 10) {
              reported = received;
              log(`  ${label}: ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`);
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(120_000, () => req.destroy(new Error(`таймаут загрузки ${target}`)));
    };
    follow(url, 0);
  });
}

function parseSha256File(text) {
  // Форматы бывают разные: "<hash>  <file>", путь впереди, или вывод CertUtil.
  const m = /\b([a-fA-F0-9]{64})\b/.exec(text);
  if (!m) return null;
  return m[1].toLowerCase();
}

function entrySha256(sumsText, fileName) {
  for (const line of sumsText.split(/\r?\n/)) {
    const m = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && path.basename(m[2].trim()) === fileName) return m[1].toLowerCase();
  }
  return null;
}

// ---------------------------------------------------------------------------
// версии и архивы
// ---------------------------------------------------------------------------

function synthVersion() {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages', 'synth', 'package.json'), 'utf8'));
  if (!pkg.version) throw new Error('в packages/synth/package.json нет version');
  return pkg.version;
}

function detectNodeVersionFromDir(dir) {
  const candidates = [path.join(dir, 'bin', 'node'), path.join(dir, 'node'), path.join(dir, 'node.exe')];
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    try {
      return capture(bin, ['--version']).trim().replace(/^v/, '');
    } catch {
      /* пробуем следующий */
    }
  }
  return null;
}

async function resolveNodeVersion(opts) {
  if (opts.nodeVersion) return opts.nodeVersion;
  if (opts.nodeDir) {
    const detected = detectNodeVersionFromDir(opts.nodeDir);
    if (detected) {
      log(`Node из --node-dir: v${detected}`);
      return detected;
    }
    log('не удалось определить версию Node из --node-dir — резолвим latest-v22.x');
  }
  log('резолв Node latest-v22.x ...');
  const text = await fetchText(`${NODE_DIST_BASE}/latest-v22.x/SHASUMS256.txt`);
  const m = /node-v(22\.\d+\.\d+)-linux-x64\.tar\.xz/.exec(text);
  if (!m) throw new Error('не удалось определить версию Node из latest-v22.x/SHASUMS256.txt');
  return m[1];
}

function warnIfNodeNot22(version) {
  if (!/^22\./.test(version)) {
    log(`предупреждение: версия Node ${version} не из линии 22 (owner-требование: pinned Node 22)`);
  }
}

async function ensureNodeArchive(platformKey, version, opts) {
  const pl = PLATFORMS[platformKey];
  const fileName = `node-v${version}-${pl.nodeArchive}`;
  if (opts.nodeDir) {
    return { file: null, fileName, sha256: null, source: 'node-dir' };
  }

  const cache = path.resolve(opts.nodeCache || path.join(cacheRoot(), 'node'));
  const dir = path.join(cache, `v${version}`);
  const sumsFile = path.join(dir, 'SHASUMS256.txt');
  const archive = path.join(dir, fileName);
  ensureDir(dir);

  let sums = null;
  if (existsSync(sumsFile)) {
    sums = readFileSync(sumsFile, 'utf8');
  } else {
    try {
      sums = await fetchText(`${NODE_DIST_BASE}/v${version}/SHASUMS256.txt`);
      fs.writeFileSync(sumsFile, sums, 'utf8');
    } catch (err) {
      if (!existsSync(archive)) {
        throw new Error(
          `нет сети и нет кэша Node (${sumsFile}): ${err.message}. ` +
            'Для offline-сборки передайте --node-cache с предзаполненным кэшем или --node-dir.',
        );
      }
      throw new Error(`нет сети и нет ${sumsFile} — нечем проверить SHA256 архива Node. Передайте --node-cache/--node-dir.`);
    }
  }

  const expected = entrySha256(sums, fileName);
  if (!expected) throw new Error(`в SHASUMS256.txt нет записи для ${fileName}`);

  if (!existsSync(archive)) {
    log(`скачивание ${fileName} ...`);
    await download(`${NODE_DIST_BASE}/v${version}/${fileName}`, archive, fileName);
  }

  const actual = await sha256File(archive);
  if (actual !== expected) {
    rmrf(archive);
    throw new Error(`SHA256 не совпал для ${fileName}: ожидался ${expected}, получен ${actual}`);
  }
  log(`Node  ${fileName}  sha256 ok`);
  return { file: archive, fileName, sha256: actual, source: 'download' };
}

async function ensureRgArchive(platformKey, version, opts) {
  const pl = PLATFORMS[platformKey];
  const fileName = `ripgrep-${version}-${pl.rgArchive}`;
  if (opts.rgDir) {
    return { file: null, fileName, sha256: null, source: 'rg-dir' };
  }

  const cache = path.resolve(opts.rgCache || path.join(cacheRoot(), 'ripgrep'));
  const dir = path.join(cache, version);
  const archive = path.join(dir, fileName);
  const shaFile = `${archive}.sha256`;
  ensureDir(dir);

  const url = `${RG_RELEASE_BASE}/${version}/${fileName}`;
  let expected = null;
  if (existsSync(shaFile)) {
    expected = parseSha256File(readFileSync(shaFile, 'utf8'));
  } else {
    try {
      const text = await fetchText(`${url}.sha256`);
      expected = parseSha256File(text);
      if (!expected) throw new Error('не удалось разобрать .sha256');
      fs.writeFileSync(shaFile, text, 'utf8');
    } catch (err) {
      if (!existsSync(archive)) {
        throw new Error(
          `нет сети и нет кэша ripgrep (${archive}): ${err.message}. ` +
            'Передайте --rg-cache или --rg-dir.',
        );
      }
      throw new Error(`нет сети и нет ${shaFile} — нечем проверить SHA256 архива ripgrep. Передайте --rg-cache/--rg-dir.`);
    }
  }
  if (!expected) throw new Error(`не удалось получить SHA256 для ${fileName}`);

  if (!existsSync(archive)) {
    log(`скачивание ${fileName} ...`);
    await download(url, archive, fileName);
  }

  const actual = await sha256File(archive);
  if (actual !== expected) {
    rmrf(archive);
    throw new Error(`SHA256 не совпал для ${fileName}: ожидался ${expected}, получен ${actual}`);
  }
  log(`rg    ${fileName}  sha256 ok`);
  return { file: archive, fileName, sha256: actual, source: 'download' };
}

function extractArchive(archive, destDir) {
  ensureDir(destDir);
  if (archive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      run('tar', ['-xf', archive, '-C', destDir]);
    } else {
      run('unzip', ['-q', archive, '-d', destDir]);
    }
  } else {
    run('tar', ['-xf', archive, '-C', destDir]);
  }
  const entries = fs.readdirSync(destDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length !== 1) {
    throw new Error(`ожидался один корневой каталог в ${path.basename(archive)}, найдено: ${entries.length}`);
  }
  return path.join(destDir, entries[0].name);
}

// ---------------------------------------------------------------------------
// staged content
// ---------------------------------------------------------------------------

function stageRuntimeNode(stage, platformKey, nodeVersion, nodeArtifact, tmpRoot) {
  const pl = PLATFORMS[platformKey];
  const win = pl.os === 'win32';
  const targetDir = path.join(stage, 'runtime', 'node');
  ensureDir(targetDir);

  let sourceRoot = null;
  let cleanup = null;
  try {
    if (nodeArtifact.file) {
      const tmp = path.join(tmpRoot, `node-${platformKey}`);
      ensureDir(tmp);
      cleanup = tmp;
      sourceRoot = extractArchive(nodeArtifact.file, tmp);
    } else {
      sourceRoot = path.resolve(nodeArtifact.dir);
    }

    const binSrc = win
      ? [path.join(sourceRoot, 'node.exe'), path.join(sourceRoot, 'bin', 'node.exe')].find(existsSync)
      : [path.join(sourceRoot, 'bin', 'node'), path.join(sourceRoot, 'node')].find(existsSync);
    if (!binSrc) throw new Error(`в Node-дистрибутиве не найден бинарник node (${sourceRoot})`);
    copyFile(binSrc, path.join(targetDir, win ? 'node.exe' : path.join('bin', 'node')), 0o755);

    const license = ['LICENSE', 'LICENSE.txt'].map((n) => path.join(sourceRoot, n)).find(existsSync);
    if (!license) throw new Error(`в Node-дистрибутиве не найден LICENSE (${sourceRoot})`);
    copyFile(license, path.join(targetDir, 'LICENSE'));

    log(`runtime/node: v${nodeVersion} (${win ? 'node.exe' : 'bin/node'})`);
  } finally {
    if (cleanup) rmrf(cleanup);
  }
  return nodeArtifact;
}

/** tools/rg + лицензии рядом с бинарником (или из --rg-dir). */
function stageToolsRg(stage, platformKey, rgVersion, rgArtifact, tmpRoot) {
  const pl = PLATFORMS[platformKey];
  const win = pl.os === 'win32';
  const targetDir = path.join(stage, 'tools');
  ensureDir(targetDir);

  let sourceRoot = null;
  let cleanup = null;
  try {
    if (rgArtifact.file) {
      const tmp = path.join(tmpRoot, `rg-${platformKey}`);
      ensureDir(tmp);
      cleanup = tmp;
      sourceRoot = extractArchive(rgArtifact.file, tmp);
    } else {
      sourceRoot = path.resolve(rgArtifact.dir);
    }

    const binSrc = [path.join(sourceRoot, win ? 'rg.exe' : 'rg'), path.join(sourceRoot, 'bin', win ? 'rg.exe' : 'rg')].find(
      existsSync,
    );
    if (!binSrc) throw new Error(`не найден ${win ? 'rg.exe' : 'rg'} в ${sourceRoot} (--rg-dir)`);
    copyFile(binSrc, path.join(targetDir, win ? 'rg.exe' : 'rg'), 0o755);

    let copied = 0;
    for (const name of ['COPYING', 'LICENSE-MIT', 'UNLICENSE']) {
      const src = path.join(sourceRoot, name);
      if (existsSync(src)) {
        copyFile(src, path.join(targetDir, name));
        copied += 1;
      }
    }
    if (copied === 0) log('предупреждение: лицензии ripgrep не найдены рядом с бинарником');
    log(`tools/rg: v${rgVersion}`);
  } finally {
    if (cleanup) rmrf(cleanup);
  }
  return rgArtifact;
}

function deployApp(targetDir) {
  run('pnpm', [
    '--config.verify-deps-before-run=false',
    '--filter',
    '@itphx/synth',
    'deploy',
    '--prod',
    '--legacy',
    '--config.node-linker=hoisted',
    targetDir,
  ], { cwd: REPO_ROOT });

  // Симлинки в архиве не нужны и ломают распаковку в закрытом контуре (Windows).
  rmrf(path.join(targetDir, 'node_modules', '.bin'));

  // pnpm-метаданные не нужны в рантайме, но ломают детерминизм:
  // .modules.yaml содержит абсолютные пути сборочной машины и prunedAt,
  // .pnpm — виртуальный стор (lock.yaml) при hoisted-раскладке.
  rmrf(path.join(targetDir, 'node_modules', '.modules.yaml'));
  rmrf(path.join(targetDir, 'node_modules', '.pnpm'));

  if (!existsSync(path.join(targetDir, 'dist', 'cli.js'))) {
    throw new Error(`pnpm deploy не создал ${path.join(targetDir, 'dist', 'cli.js')}`);
  }
  assertNoSymlinks(targetDir);
}

function writeConfigExamples(stage, docsSource) {
  const templates = path.join(REPO_ROOT, 'scripts', 'offline', 'templates');
  const etcDir = path.join(stage, 'etc');
  ensureDir(etcDir);
  copyFile(path.join(templates, 'config.example.yaml'), path.join(etcDir, 'config.example.yaml'));
  copyFile(path.join(templates, 'synth.env.example'), path.join(etcDir, 'synth.env.example'));

  const docsDir = path.join(stage, 'share', 'docs');
  ensureDir(docsDir);
  if (docsSource) {
    const resolved = path.resolve(docsSource);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error(`--docs-dir не найден или не каталог: ${resolved}`);
    }
    fs.cpSync(resolved, docsDir, { recursive: true });
    log(`share/docs: ${resolved}`);
  } else {
    copyFile(path.join(templates, 'share-README.md'), path.join(docsDir, 'README.md'));
    log('share/docs: заглушка (передайте --docs-dir для полной offline-документации)');
  }
}

function writeLaunchers(stage, platformKey) {
  const templates = path.join(REPO_ROOT, 'scripts', 'offline', 'templates');
  const binDir = path.join(stage, 'bin');
  ensureDir(binDir);

  if (PLATFORMS[platformKey].os === 'win32') {
    // .cmd: только ASCII + CRLF (cmd.exe не любит LF и BOM).
    const content = fs.readFileSync(path.join(templates, 'synth.cmd'), 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(binDir, 'synth.cmd'), content, 'ascii');
  } else {
    copyFile(path.join(templates, 'synth.sh'), path.join(binDir, 'synth'), 0o755);
  }
}

function writeInstallers(stage, platformKey) {
  const src = path.join(REPO_ROOT, 'scripts', 'offline');
  const win = PLATFORMS[platformKey].os === 'win32';
  if (win) {
    for (const name of ['install.ps1', 'uninstall.ps1', 'start-synth.ps1', 'stop-synth.ps1']) {
      // Windows PowerShell 5.1 читает .ps1 как ANSI без BOM — добавляем UTF-8 BOM
      // (кириллица в сообщениях) и CRLF.
      const text = fs.readFileSync(path.join(src, name), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      fs.writeFileSync(path.join(stage, name), `\uFEFF${text}`, 'utf8');
    }
  } else {
    for (const name of ['install.sh', 'uninstall.sh']) {
      copyFile(path.join(src, name), path.join(stage, name), 0o755);
    }
  }
}

function writeLicenses(stage, platformKey, nodeArtifact, rgArtifact) {
  const dir = path.join(stage, 'LICENSES');
  ensureDir(dir);

  for (const name of ['LICENSE', 'LICENSE.ru.md']) {
    const src = path.join(REPO_ROOT, name);
    if (existsSync(src)) copyFile(src, path.join(dir, `synth-${name}`));
  }

  const nodeLicense = path.join(stage, 'runtime', 'node', 'LICENSE');
  if (existsSync(nodeLicense)) copyFile(nodeLicense, path.join(dir, 'node-LICENSE'));

  const toolsDir = path.join(stage, 'tools');
  for (const name of ['COPYING', 'LICENSE-MIT', 'UNLICENSE']) {
    const src = path.join(toolsDir, name);
    if (existsSync(src)) copyFile(src, path.join(dir, `ripgrep-${name}`));
  }

  const lines = [
    '# Лицензии компонентов offline-бандла Synth',
    '',
    `- Synth — MIT (см. \`synth-LICENSE\`, \`synth-LICENSE.ru.md\`).`,
    `- Node.js ${platformKey} — см. \`node-LICENSE\` (исходный файл: \`runtime/node/LICENSE\`).`,
    '- ripgrep — Unlicense/MIT (см. `ripgrep-UNLICENSE`, `ripgrep-LICENSE-MIT`, `ripgrep-COPYING`).',
    '- npm-зависимости приложения — каждая поставляется со своей лицензией в `app/node_modules/<пакет>/`.',
    '',
    `Источники: nodejs.org (${nodeArtifact.source === 'download' ? nodeArtifact.fileName : 'локальная сборка --node-dir'}), ` +
      `github.com/BurntSushi/ripgrep (${rgArtifact.source === 'download' ? rgArtifact.fileName : 'локальная сборка --rg-dir'}).`,
    '',
  ];
  fs.writeFileSync(path.join(dir, 'README.md'), lines.join('\n'), 'utf8');
}

/**
 * Нормализует права в стейдже: каталоги 0755, файлы 0644 (с сохранением
 * исполнимости — 0755). Иначе umask сборочной машины (например 027) попадает
 * в архив, и системная установка (`--system`, пользователь synth) не может
 * прочитать /opt/synth.
 */
function normalizePermissions(stage) {
  fs.chmodSync(stage, 0o755);
  for (const entry of walk(stage)) {
    const full = path.join(stage, entry.rel);
    if (entry.type === 'dir') {
      fs.chmodSync(full, 0o755);
    } else if (entry.type === 'file') {
      const mode = fs.statSync(full).mode & 0o777;
      fs.chmodSync(full, mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

function dirStats(root) {
  let files = 0;
  let bytes = 0;
  for (const entry of walk(root)) {
    if (entry.type === 'file') {
      files += 1;
      bytes += entry.size;
    }
  }
  return { files, bytes };
}

/**
 * Внутренний файл сумм бандла — sha256 КАЖДОГО файла (рекурсивно).
 *
 * Формат стандартный (как у `sha256sum`): `<sha256>  <относительный путь>`,
 * поэтому проверяется и `sha256sum -c files.sha256`, и `shasum -a 256 -c files.sha256`.
 * Пути — со слэшем `/` (независимо от ОС сборки).
 *
 * Исключения: сам `files.sha256` и `manifest.json` (манифест пишется позже и
 * содержит sha256 files.sha256 — иначе получился бы цикл).
 *
 * Зачем: `manifest.json` описывает верхний уровень (sha256 только для файлов
 * верхнего уровня, для каталогов — счётчики), а установщик обязан проверять
 * целостность ВСЕГО бандла, а не только установщиков.
 */
async function writeInnerChecksums(stage) {
  const entries = walk(stage).sort((a, b) => a.rel.localeCompare(b.rel));
  const lines = [];
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    const rel = entry.rel.split(path.sep).join('/');
    if (rel === INNER_SUMS_NAME || rel === 'manifest.json') continue;
    lines.push(`${await sha256File(path.join(stage, entry.rel))}  ${rel}`);
  }
  const file = path.join(stage, INNER_SUMS_NAME);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  try {
    fs.chmodSync(file, 0o644);
  } catch {
    /* Windows */
  }
  log(`files.sha256: ${lines.length} файл(ов)`);
  return file;
}

async function writeManifest(stage, meta) {
  const entries = fs.readdirSync(stage, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'manifest.json') continue; // создаётся после хеширования
    const full = path.join(stage, entry.name);
    if (entry.isDirectory()) {
      const stats = dirStats(full);
      files.push({ path: entry.name, type: 'directory', files: stats.files, bytes: stats.bytes });
    } else if (entry.isFile()) {
      files.push({
        path: entry.name,
        type: 'file',
        size: fs.statSync(full).size,
        sha256: await sha256File(full),
      });
    }
  }

  const manifest = {
    name: 'synth',
    bundle: meta.bundleName,
    synthVersion: meta.synthVersion,
    nodeVersion: meta.nodeVersion,
    ripgrepVersion: meta.rgVersion,
    nodeArchiveSha256: meta.nodeArchiveSha256,
    ripgrepArchiveSha256: meta.rgArchiveSha256,
    nodeSource: meta.nodeSource,
    ripgrepSource: meta.rgSource,
    platform: meta.os,
    arch: meta.arch,
    format: meta.format,
    builtAt: new Date(meta.epoch * 1000).toISOString(),
    sourceDateEpoch: meta.epoch,
    gitCommit: meta.gitCommit,
    gitDirty: meta.gitDirty,
    files,
    notes: [
      'manifest.json не входит в собственный список файлов; SHA256SUMS лежит рядом с архивом.',
      'files.sha256 — sha256 каждого файла бандла (без manifest.json и самого files.sha256); проверяется sha256sum -c.',
      'Установка: см. install.sh (Linux/macOS) или install.ps1 (Windows).',
    ],
  };
  fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(path.join(stage, 'manifest.json'), 0o644);
  } catch {
    /* Windows */
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// упаковка
// ---------------------------------------------------------------------------

function assertGnuTar() {
  for (const candidate of ['tar', 'gtar']) {
    try {
      const out = capture(candidate, ['--version']);
      if (/GNU tar/i.test(out)) return candidate;
    } catch {
      /* нет такого tar */
    }
  }
  throw new Error(
    'для детерминированной упаковки нужен GNU tar (--sort/--owner/--numeric-owner/--mtime). ' +
      'На macOS установите gnu-tar (gtar).',
  );
}

function setMtimes(root, epoch) {
  const dirs = [root];
  for (const entry of walk(root)) {
    const full = path.join(root, entry.rel);
    if (entry.type === 'file' || entry.type === 'dir') {
      fs.utimesSync(full, epoch, epoch);
      if (entry.type === 'dir') dirs.push(full);
    }
  }
  // Каталоги — после файлов, чтобы их mtime не сдвинулся.
  for (const dir of dirs.reverse()) fs.utimesSync(dir, epoch, epoch);
}

function packageBundle(platformKey, stageParent, bundleName, outDir, epoch) {
  const pl = PLATFORMS[platformKey];
  const win = pl.os === 'win32';
  const target = path.join(outDir, `${bundleName}.${win ? 'zip' : 'tar.gz'}`);

  if (win) {
    setMtimes(path.join(stageParent, bundleName), epoch);
    run('zip', ['-X', '-r', '-q', target, bundleName], {
      cwd: stageParent,
      env: { ...process.env, TZ: 'UTC' },
    });
  } else {
    const tar = assertGnuTar();
    run(
      tar,
      [
        '--sort=name',
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        `--mtime=@${epoch}`,
        '-czf',
        target,
        '-C',
        stageParent,
        bundleName,
      ],
      { env: { ...process.env, TZ: 'UTC' } },
    );
  }

  const size = statSync(target).size;
  log(`артефакт: ${target} (${(size / 1048576).toFixed(1)} MiB)`);
  return target;
}

async function writeChecksums(outDir) {
  const names = fs
    .readdirSync(outDir)
    .filter((name) => name.endsWith('.tar.gz') || name.endsWith('.zip'))
    .sort();
  const lines = [];
  for (const name of names) {
    lines.push(`${await sha256File(path.join(outDir, name))}  ${name}`);
  }
  const file = path.join(outDir, 'SHA256SUMS');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  log(`SHA256SUMS: ${file} (${names.length} артефакт(ов))`);
  return file;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const platforms = opts.platform === 'all' ? ALL_PLATFORMS : [opts.platform];
  if (opts.platform === 'all') {
    log('платформы: linux-x64, darwin-x64, darwin-arm64, win-x64 (linux-arm64 — только явно)');
  }

  const version = synthVersion();
  log(`Synth v${version}`);

  const epoch = opts.sourceDateEpoch ?? (process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) : Math.floor(Date.now() / 1000));
  if (!Number.isInteger(epoch) || epoch <= 0) throw new Error('SOURCE_DATE_EPOCH должен быть целым числом секунд Unix');

  let gitCommit = null;
  let gitDirty = null;
  try {
    gitCommit = capture('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).trim();
    gitDirty = capture('git', ['status', '--porcelain'], { cwd: REPO_ROOT }).trim().length > 0;
  } catch {
    log('git недоступен — gitCommit будет null');
  }

  const outDir = path.resolve(opts.out);
  if (opts.clean) {
    log(`--clean: удаляю ${outDir}`);
    rmrf(outDir);
  }
  ensureDir(outDir);
  const stageRoot = path.join(outDir, '.stage');
  rmrf(stageRoot);
  ensureDir(stageRoot);

  try {
    if (!opts.skipBuild) {
      step('pnpm build');
      // verify-deps-before-run=false: в non-TTY/закрытом окружении pnpm иначе
      // пытается переустановить node_modules (нужна сеть) и падает.
      run('pnpm', ['--config.verify-deps-before-run=false', 'build'], { cwd: REPO_ROOT });
    } else {
      log('--skip-build: используем существующие dist/');
    }

    const nodeVersion = await resolveNodeVersion(opts);
    warnIfNodeNot22(nodeVersion);

    step('pnpm deploy (общий app для всех платформ)');
    const appCommon = path.join(stageRoot, 'app-common');
    deployApp(appCommon);
    const produced = [];

    for (const platformKey of platforms) {
      const pl = PLATFORMS[platformKey];
      const win = pl.os === 'win32';
      const bundleName = `synth-${version}-${platformKey}`;
      const format = win ? 'zip' : 'tar.gz';

      step(`сборка ${bundleName}`);

      const stageParent = path.join(stageRoot, platformKey);
      const stage = path.join(stageParent, bundleName);
      ensureDir(stage);

      const nodeArtifact = await ensureNodeArchive(platformKey, nodeVersion, opts);
      if (opts.nodeDir) nodeArtifact.dir = path.resolve(opts.nodeDir);
      const rgArtifact = await ensureRgArchive(platformKey, opts.rgVersion, opts);
      if (opts.rgDir) rgArtifact.dir = path.resolve(opts.rgDir);

      step('app');
      fs.cpSync(appCommon, path.join(stage, 'app'), { recursive: true });
      assertNoSymlinks(path.join(stage, 'app'));

      step('runtime/node');
      stageRuntimeNode(stage, platformKey, nodeVersion, nodeArtifact, stageRoot);

      step('tools/rg');
      stageToolsRg(stage, platformKey, opts.rgVersion, rgArtifact, stageRoot);

      writeLaunchers(stage, platformKey);
      writeInstallers(stage, platformKey);
      writeConfigExamples(stage, opts.docsDir);
      writeLicenses(stage, platformKey, nodeArtifact, rgArtifact);

      step('проверка симлинков и manifest');
      assertNoSymlinks(stage);
      normalizePermissions(stage);
      // files.sha256 — до манифеста: манифест хранит sha256 самого files.sha256.
      await writeInnerChecksums(stage);
      const manifest = await writeManifest(stage, {
        bundleName,
        synthVersion: version,
        nodeVersion,
        rgVersion: opts.rgVersion,
        nodeArchiveSha256: nodeArtifact.sha256,
        rgArchiveSha256: rgArtifact.sha256,
        nodeSource: nodeArtifact.source,
        rgSource: rgArtifact.source,
        os: pl.os,
        arch: pl.arch,
        format,
        epoch,
        gitCommit,
        gitDirty,
      });
      const stats = dirStats(stage);
      log(`manifest: ${manifest.files.length} записей, ${stats.files} файлов, ${(stats.bytes / 1048576).toFixed(1)} MiB`);

      step('упаковка');
      produced.push(packageBundle(platformKey, stageParent, bundleName, outDir, epoch));

      rmrf(stageParent);
    }

    step('SHA256SUMS');
    await writeChecksums(outDir);
    const producedNames = new Set(produced.map((file) => path.basename(file)));
    const foreign = fs
      .readdirSync(outDir)
      .filter((name) => (name.endsWith('.tar.gz') || name.endsWith('.zip')) && !producedNames.has(name));
    if (foreign.length > 0) {
      log(
        `примечание: SHA256SUMS включает и артефакты прошлых сборок (${foreign.join(', ')}) — ` +
          'при публикации проверяйте, что набор платформ ожидаемый',
      );
    }
    log(`\nГотово: ${outDir}`);
  } finally {
    rmrf(stageRoot);
  }
}

main().catch((err) => {
  process.stderr.write(`\nОшибка: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
