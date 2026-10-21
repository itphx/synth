#!/bin/bash
# Сбор фактов релиза и публикация события релиза в Synth (ADR-089).
#
# Куда: API внешних событий Synth — POST {SYNTH_URL}/api/v2/events
#   (Authorization: Bearer <service-key со scope events:ingest>).
#   Ответ: 201 {event, decision, sessionId}.
#   Router (ADR-089) маршрутизирует событие по правилу
#   source=ci / type=release_published в ephemeral-сессию агента publisher —
#   агент по скиллу media-hub готовит черновик поста о релизе.
#
# Почему факты собирает CI-хук, а не агент: агент внутри Synth НЕ имеет
# доступа к репозиторию (workspace-политика deny, файловые/гит-тулы требуют
# workspace проекта). Поэтому в payload уходит всё, что нужно агенту для
# текста поста: версия, тег, highlights, коммиты, новые AD и changelog.
#
# Использование:
#   scripts/media-release-event.sh [--dry-run] [--url <URL>] [--key <KEY>]
#                                  [--tag <TAG>] [--version <VERSION>]
#                                  [--changelog <FILE>] [--repo <URL>]
#                                  [--max-highlights <N>] [--max-commits <N>]
#   scripts/media-release-event.sh --help
#
# Env (альтернатива флагам):
#   SYNTH_URL            — базовый URL Synth: …/api/v2, …/api/v2/events или
#                          host (тогда добавится /api/v2/events);
#   SYNTH_MEDIA_KEY      — service-key со scope events:ingest;
#   SYNTH_RELEASE_TAG    — тег релиза (допустим и refs/tags/vX.Y.Z);
#   SYNTH_RELEASE_VERSION— версия релиза.
#
# Коды возврата:
#   0 — событие опубликовано; либо --dry-run; либо публикация не настроена
#       (нет URL/ключа) — тогда публикация просто пропускается с предупреждением;
#   2 — ошибка использования (неизвестный флаг, отсутствующее значение);
#   3 — событие собрано, но не опубликовано (сеть, не-2xx, невалидный JSON).
#       Публикация поста о релизе НЕ должна блокировать релиз: джоба
#       media-event в .gitverse/workflows/release.yaml идёт с
#       continue-on-error: true, а джоба публикуется после create-release.
#
# Скрипт только читает репозиторий и отправляет ОДНО событие: ничего не
# коммитит, ничего не пушит, секреты не печатает.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ORIG_CWD="$PWD"

# --- параметры по умолчанию ------------------------------------------------
DRY_RUN=0
URL_ARG=""
KEY_ARG=""
TAG_ARG=""
VERSION_ARG=""
CHANGELOG_ARG=""
REPO_ARG=""
MAX_HIGHLIGHTS=7
MAX_COMMITS=100

SOURCE="ci"
TYPE="release_published"
SEMVER_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

TMP=""

usage() {
  cat <<'USAGE'
Публикация события релиза в Synth (ADR-089) для подсистемы synth-media.

Использование:
  scripts/media-release-event.sh [--dry-run] [--url <URL>] [--key <KEY>]
                                 [--tag <TAG>] [--version <VERSION>]
                                 [--changelog <FILE>] [--repo <URL>]
                                 [--max-highlights <N>] [--max-commits <N>]

Опции:
  --dry-run             собрать событие и напечатать JSON (ничего не отправлять);
  --url <URL>           базовый URL Synth (…/api/v2 или полный …/api/v2/events);
  --key <KEY>           service-key со scope events:ingest;
  --tag <TAG>           тег релиза (например v0.11.3);
  --version <VERSION>   версия релиза;
  --changelog <FILE>    файл с описанием релиза (по умолчанию: changelog-partial.md —
                        артефакт джобы changelog, затем docs/releases/<VERSION>.md,
                        затем генерация scripts/changelog.sh, затем CHANGELOG.md);
  --repo <URL>          URL репозитория (по умолчанию remote.origin.url);
  --max-highlights <N>  сколько highlights взять из changelog (по умолчанию 7);
  --max-commits <N>     сколько коммитов включить (по умолчанию 100);
  -h, --help            показать эту справку.

Env:
  SYNTH_URL, SYNTH_MEDIA_KEY, SYNTH_RELEASE_TAG, SYNTH_RELEASE_VERSION.

Коды возврата: 0 — ок (в т.ч. dry-run и « публикация не настроена»),
2 — ошибка использования, 3 — собрано, но не опубликовано.
USAGE
}

