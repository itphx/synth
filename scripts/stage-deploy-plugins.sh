#!/usr/bin/env bash
#
# stage-deploy-plugins.sh — подготовка deploy-плагинов для сборки образа.
#
# Что делает:
#   1. собирает in-tree плагин (`pnpm --filter @itphx/synth-plugin-memory build`,
#      self-contained ESM-бандл: внешние только `@itphx/*` — контракт
#      `inline`-загрузчика, node_modules бандла установщик НЕ переносит);
#   2. раскладывает `synth.pack` + `dist/index.js` в
#      `docker/plugins/<name>/` — каталог, который `docker/Dockerfile.backend`
#      копирует в образ (`/opt/synth/plugins`, стадия build, без runtime RUN);
#   3. печатает итог и — если собран `packages/core/dist` — вердикт встроенного
#      сканера (ADR-090): `caution` означает, что на инстансе потребуется
#      подтверждение установки (`approve`, TTL 24 ч), `dangerous` — бандл не
#      встанет.
#
# Идемпотентность: целевой каталог плагина очищается перед раскладкой, повторный
# запуск даёт тот же результат. Артефакты `docker/plugins/**` в git не попадают
# (.gitignore) и в репозиторий не коммитятся.
#
# Чего НЕ делает: не трогает версии (`packages/*/package.json`), не собирает
# образ, не пушит, не коммитит, не работает с секретами.
#
# Использование (из корня synth/):
#   scripts/stage-deploy-plugins.sh
#
# Требования: bash, pnpm, node.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT/packages/plugin-memory"
PLUGIN_NAME="synth-plugin-memory"
OUT_DIR="$ROOT/docker/plugins"
DEST="$OUT_DIR/$PLUGIN_NAME"

die() { echo "ОШИБКА: $*" >&2; exit 1; }
info() { echo "$*"; }

[[ -d "$PLUGIN_DIR" ]] || die "каталог плагина не найден: $PLUGIN_DIR"
[[ -f "$PLUGIN_DIR/synth.pack" ]] || die "манифест не найден: $PLUGIN_DIR/synth.pack"

info "── сборка $PLUGIN_NAME ──"
pnpm --filter "@itphx/synth-plugin-memory" build

[[ -f "$PLUGIN_DIR/dist/index.js" ]] || die "бандл не собран: $PLUGIN_DIR/dist/index.js"

info "── раскладка в docker/plugins/$PLUGIN_NAME ──"
rm -rf "$DEST" # идемпотентность: прошлая раскладка удаляется целиком
mkdir -p "$DEST/dist"
cp "$PLUGIN_DIR/synth.pack" "$DEST/synth.pack"
cp "$PLUGIN_DIR/dist/index.js" "$DEST/dist/index.js"

# Сверка манифеста и бандла — раскладка не должна разъезжаться с версией.
MANIFEST_NAME="$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DEST/synth.pack" | head -1)"
MANIFEST_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DEST/synth.pack" | head -1)"
[[ "$MANIFEST_NAME" == "$PLUGIN_NAME" ]] ||
    die "имя в synth.pack («$MANIFEST_NAME») не совпадает с каталогом («$PLUGIN_NAME»)"

info "  synth.pack:  $MANIFEST_NAME@$MANIFEST_VERSION"
info "  dist/index.js: $(wc -c <"$DEST/dist/index.js" | tr -d ' ') байт"

# Вердикт встроенного сканера — предупреждение, не блокировка: `caution`
# штатно закрывается подтверждением (`approve`) на инстансе.
SCANNER="$ROOT/packages/core/dist/engine/plugins/scan/index.js"
if [[ -f "$SCANNER" ]]; then
    info "── скан бандла (встроенный сканер) ──"
    node --input-type=module -e "
import { scanPluginDirectory } from '${SCANNER}';
const r = await scanPluginDirectory('${DEST}');
console.log('  verdict:', r.verdict, '| findings:', r.findings.length);
for (const f of r.findings.slice(0, 10)) console.log('  -', f.severity, f.category, f.file + ':' + f.line);
" || die "скан бандла не выполнился"
else
    info "  (скан пропущен: $SCANNER не собран — pnpm --filter @itphx/synth-core build)"
fi

info ""
info "Готово: $DEST"
info "Дальше (образ соберётся с этим каталогом): docker build -f docker/Dockerfile.backend ."
