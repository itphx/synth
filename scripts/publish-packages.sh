#!/usr/bin/env bash
#
# publish-packages.sh — идемпотентная публикация всех 6 пакетов в npm-реестр.
#
# Пропускает версии, которые уже опубликованы (повторные прогоны release
# не падают на "already exists"). Порядок публикации строгий:
#   shared → core → ui → backend → runner → synth
#
# Использование:
#   ./scripts/publish-packages.sh https://registry.npmjs.org
#   ./scripts/publish-packages.sh https://gitverse.ru/api/packages/itphx/npm/
#
# Требования: npm-токен уже настроен (npm config _authToken), pnpm установлен.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGISTRY="${1:?Укажите npm-реестр}"
VERSION=$(node -e "console.log(require('./packages/synth/package.json').version)")

echo "━━━ publish-packages ━━━"
echo "  Реестр:   $REGISTRY"
echo "  Версия:   $VERSION"
echo ""

PUBLISHED=0
SKIPPED=0

for pkg in shared core ui backend runner synth; do
    if [ "$pkg" = "synth" ]; then
        NAME="@itphx/synth"
    else
        NAME="@itphx/synth-$pkg"
    fi

    if pnpm view "$NAME@$VERSION" version --registry "$REGISTRY" >/dev/null 2>&1; then
        echo "  ✓ $NAME@$VERSION уже опубликован — пропускаем"
        SKIPPED=$((SKIPPED + 1))
    else
        echo "  📦 $NAME@$VERSION → $REGISTRY"
        (cd "packages/$pkg" && pnpm publish --access public --registry "$REGISTRY" --no-git-checks)
        PUBLISHED=$((PUBLISHED + 1))
    fi
done

echo ""
echo "━━━ Готово: опубликовано $PUBLISHED, пропущено $SKIPPED ━━━"