log()  { printf '[media-event] %s\n' "$*" >&2; }
warn() { printf '[media-event] ⚠️  ПРЕДУПРЕЖДЕНИЕ: %s\n' "$*" >&2; }
die()  { printf '[media-event] ОШИБКА: %s\n' "$*" >&2; exit "${2:-2}"; }

# shellcheck disable=SC2329  # вызывается через trap cleanup EXIT
cleanup() {
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT

# --- разбор аргументов -----------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --url)     [ $# -ge 2 ] || die "--url требует значение"; URL_ARG="$2"; shift 2 ;;
    --url=*)   URL_ARG="${1#--url=}"; shift ;;
    --key)     [ $# -ge 2 ] || die "--key требует значение"; KEY_ARG="$2"; shift 2 ;;
    --key=*)   KEY_ARG="${1#--key=}"; shift ;;
    --tag)     [ $# -ge 2 ] || die "--tag требует значение"; TAG_ARG="$2"; shift 2 ;;
    --tag=*)   TAG_ARG="${1#--tag=}"; shift ;;
    --version) [ $# -ge 2 ] || die "--version требует значение"; VERSION_ARG="$2"; shift 2 ;;
    --version=*) VERSION_ARG="${1#--version=}"; shift ;;
    --changelog) [ $# -ge 2 ] || die "--changelog требует значение"; CHANGELOG_ARG="$2"; shift 2 ;;
    --changelog=*) CHANGELOG_ARG="${1#--changelog=}"; shift ;;
    --repo)    [ $# -ge 2 ] || die "--repo требует значение"; REPO_ARG="$2"; shift 2 ;;
    --repo=*)  REPO_ARG="${1#--repo=}"; shift ;;
    --max-highlights) [ $# -ge 2 ] || die "--max-highlights требует значение"; MAX_HIGHLIGHTS="$2"; shift 2 ;;
    --max-highlights=*) MAX_HIGHLIGHTS="${1#--max-highlights=}"; shift ;;
    --max-commits) [ $# -ge 2 ] || die "--max-commits требует значение"; MAX_COMMITS="$2"; shift 2 ;;
    --max-commits=*) MAX_COMMITS="${1#--max-commits=}"; shift ;;
    *) die "неизвестный аргумент '$1' (см. --help)" ;;
  esac
done

case "$MAX_HIGHLIGHTS" in (''|*[!0-9]*) die "--max-highlights должен быть числом" ;; esac
case "$MAX_COMMITS" in (''|*[!0-9]*) die "--max-commits должен быть числом" ;; esac

# Пути, заданные относительно текущего каталога, разрешаем до смены cwd.
if [ -n "$CHANGELOG_ARG" ] && [ "${CHANGELOG_ARG#/}" = "$CHANGELOG_ARG" ]; then
  CHANGELOG_ARG="$ORIG_CWD/$CHANGELOG_ARG"
fi

cd "$REPO_ROOT"

TMP="$(mktemp -d)"

# --- инструмент для JSON ----------------------------------------------------
if command -v jq >/dev/null 2>&1; then
  JSON_TOOL="jq"
elif command -v python3 >/dev/null 2>&1; then
  JSON_TOOL="python3"
else
  warn "не найдены ни jq, ни python3 — собрать JSON события нечем"
  exit 3
fi
log "инструмент JSON: $JSON_TOOL"

# --- сбор фактов ------------------------------------------------------------

# Все semver-теги по убыванию версии (логика как в scripts/changelog.sh).
semver_tags() {
  git tag --sort=-v:refname 2>/dev/null | grep -E "$SEMVER_TAG_RE" || true
}

