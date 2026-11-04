#!/usr/bin/env bash
#
# beta-prune.sh — ретеншн бета-версий в npm-реестре Gitea (keep last N).
#
# Бета-пакеты публикуются часто (см. scripts/publish-beta.sh, workflow
# `.gitverse/workflows/beta.yaml`), а квота «Пакеты» в Gitea считает каждую
# версию отдельно. Скрипт оставляет N последних бета-версий (по semver, для
# каждого из 8 пакетов @itphx/*) и удаляет более старые.
#
# Осторожность по умолчанию:
#   * без `--yes` (и при `--dry-run`) скрипт только ПОКАЗЫВАЕТ план — ничего не
#     удаляет; безопасный default выбран намеренно, удаление необратимо;
#   * удаляются только версии с `-beta.` — релизные версии и dist-tag `latest`
#     не трогаются никогда;
#   * 404/«уже нет» при удалении — предупреждение, а не падение (повторный
#     прогон идемпотентен).
#
# Использование:
#   ./scripts/beta-prune.sh                          # план, keep=20
#   ./scripts/beta-prune.sh --keep 5                 # план, keep=5
#   ./scripts/beta-prune.sh --keep 5 --yes           # удалить всё лишнее
#   ./scripts/beta-prune.sh --dry-run --keep 5       # явный план
#
# Переменные окружения:
#   GITEA_NPM_TOKEN | GITEA_TOKEN | GV_GITEA_TOKEN — токен с правом удаления
#     пакетов (в CI — секрет GV_GITEA_TOKEN). Без токена — exit 1.
#
# Требования: node (сортировка semver), npm.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEFAULT_REGISTRY="https://git.itphx.ru/api/packages/itphx/npm/"
DEFAULT_PACKAGE="@itphx/synth"

# Порядок — как в релизе (scripts/publish-packages.sh): от фундамента к обёртке.
PACKAGES=(
    "@itphx/synth-shared"
    "@itphx/synth-core"
    "@itphx/synth-executor"
    "@itphx/synth-storage-postgres"
    "@itphx/synth-ui"
    "@itphx/synth-backend"
    "@itphx/synth-sdk"
    "@itphx/synth"
)

KEEP=20
REGISTRY="$DEFAULT_REGISTRY"
PACKAGE="$DEFAULT_PACKAGE"
DO_DELETE=0
DRY_RUN=0

