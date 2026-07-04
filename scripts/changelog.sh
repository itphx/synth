#!/bin/bash
# Генерация CHANGELOG.md из коммитов между тегами
set -e

cd "$(dirname "$0")/.."

VERSION=$(node -e "console.log(require('./packages/synth/package.json').version)")
echo "Версия: $VERSION"

PREV_TAG=$(git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)

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