# Тег релиза: явный аргумент → env → тег на HEAD.
# Если HEAD не помечен (локальная сборка/разработка) — тег выводится из версии.
detect_tag() {
  local t=""
  if [ -n "$TAG_ARG" ]; then t="$TAG_ARG"; fi
  if [ -z "$t" ] && [ -n "${SYNTH_RELEASE_TAG:-}" ]; then t="$SYNTH_RELEASE_TAG"; fi
  t="${t#refs/tags/}"
  if [ -n "$t" ] && ! grep -Eq "$SEMVER_TAG_RE" <<< "$t"; then
    t="" # не тег (например refs/heads/master) — ищем дальше
  fi
  if [ -n "$t" ]; then printf '%s' "$t"; return 0; fi
  git tag --points-at HEAD 2>/dev/null | grep -E "$SEMVER_TAG_RE" | head -1 || true
}

# Предыдущий тег: тот, что стоит в списке версий перед текущим.
detect_prev_tag() {
  local all prev
  all="$(semver_tags)"
  if [ -n "$TAG" ] && grep -qx "$TAG" <<< "$all"; then
    prev="$(printf '%s\n' "$all" | grep -vx "$TAG" | head -1 || true)"
  else
    prev="$(printf '%s\n' "$all" | head -1 || true)"
  fi
  printf '%s' "$prev"
}

# URL репозитория: аргумент → remote.origin.url (scp-подобный → https).
detect_repo_url() {
  local u
  if [ -n "$REPO_ARG" ]; then
    u="$REPO_ARG"
  else
    u="$(git config --get remote.origin.url 2>/dev/null || true)"
  fi
  if grep -Eq '^[^/@:]+@[^/:]+:.+$' <<< "$u"; then
    u="$(printf '%s' "$u" | sed -E 's|^[^/@:]+@([^/:]+):(.*)$|https://\1/\2|')"
  fi
  printf '%s' "$u"
}

TAG="$(detect_tag)"
PREV_TAG="$(detect_prev_tag)"

# Конец диапазона: сам тег, если он есть в репозитории, иначе HEAD.
RANGE_END="HEAD"
if [ -n "$TAG" ] && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  RANGE_END="$TAG"
fi

# Версия: аргумент → env → из тега → из package.json (текущая версия в разработке).
VERSION=""
if [ -n "$VERSION_ARG" ]; then VERSION="$VERSION_ARG"; fi
if [ -z "$VERSION" ] && [ -n "${SYNTH_RELEASE_VERSION:-}" ]; then VERSION="$SYNTH_RELEASE_VERSION"; fi
if [ -z "$VERSION" ] && [ -n "$TAG" ]; then VERSION="${TAG#v}"; fi
if [ -z "$VERSION" ] && [ -f "packages/synth/package.json" ]; then
  VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' packages/synth/package.json | head -1 || true)"
fi

# Описание релиза: аргумент → changelog-partial.md (артефакт джобы changelog)
# → docs/releases/<VERSION>.md (подготовленное описание, как в changelog.sh)
# → генерация scripts/changelog.sh (логика не дублируется)
# → CHANGELOG.md (последний резерв).
CHANGELOG_FILE=""
if [ -n "$CHANGELOG_ARG" ] && [ -f "$CHANGELOG_ARG" ]; then
  CHANGELOG_FILE="$CHANGELOG_ARG"
elif [ -n "$CHANGELOG_ARG" ]; then
  warn "файл '$CHANGELOG_ARG' не найден — ищу другие источники описания релиза"
fi
if [ -z "$CHANGELOG_FILE" ] && [ -f "changelog-partial.md" ]; then
  CHANGELOG_FILE="$REPO_ROOT/changelog-partial.md"
fi
if [ -z "$CHANGELOG_FILE" ] && [ -n "$VERSION" ] && [ -f "docs/releases/$VERSION.md" ]; then
  CHANGELOG_FILE="$REPO_ROOT/docs/releases/$VERSION.md"
fi
if [ -z "$CHANGELOG_FILE" ]; then
  if bash "$REPO_ROOT/scripts/changelog.sh" --out "$TMP/changelog.md" >"$TMP/changelog.log" 2>&1; then
    CHANGELOG_FILE="$TMP/changelog.md"
  else
    warn "scripts/changelog.sh не отработал: $(head -c 300 "$TMP/changelog.log" 2>/dev/null || true)"
    CHANGELOG_FILE=""
  fi
fi
if [ -z "$CHANGELOG_FILE" ] && [ -f "CHANGELOG.md" ]; then
  CHANGELOG_FILE="$REPO_ROOT/CHANGELOG.md"
