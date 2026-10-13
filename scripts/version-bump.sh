#!/usr/bin/env bash
#
# version-bump.sh — обновление версии во всех пакетах монорепозитория
#
# Обновляет:
#   1. packages/shared/src/version.ts          — SYNTH_VERSION
#   2. packages/*/package.json                 — поле version
#   3. packages/synth/package.json             — поле version (публикуемый пакет)
#   4. charts/synth/Chart.yaml                 — version и appVersion (синхронно с релизом)
#
# Использование:
#   ./version-bump.sh 0.2.0                   — установить конкретную версию
#   ./version-bump.sh patch                   — авто-bump patch (0.1.2 → 0.1.3)
#   ./version-bump.sh minor                   — авто-bump minor (0.1.2 → 0.2.0)
#   ./version-bump.sh major                   — авто-bump major (0.1.2 → 1.0.0)
#   ./version-bump.sh --dry-run 0.2.0         — проверить без изменений
#
# Требования: Node.js >= 22

set -o pipefail

die() { echo "ОШИБКА: $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYNTH="$ROOT"
VERSION_FILE="$SYNTH/packages/shared/src/version.ts"

DRY_RUN=false
NEW_VERSION=""

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        patch|minor|major) NEW_VERSION="$arg" ;;
        *) NEW_VERSION="$arg" ;;
    esac
done

if [ -z "$NEW_VERSION" ]; then
    die "Укажите новую версию или тип bump (patch/minor/major)"
fi

CURRENT_VERSION=$(node -e "console.log(require('$SYNTH/packages/synth/package.json').version)")

# Если передан тип bump — вычисляем новую версию
case "$NEW_VERSION" in
    patch|minor|major)
        NEW_VERSION=$(node -e "
            const [major, minor, patch] = '$CURRENT_VERSION'.split('.').map(Number);
            const bump = '$NEW_VERSION';
            let v;
            if (bump === 'major') v = [major + 1, 0, 0];
            else if (bump === 'minor') v = [major, minor + 1, 0];
            else v = [major, minor, patch + 1];
            console.log(v.join('.'));
        ") || die "Не удалось вычислить новую версию"
        ;;
esac

echo "━━━ version-bump ━━━"
echo ""
echo "  Текущая версия: $CURRENT_VERSION"
echo "  Новая версия:   $NEW_VERSION"
echo ""

if [ "$NEW_VERSION" = "$CURRENT_VERSION" ]; then
    die "Новая версия совпадает с текущей"
fi

if $DRY_RUN; then
    echo "  --dry-run: проверка без изменений"
    echo ""
    echo "  Будет изменено:"
    echo "    $VERSION_FILE"
    for pkg in shared core backend ui runner sdk synth; do
        echo "    packages/$pkg/package.json"
    done
    echo "    charts/synth/Chart.yaml (version + appVersion)"
    echo ""
    echo "━━━ dry-run завершён ━━━"
    exit 0
fi

# Шаг 1: version.ts
echo "[1/4] Обновление $VERSION_FILE..."
TMP=$(mktemp)
sed "s/export const SYNTH_VERSION = '[^']*';/export const SYNTH_VERSION = '$NEW_VERSION';/" "$VERSION_FILE" > "$TMP"
mv "$TMP" "$VERSION_FILE"
echo "  готово"

# Шаг 2: package.json для всех пакетов (все синхронизируются с одной версией)
echo "[2/4] Обновление package.json..."
cd "$SYNTH" || die "Не удалось перейти в $SYNTH"

for pkg_dir in packages/shared packages/core packages/backend packages/ui packages/runner packages/sdk packages/synth; do
    if [ -f "$pkg_dir/package.json" ]; then
        node -e "
            const fs = require('fs');
            const p = require('./$pkg_dir/package.json');
            p.version = '$NEW_VERSION';
            fs.writeFileSync('./$pkg_dir/package.json', JSON.stringify(p, null, 2) + '\n');
        "
        echo "  $pkg_dir/package.json → $NEW_VERSION"
    fi
done
echo "  готово"

# Шаг 3: charts/synth/Chart.yaml (version + appVersion)
echo "[3/4] Обновление charts/synth/Chart.yaml..."
CHART_FILE="$SYNTH/charts/synth/Chart.yaml"
if [ -f "$CHART_FILE" ]; then
    TMP=$(mktemp)
    sed -E "s/^version: .*/version: $NEW_VERSION/; s/^appVersion: .*/appVersion: \"$NEW_VERSION\"/" "$CHART_FILE" > "$TMP"
    mv "$TMP" "$CHART_FILE"
    echo "  version/appVersion → $NEW_VERSION"
else
    echo "  пропуск: файл не найден"
fi

# Шаг 4: проверка на оставшиеся hardcoded строки
echo "[4/4] Проверка на оставшийся хардкод..."
FOUND=$(grep -rn "'$CURRENT_VERSION'" "$SYNTH/packages" --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v '/dist/' || true)
if [ -n "$FOUND" ]; then
    echo "  ⚠ Найдены ссылки на старую версию $CURRENT_VERSION:"
    echo "$FOUND"
    echo "  Обновите их вручную или добавьте в скрипт."
else
    echo "  OK — хардкод не найден"
fi

echo ""
echo "━━━ Готово ━━━"
echo ""
echo "Коммит:  git commit -am 'chore: bump version to v$NEW_VERSION'"
echo "Тег:     git tag v$NEW_VERSION"
echo "Релиз:   git push --follow-tags"
