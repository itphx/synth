#!/bin/bash
# Генерация тела релиза (по умолчанию changelog-partial.md).
#
# Использование:
#   scripts/changelog.sh [--lang ru|en] [--out <path>]
#   scripts/changelog.sh --help
#
# Опции:
#   --lang <ru|en>  Язык описания релиза (по умолчанию: ru).
#   --out <path>    Куда писать результат (по умолчанию: changelog-partial.md).
#   -h, --help      Показать справку.
#
# Источники (берётся первый найденный, файл копируется целиком):
#   --lang ru  → docs/releases/<VERSION>.md
#   --lang en  → docs/releases/<VERSION>.en.md, иначе docs/releases/<VERSION>.md
#                (фоллбек на русское описание с предупреждением)
# Если ни одного файла нет — авто-сборка из коммитов между предыдущим тегом и HEAD:
#   feat → «Новые возможности», fix → «Исправления»,
#   chore/refactor/docs → «Прочее».
#
# <VERSION> — версия из packages/synth/package.json.
set -e

cd "$(dirname "$0")/.."

usage() {
  cat <<'USAGE'
Генерация тела релиза.

Использование:
  scripts/changelog.sh [--lang ru|en] [--out <path>]

Опции:
  --lang <ru|en>  Язык описания релиза (по умолчанию: ru).
  --out <path>    Куда писать результат (по умолчанию: changelog-partial.md).
  -h, --help      Показать эту справку.

Источники:
  ru  — docs/releases/<VERSION>.md
  en  — docs/releases/<VERSION>.en.md, иначе docs/releases/<VERSION>.md (фоллбек)
Если файла нет — авто-сборка из коммитов между предыдущим тегом и HEAD.
USAGE
}

LANG_KIND=ru
OUT=changelog-partial.md

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --lang)
      if [ -z "${2:-}" ]; then
        echo "Ошибка: --lang требует значение (ru|en)" >&2
        exit 2
      fi
      LANG_KIND="$2"
      shift 2
      ;;
    --lang=*)
      LANG_KIND="${1#--lang=}"
      shift
      ;;
    --out)
      if [ -z "${2:-}" ]; then
        echo "Ошибка: --out требует путь" >&2
        exit 2
      fi
      OUT="$2"
      shift 2
      ;;
    --out=*)
      OUT="${1#--out=}"
      shift
      ;;
    *)
      echo "Ошибка: неизвестный аргумент '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$LANG_KIND" in
  ru|en) ;;
  *)
    echo "Ошибка: неизвестный язык описания '$LANG_KIND' (допустимо: ru, en)" >&2
    exit 2
    ;;
esac

VERSION=$(node -e "console.log(require('./packages/synth/package.json').version)")
echo "Версия: $VERSION"
echo "Язык описания: $LANG_KIND → $OUT"

RU_FILE="docs/releases/$VERSION.md"
EN_FILE="docs/releases/$VERSION.en.md"

# Подготовленное описание релиза: EN-файл (для --lang en) или RU-файл.
SRC=""
if [ "$LANG_KIND" = "en" ]; then
  if [ -f "$EN_FILE" ]; then
    SRC="$EN_FILE"
  elif [ -f "$RU_FILE" ]; then
    echo "[changelog] НЕТ английского описания $EN_FILE — использую русское $RU_FILE" >&2
    SRC="$RU_FILE"
  fi
else
  if [ -f "$RU_FILE" ]; then
    SRC="$RU_FILE"
  fi
fi

if [ -n "$SRC" ]; then
  cp "$SRC" "$OUT"
  echo "Использовано подготовленное описание: $SRC"
  exit 0
fi

if [ "$LANG_KIND" = "en" ]; then
  echo "[changelog] НЕТ английского описания $EN_FILE — авто-сборка из коммитов" >&2
fi

# Авто-сборка из коммитов между предыдущим тегом и HEAD
PREV_TAG=$(git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed -n '2p')

if [ -z "$PREV_TAG" ]; then
  echo "Предыдущий тег не найден — первый релиз"
  echo "## $VERSION ($(date +%Y-%m-%d)) — Первый релиз" > "$OUT"
  echo "CHANGELOG сохранён в $OUT"
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
} > "$OUT"

echo "CHANGELOG сохранён в $OUT"