fi
if [ -z "$CHANGELOG_FILE" ]; then
  warn "не найдено описание релиза — событие уйдёт без changelog"
  : > "$TMP/changelog.md"
  CHANGELOG_FILE="$TMP/changelog.md"
fi
if [ "$CHANGELOG_FILE" != "$TMP/changelog.md" ]; then
  cp "$CHANGELOG_FILE" "$TMP/changelog.md"
fi

# Версия из заголовка описания релиза — если не нашлась раньше.
if [ -z "$VERSION" ]; then
  VERSION="$(sed -n 's/^##[[:space:]]\{1,\}\([^ (]*\).*/\1/p' "$TMP/changelog.md" 2>/dev/null | head -1 || true)"
fi
if [ -z "$VERSION" ]; then
  warn "не удалось определить версию релиза"
  exit 3
fi

PREV_VERSION=""
if [ -n "$PREV_TAG" ]; then PREV_VERSION="${PREV_TAG#v}"; fi
if [ -z "$TAG" ]; then TAG="v$VERSION"; fi

# Дата релиза: дата тега → дата в заголовке changelog → сегодня (UTC).
DATE=""
if [ -n "$TAG" ] && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  DATE="$(git log -1 --format=%cs "$TAG" 2>/dev/null || true)"
fi
if [ -z "$DATE" ]; then
  DATE="$(sed -n 's/^##[[:space:]]\{1,\}[^ (]*[[:space:]]*(\([0-9-]\{1,\}\)).*/\1/p' "$TMP/changelog.md" 2>/dev/null | head -1 || true)"
fi
if [ -z "$DATE" ]; then DATE="$(date -u +%Y-%m-%d)"; fi

REPO_URL="$(detect_repo_url)"

# Коммиты PREV..TAG (без merge-коммитов).
: > "$TMP/commits.tsv"
if [ -n "$PREV_TAG" ]; then
  git log "$PREV_TAG..$RANGE_END" --no-merges --pretty=format:'%H%x09%s' > "$TMP/commits.tsv" 2>/dev/null || true
else
  git log "$RANGE_END" --no-merges --pretty=format:'%H%x09%s' > "$TMP/commits.tsv" 2>/dev/null || true
fi
TOTAL_COMMITS="$(grep -c '' "$TMP/commits.tsv" 2>/dev/null || true)"
TOTAL_COMMITS="${TOTAL_COMMITS:-0}"
if [ "$TOTAL_COMMITS" -gt "$MAX_COMMITS" ]; then
  warn "коммитов $TOTAL_COMMITS — в payload попадут первые $MAX_COMMITS"
  head -n "$MAX_COMMITS" "$TMP/commits.tsv" > "$TMP/commits.capped.tsv"
  mv "$TMP/commits.capped.tsv" "$TMP/commits.tsv"
fi

# Новые AD/PROP: файлы, добавленные в docs/arch_decisions/ после прошлого релиза.
: > "$TMP/new-ad-files.txt"
if [ -n "$PREV_TAG" ]; then
  git diff --diff-filter=A --name-only "$PREV_TAG..$RANGE_END" -- docs/arch_decisions/ > "$TMP/new-ad-files.txt" 2>/dev/null || true
