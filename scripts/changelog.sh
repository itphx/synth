#!/bin/bash
# Генерация тела релиза (changelog-partial.md) для GitVerse Release.
#
# Два режима:
#   1. Подготовленное описание — если существует docs/releases/<VERSION>.md,
#      файл копируется в changelog-partial.md как есть (структурированный текст,
#      написанный заранее).
#   2. Иначе (по умолчанию) — авто-сборка из коммитов между предыдущим тегом и
#      HEAD: feat → «Новые возможности», fix → «Исправления»,
#      chore/refactor/docs → «Прочее».
set -e

cd "$(dirname "$0")/.."

VERSION=$(node -e "console.log(require('./packages/synth/package.json').version)")
echo "Версия: $VERSION"

# Режим 1: подготовленное описание релиза — docs/releases/<VERSION>.md
if [ -f "docs/releases/$VERSION.md" ]; then
  cp "docs/releases/$VERSION.md" changelog-partial.md
  echo "Использовано подготовленное описание: docs/releases/$VERSION.md"
  exit 0
fi

# Режим 2: авто-сборка из коммитов между предыдущим тегом и HEAD
PREV_TAG=$(git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed -n '2p')

if [ -z "$PREV_TAG" ]; then
  echo "Предыдущий тег не найден — первый релиз"
  echo "## $VERSION ($(date +%Y-%m-%d)) — Первый релиз" > changelog-partial.md
  exit 0
fi

echo "Предыдущий тег: $PREV_TAG"

{
  echo "## $VERSION ($(date +%Y-%m-%d))"
  echo ""
  echo "### Новые возможности"
  git log "$PREV_TAG..HEAD" --no-merges --format="- %s" --grep="^feat[:(]" 2>/dev/null || echo "  (нет)"
  echo ""
  echo "### Исправления"
  git log "$PREV_TAG..HEAD" --no-merges --format="- %s" --grep="^fix[:(]" 2>/dev/null || echo "  (нет)"
  echo ""
  echo "### Прочее"
  git log "$PREV_TAG..HEAD" --no-merges --format="- %s" --grep="^chore[:(]" --grep="^refactor[:(]" --grep="^docs[:(]" 2>/dev/null || echo "  (нет)"
} > changelog-partial.md

echo "CHANGELOG сохранён в changelog-partial.md"