usage() {
    cat <<'EOF'
beta-prune.sh — ретеншн бета-версий @itphx/* в npm-реестре Gitea.

Использование:
  ./scripts/beta-prune.sh [опции]

Опции:
  --keep N           сколько последних бета-версий оставить (по умолчанию 20)
  --registry URL     npm-реестр (по умолчанию https://git.itphx.ru/api/packages/itphx/npm/)
  --package NAME     пакет, по списку версий которого считается ретеншн
                     (по умолчанию @itphx/synth)
  --dry-run          только показать план (то же, что без --yes)
  --yes              реально удалить лишние версии (необратимо)
  --help, -h         эта справка

Поведение:
  * удаляются только версии с `-beta.`; релизные версии и dist-tag `latest`
    не затрагиваются;
  * удаление выполняется для всех 8 пакетов @itphx/* одной версии;
  * 404/«уже нет» — предупреждение, прогон продолжается.

Токен (право удалять пакеты) берётся из GITEA_NPM_TOKEN, затем GITEA_TOKEN,
затем GV_GITEA_TOKEN; без токена скрипт завершается с кодом 1.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --keep)
            KEEP="${2:-}"
            [ -n "$KEEP" ] || { echo "beta-prune.sh: --keep требует значение" >&2; exit 2; }
            shift 2
            ;;
        --keep=*)
            KEEP="${1#--keep=}"
            shift
            ;;
        --registry)
            REGISTRY="${2:-}"
            [ -n "$REGISTRY" ] || { echo "beta-prune.sh: --registry требует значение" >&2; exit 2; }
            shift 2
            ;;
        --registry=*)
            REGISTRY="${1#--registry=}"
            shift
            ;;
        --package)
            PACKAGE="${2:-}"
            [ -n "$PACKAGE" ] || { echo "beta-prune.sh: --package требует значение" >&2; exit 2; }
            shift 2
            ;;
        --package=*)
            PACKAGE="${1#--package=}"
            shift
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --yes)
            DO_DELETE=1
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "beta-prune.sh: неизвестный аргумент: $1" >&2
            echo "  справка: ./scripts/beta-prune.sh --help" >&2
            exit 2
            ;;
    esac
done

case "$KEEP" in
    ''|*[!0-9]*)
        echo "beta-prune.sh: --keep должен быть целым числом, получено: '$KEEP'" >&2
        exit 2
        ;;
esac
if [ "$KEEP" -lt 0 ]; then
    echo "beta-prune.sh: --keep не может быть отрицательным" >&2
    exit 2
fi

# --- Токен (право удалять пакеты) ---
TOKEN="${GITEA_NPM_TOKEN:-${GITEA_TOKEN:-${GV_GITEA_TOKEN:-}}}"
if [ -z "$TOKEN" ]; then
    echo "beta-prune.sh: токен не задан — удаление версий из реестра невозможно" >&2
    echo "  задайте GITEA_NPM_TOKEN (или GITEA_TOKEN / GV_GITEA_TOKEN);" >&2
    echo "  токену нужно право удалять пакеты в пространстве itphx." >&2
    exit 1
fi
# Временный npmrc ссылается на ${GITEA_NPM_TOKEN} — npm разворачивает env-переменные
# в .npmrc сам. Экспортируем, чтобы имя переменной не зависело от источника токена.
export GITEA_NPM_TOKEN="$TOKEN"

REGISTRY_BASE="${REGISTRY%/}"
REGISTRY_NOPROTO="${REGISTRY_BASE#http://}"
REGISTRY_NOPROTO="${REGISTRY_NOPROTO#https://}"
REGISTRY_NOPROTO="${REGISTRY_NOPROTO%/}/"

# --- Временные файлы (npmrc 0600 + список версий + сортировщик) ---
mkdir -p "$ROOT/tmp"
TMP_DIR="$(mktemp -d "$ROOT/tmp/beta-prune.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM

NPMRC="$TMP_DIR/npmrc"
cat > "$NPMRC" <<EOF
registry=${REGISTRY_BASE}/
//${REGISTRY_NOPROTO}:_authToken=\${GITEA_NPM_TOKEN}
EOF
chmod 600 "$NPMRC"

echo "━━━ beta-prune ━━━"
echo "  Реестр:   $REGISTRY_BASE"
echo "  Пакет:    $PACKAGE (по его списку версий)"
echo "  Оставить: $KEEP последних бета-версий"
if [ "$DO_DELETE" = "1" ] && [ "$DRY_RUN" != "1" ]; then
    echo "  Режим:    УДАЛЕНИЕ (--yes)"
else
    echo "  Режим:    план, без удаления (добавьте --yes чтобы удалить)"
fi
echo ""

# --- Список версий пакета ---
VERSIONS_FILE="$TMP_DIR/versions.json"
if ! npm view "$PACKAGE" versions --json --registry "$REGISTRY_BASE" \
        --userconfig "$NPMRC" > "$VERSIONS_FILE" 2> "$TMP_DIR/view.err"; then
    echo "✗ ОШИБКА: не удалось получить список версий $PACKAGE из $REGISTRY_BASE" >&2
    cat "$TMP_DIR/view.err" >&2
    exit 1
fi

# --- Сортировка semver (по убыванию) и выбор кандидатов ---
SORT_JS="$TMP_DIR/sort.mjs"
cat > "$SORT_JS" <<'NODE'
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const keep = Number(process.argv[3]);
const raw = JSON.parse(readFileSync(file, 'utf8'));
const list = Array.isArray(raw) ? raw : [raw];

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim());
  if (!m) return null;
  return {
    version: String(v).trim(),
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: (m[4] || '').split('.').filter(Boolean),
  };
};

// SemVer 2.0.0 §11: числовые идентификаторы сравниваются как числа, строковые —
// лексикографически, числовой < строкового, короткий набор < длинного.
const cmpPre = (a, b) => {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (nx) {
      return -1;
    } else if (ny) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
};

const cmp = (a, b) => {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return cmpPre(a.pre, b.pre);
};

const betas = list
  .map(parse)
  .filter((x) => x !== null && x.version.includes('-beta.'));

betas.sort((a, b) => cmp(b, a)); // по убыванию: первая — самая новая

const candidates = betas.slice(keep).map((x) => x.version);
console.error(
  `  бета-версий найдено: ${betas.length}; оставляем: ${betas.length - candidates.length}; кандидатов на удаление: ${candidates.length}`,
);
if (betas.length > 0 && candidates.length > 0) {
  console.error(`  оставляем версии: ${betas.slice(0, keep).map((x) => x.version).join(', ')}`);
}
process.stdout.write(candidates.length > 0 ? `${candidates.join('\n')}\n` : '');
NODE

CANDIDATES=()
CANDIDATES_FILE="$TMP_DIR/candidates.txt"
if ! node "$SORT_JS" "$VERSIONS_FILE" "$KEEP" > "$CANDIDATES_FILE"; then
    echo "✗ ОШИБКА: не удалось разобрать список версий $PACKAGE" >&2
    exit 1
fi
while IFS= read -r line; do
    [ -n "$line" ] && CANDIDATES+=("$line")
done < "$CANDIDATES_FILE"

if [ ${#CANDIDATES[@]} -eq 0 ]; then
    echo "Нечего удалять: бета-версий не больше $KEEP."
    exit 0
fi

echo ""
echo "Кандидаты на удаление (${#CANDIDATES[@]} версий × ${#PACKAGES[@]} пакетов):"
for v in "${CANDIDATES[@]}"; do
    echo "  - $v"
done
echo ""

if [ "$DO_DELETE" != "1" ] || [ "$DRY_RUN" = "1" ]; then
    echo "План показан, ничего не удалено."
    echo "Чтобы удалить перечисленные версии, повторите с --yes (необратимо)."
    exit 0
fi

# --- Удаление ---
# 404/«уже нет» — предупреждение (идемпотентный повторный прогон); прочие
# ошибки считаем и возвращаем код 1 после прохода по всем пакетам.
FAILED=0
for v in "${CANDIDATES[@]}"; do
    for pkg in "${PACKAGES[@]}"; do
        target="$pkg@$v"
        if output="$(npm unpublish "$target" --registry "$REGISTRY_BASE" \
                --userconfig "$NPMRC" --force 2>&1)"; then
            echo "  ✓ удалён $target"
        else
            case "$output" in
                *404*|*E404*|*"not found"*|*"Not Found"*|*"already unpublished"*)
                    echo "  ! $target уже отсутствует в реестре — пропускаем"
                    ;;
                *)
                    echo "  ✗ $target — ошибка удаления:" >&2
                    printf '%s\n' "$output" >&2
                    FAILED=$((FAILED + 1))
                    ;;
            esac
        fi
    done
done

echo ""
if [ "$FAILED" -gt 0 ]; then
    echo "✗ Готово с ошибками: не удалось удалить $FAILED пакето-версий (см. вывод выше)."
    exit 1
fi

echo "━━━ Готово: удалено ${#CANDIDATES[@]} версий × ${#PACKAGES[@]} пакетов ━━━"