elif [ -d "docs/arch_decisions" ]; then
  for adfile in docs/arch_decisions/*.md; do
    [ -e "$adfile" ] || continue
    basename "$adfile"
  done > "$TMP/new-ad-files.txt" || true
fi

# Индекс AD из AGENTS.md: id → суть, статус.
awk -F'|' '
  /^\|[[:space:]]*(ADR|PROP)-[0-9]+[[:space:]]*\|/ {
    id = $2; title = $3; status = $4
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", id)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", title)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", status)
    if (id != "") print id "\t" title "\t" status
  }
' AGENTS.md > "$TMP/ad-index.tsv" 2>/dev/null || true

: > "$TMP/ads.tsv"
while IFS= read -r adfile; do
  [ -n "$adfile" ] || continue
  base="$(basename "$adfile")"
  adid=""
  if [[ "$base" =~ ^adr-([0-9]+)- ]]; then
    adid="ADR-${BASH_REMATCH[1]}"
  elif [[ "$base" =~ ^prop-([0-9]+)- ]]; then
    adid="PROP-${BASH_REMATCH[1]}"
  elif [[ "$base" =~ ^ad-([0-9]+)- ]]; then
    adid="AD-${BASH_REMATCH[1]}"
  fi
  [ -n "$adid" ] || continue
  row="$(awk -F'\t' -v want="$adid" '$1 == want { print; exit }' "$TMP/ad-index.tsv")"
  adtitle=""
  adstatus=""
  if [ -n "$row" ]; then
    adtitle="$(printf '%s' "$row" | cut -f2)"
    adstatus="$(printf '%s' "$row" | cut -f3)"
  fi
  printf '%s\t%s\t%s\n' "$adid" "$adtitle" "$adstatus" >> "$TMP/ads.tsv"
done < "$TMP/new-ad-files.txt"

# Highlights из changelog: без markdown-заголовков, сперва вводный абзац,
# затем пункты списка.
extract_highlights() {
  awk -v max="$MAX_HIGHLIGHTS" '
    function flush_para() {
      if (para != "") { paras[++np] = para; para = "" }
    }
    {
      line = $0
      sub(/\r$/, "", line)
      if (line ~ /^[[:space:]]*$/) { flush_para(); next }
      if (line ~ /^[[:space:]]*#/) { flush_para(); next }
      sub(/^[[:space:]]+/, "", line)
      if (line ~ /^[-*+][[:space:]]/) {
        flush_para()
        sub(/^[-*+][[:space:]]+/, "", line)
        bullets[++nb] = line
        next
      }
      if (para == "") para = line; else para = para " " line
    }
    END {
      flush_para()
      count = 0
      for (i = 1; i <= np && count < max; i++) { print paras[i]; count++ }
      for (i = 1; i <= nb && count < max; i++) { print bullets[i]; count++ }
    }
  ' "$1"
}

extract_highlights "$TMP/changelog.md" > "$TMP/highlights.txt"

# --- сборка события ---------------------------------------------------------
DEDUP_KEY="$SOURCE:release:$TAG"

if [ "$JSON_TOOL" = "jq" ]; then
  jq -n \
    --arg source "$SOURCE" \
    --arg type "$TYPE" \
    --arg dedupKey "$DEDUP_KEY" \
    --arg version "$VERSION" \
    --arg previousVersion "$PREV_VERSION" \
    --arg tag "$TAG" \
    --arg date "$DATE" \
    --arg repo "$REPO_URL" \
    --rawfile changelog "$TMP/changelog.md" \
    --rawfile highlights "$TMP/highlights.txt" \
    --rawfile commits "$TMP/commits.tsv" \
    --rawfile ads "$TMP/ads.tsv" \
    '{
       source: $source,
       type: $type,
       dedupKey: $dedupKey,
       payload: {
         kind: "release",
         version: $version,
         previousVersion: $previousVersion,
         tag: $tag,
         date: $date,
         repo: $repo,
         highlights: ($highlights | split("\n") | map(select(length > 0))),
         commits: ($commits | split("\n") | map(select(length > 0))
                   | map(split("\t")) | map({ sha: .[0], subject: (.[1] // "") })),
         ads: ($ads | split("\n") | map(select(length > 0))
               | map(split("\t")) | map({ id: .[0], title: (.[1] // ""), status: (.[2] // "") })),
         changelog: $changelog
       }
     }' > "$TMP/event.json"
else
  EVENT_SOURCE="$SOURCE" \
  EVENT_TYPE="$TYPE" \
  EVENT_DEDUP_KEY="$DEDUP_KEY" \
  EVENT_VERSION="$VERSION" \
  EVENT_PREVIOUS_VERSION="$PREV_VERSION" \
  EVENT_TAG="$TAG" \
  EVENT_DATE="$DATE" \
  EVENT_REPO="$REPO_URL" \
  python3 - "$TMP" "$TMP/event.json" <<'PY'
import json, os, pathlib, sys

tmp = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])


def read(name):
    path = tmp / name
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def lines(name):
    return [ln for ln in read(name).split("\n") if ln != ""]


commits = []
for line in lines("commits.tsv"):
    parts = line.split("\t")
    commits.append({"sha": parts[0], "subject": parts[1] if len(parts) > 1 else ""})

ads = []
for line in lines("ads.tsv"):
    parts = line.split("\t")
    ads.append({
        "id": parts[0],
        "title": parts[1] if len(parts) > 1 else "",
        "status": parts[2] if len(parts) > 2 else "",
    })

event = {
    "source": os.environ.get("EVENT_SOURCE", ""),
    "type": os.environ.get("EVENT_TYPE", ""),
    "dedupKey": os.environ.get("EVENT_DEDUP_KEY", ""),
    "payload": {
        "kind": "release",
        "version": os.environ.get("EVENT_VERSION", ""),
        "previousVersion": os.environ.get("EVENT_PREVIOUS_VERSION", ""),
        "tag": os.environ.get("EVENT_TAG", ""),
        "date": os.environ.get("EVENT_DATE", ""),
        "repo": os.environ.get("EVENT_REPO", ""),
        "highlights": lines("highlights.txt"),
        "commits": commits,
        "ads": ads,
        "changelog": read("changelog.md"),
    },
}

out.write_text(json.dumps(event, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
fi

# Проверка, что событие — валидный JSON.
if [ "$JSON_TOOL" = "jq" ]; then
  if ! jq -e . "$TMP/event.json" >/dev/null 2>&1; then
    warn "собранное событие — невалидный JSON (см. $TMP/event.json)"
    exit 3
  fi
else
  if ! python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$TMP/event.json" 2>/dev/null; then
    warn "собранное событие — невалидный JSON"
    exit 3
  fi
fi

log "версия: $VERSION (было: ${PREV_VERSION:-—}); тег: $TAG; дата: $DATE"
log "highlights: $(grep -c '' "$TMP/highlights.txt" 2>/dev/null || echo 0); коммитов: $(grep -c '' "$TMP/commits.tsv" 2>/dev/null || echo 0); новых AD: $(grep -c '' "$TMP/ads.tsv" 2>/dev/null || echo 0)"
log "dedupKey: $DEDUP_KEY"

# --- dry-run ----------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  cat "$TMP/event.json"
  log "dry-run: событие не отправлено"
  exit 0
fi

# --- публикация -------------------------------------------------------------
URL="${URL_ARG:-${SYNTH_URL:-}}"
KEY="${KEY_ARG:-${SYNTH_MEDIA_KEY:-}}"

if [ -z "$URL" ] || [ -z "$KEY" ]; then
  warn "не заданы SYNTH_URL/SYNTH_MEDIA_KEY — публикация события релиза пропущена (функция не настроена для этого инстанса)"
  exit 0
fi

# Нормализация URL: …/api/v2/events, …/api/v2 или host.
EVENTS_URL="${URL%/}"
case "$EVENTS_URL" in
  */api/v2/events|*/events) : ;;
  */api/v2) EVENTS_URL="$EVENTS_URL/events" ;;
  *) EVENTS_URL="$EVENTS_URL/api/v2/events" ;;
esac

HTTP_CODE=""
CURL_ERR="$TMP/curl.err"
if ! HTTP_CODE="$(curl -sS -o "$TMP/response.json" -w '%{http_code}' \
      --max-time 30 --retry 0 \
      -X POST "$EVENTS_URL" \
      -H "Authorization: Bearer $KEY" \
      -H "Content-Type: application/json" \
      --data-binary "@$TMP/event.json" 2>"$CURL_ERR")"; then
  warn "событие не отправлено (Synth недоступен): $(head -c 300 "$CURL_ERR" 2>/dev/null || true)"
  warn "релиз не заблокирован — пост о релизе не будет подготовлен автоматически"
  exit 3
fi

case "$HTTP_CODE" in
  2??) : ;;
  *)
    warn "Synth ответил HTTP $HTTP_CODE: $(head -c 300 "$TMP/response.json" 2>/dev/null || true)"
    warn "релиз не заблокирован — пост о релизе не будет подготовлен автоматически"
    exit 3
    ;;
esac

SESSION_ID=""
if [ "$JSON_TOOL" = "jq" ]; then
  SESSION_ID="$(jq -r '.sessionId // "-"' "$TMP/response.json" 2>/dev/null || echo '-')"
else
  SESSION_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("sessionId") or "-")' "$TMP/response.json" 2>/dev/null || echo '-')"
fi
log "событие релиза принято (HTTP $HTTP_CODE), sessionId: $SESSION_ID"
exit 0
