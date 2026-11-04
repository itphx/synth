#!/usr/bin/env bash
#
# publish-beta.sh — быстрая бета-публикация всех 8 пакетов в Gitea.
#
# Собирает ТЕКУЩЕЕ рабочее дерево (без релизного коммита и тега), подставляет
# бету-версию во все 8 package.json + packages/shared/src/version.ts,
# собирает пакеты и публикует их в npm-реестр Gitea под заданным dist-tag.
# Исходные версии восстанавливаются trap'ом при любом завершении (успех,
# ошибка, Ctrl-C, TERM) — байт-в-байт из бэкапа.
#
# Версия: ${BASE}-beta.<UTC timestamp>.<git sha8>[.dirty]
#   BASE — --base или следующий patch от текущей версии (prerelease отброшен).
#
# Использование:
#   GITEA_NPM_TOKEN=… ./scripts/publish-beta.sh --base 0.13.4
#   ./scripts/publish-beta.sh --base 0.13.4 --tag beta
#   ./scripts/publish-beta.sh --dry-run --no-build --base 0.13.4
#
# Переменные окружения:
#   GITEA_NPM_TOKEN     — токен публикации (приоритет).
#   GITEA_TOKEN         — fallback-токен.
#   GV_GITEA_TOKEN      — ещё один fallback.
#   GITEA_NPM_REGISTRY  — реестр (default: https://git.itphx.ru/api/packages/itphx/npm/).
#
# Требования: Node.js >= 22, pnpm; git желателен (без него rev = nogit).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PKG_DIRS=(shared core executor storage-postgres backend ui sdk synth)
DEFAULT_REGISTRY="https://git.itphx.ru/api/packages/itphx/npm/"

usage() {
    cat <<'EOF'
publish-beta.sh — бета-публикация 8 npm-пакетов Synth в Gitea

Использование:
  ./scripts/publish-beta.sh [--base X.Y.Z] [--tag beta|next] [--registry URL]
                            [--no-build] [--no-smoke] [--skip-install] [--dry-run]
                            [--restore-dist] [--help]

Флаги:
  --base X.Y.Z      Базовая версия (по умолчанию следующий patch от текущей).
  --tag NAME        dist-tag публикации: beta|next (по умолчанию beta).
  --registry URL    npm-реестр (по умолчанию GITEA_NPM_REGISTRY или
                    https://git.itphx.ru/api/packages/itphx/npm/).
  --no-build        Не запускать pnpm build — публиковать уже собранное.
  --no-smoke        Не проверять установку @itphx/synth@<tag> после публикации.
  --skip-install    Не запускать pnpm install --frozen-lockfile.
  --dry-run         Показать версию, пакеты и команды, ничего не публиковать.
  --restore-dist    После публикации и восстановления исходных версий
                    пересобрать @itphx/synth-shared и @itphx/synth-ui, чтобы
                    dist/ соответствовал исходной версии.
  -h, --help        Показать эту справку.

Переменные окружения:
  GITEA_NPM_TOKEN     Токен публикации (приоритет).
  GITEA_TOKEN         Fallback-токен.
  GV_GITEA_TOKEN      Ещё один fallback.
  GITEA_NPM_REGISTRY  Реестр по умолчанию.

Примеры:
  GITEA_NPM_TOKEN=… ./scripts/publish-beta.sh --base 0.13.4
  ./scripts/publish-beta.sh --base 0.13.4 --tag beta
  ./scripts/publish-beta.sh --dry-run --no-build --base 0.13.4
EOF
}

die() {
    echo "ОШИБКА: $*" >&2
    exit 1
}

die_usage() {
    echo "ОШИБКА: $*" >&2
    echo "Подсказка: ./scripts/publish-beta.sh --help" >&2
    exit 2
}

# ─── Разбор аргументов ────────────────────────────────────────────────────────
BASE=""
BASE_SET=0
TAG="beta"
TAG_SET=0
REGISTRY="${GITEA_NPM_REGISTRY:-$DEFAULT_REGISTRY}"
INSTALL=1
BUILD=1
SMOKE=1
DRY_RUN=0
RESTORE_DIST=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --base)
            [ "$#" -ge 2 ] || die_usage "--base требует значение X.Y.Z"
            BASE="$2"; BASE_SET=1; shift 2 ;;
        --base=*)
            BASE="${1#*=}"; BASE_SET=1; shift ;;
        --tag)
            [ "$#" -ge 2 ] || die_usage "--tag требует значение (beta|next)"
            TAG="$2"; TAG_SET=1; shift 2 ;;
        --tag=*)
            TAG="${1#*=}"; TAG_SET=1; shift ;;
        --registry)
            [ "$#" -ge 2 ] || die_usage "--registry требует URL"
            REGISTRY="$2"; shift 2 ;;
        --registry=*)
            REGISTRY="${1#*=}"; shift ;;
        --no-build) BUILD=0; shift ;;
        --no-smoke) SMOKE=0; shift ;;
        --skip-install) INSTALL=0; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --restore-dist) RESTORE_DIST=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die_usage "неизвестный аргумент: $1" ;;
    esac
done

if [ "$BASE_SET" = "1" ] && [ -z "$BASE" ]; then
    die_usage "--base не может быть пустым"
fi
if [ "$TAG_SET" = "1" ] && [ -z "$TAG" ]; then
    die_usage "--tag не может быть пустым"
fi
case "$TAG" in
    beta|next) ;;
    *) die_usage "недопустимый --tag '$TAG' (разрешено: beta|next)" ;;
esac
[ -n "$REGISTRY" ] || die_usage "--registry не может быть пустым"

# ─── Предварительные проверки ─────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "Node.js не найден в PATH"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 22 ] || die "Требуется Node.js >= 22 (сейчас $(node -v))"

command -v pnpm >/dev/null 2>&1 || die "pnpm не найден в PATH"

HAS_GIT=0
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    HAS_GIT=1
else
    echo "⚠ git недоступен — в версии будет 'nogit', dirty-детект пропущен" >&2
fi

# Нормализация реестра: гарантированный завершающий слэш.
REGISTRY="${REGISTRY%/}/"
case "$REGISTRY" in
    http://*|https://*) ;;
    *) die_usage "реестр должен начинаться с http:// или https:// (получено: $REGISTRY)" ;;
esac
REGISTRY_NOPROTO="${REGISTRY#http://}"
REGISTRY_NOPROTO="${REGISTRY_NOPROTO#https://}"

# ─── Версия ───────────────────────────────────────────────────────────────────
CURRENT="$(node -e "process.stdout.write(require('./packages/synth/package.json').version)")"

if [ "$BASE_SET" = "1" ]; then
    if ! printf '%s' "$BASE" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        die_usage "некорректный --base '$BASE': ожидается X.Y.Z (например, 0.13.4)"
    fi
else
    BASE="$(CURRENT="$CURRENT" node -e '
        const v = process.env.CURRENT.split("-")[0].split("+")[0].split(".").map(Number);
        v[2] += 1;
        process.stdout.write(v.join("."));
    ')"
fi

if [ "$HAS_GIT" = "1" ]; then
    REV="$(git rev-parse --short=8 HEAD)"
    if [ -n "$(git status --porcelain)" ]; then
        DIRTY=1
    else
        DIRTY=0
    fi
else
    REV="nogit"
    DIRTY=0
fi

VERSION="${BASE}-beta.$(date -u +%Y%m%d%H%M%S).${REV}"
if [ "$DIRTY" = "1" ]; then
    VERSION="${VERSION}.dirty"
fi

# Токен нужен только для реальной публикации — проверяем его до install/build,
# чтобы без токена не тратить время на сборку. В dry-run не требуется.
TOKEN=""
if [ "$DRY_RUN" = "0" ]; then
    TOKEN="${GITEA_NPM_TOKEN:-${GITEA_TOKEN:-${GV_GITEA_TOKEN:-}}}"
    if [ -z "$TOKEN" ]; then
        die "не задан токен публикации. Укажите GITEA_NPM_TOKEN (или GITEA_TOKEN/GV_GITEA_TOKEN):
  GITEA_NPM_TOKEN=… ./scripts/publish-beta.sh --base $BASE"
    fi
fi

# ─── Файлы и бэкап ────────────────────────────────────────────────────────────
FILES=()
for d in "${PKG_DIRS[@]}"; do
    FILES+=("packages/$d/package.json")
done
FILES+=("packages/shared/src/version.ts")

for f in "${FILES[@]}"; do
    [ -f "$ROOT/$f" ] || die "не найден обязательный файл: $f"
done

TMP_DIR="$ROOT/tmp/beta-publish"
BACKUP_DIR="$TMP_DIR/backup-$$"
NPMRC_FILE="$TMP_DIR/npmrc"
mkdir -p "$BACKUP_DIR"
for f in "${FILES[@]}"; do
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    cp -p "$ROOT/$f" "$BACKUP_DIR/$f"
done

RESTORED=0
restore_files() {
    if [ "$RESTORED" = "0" ]; then
        local f
        for f in "${FILES[@]}"; do
            if [ -f "$BACKUP_DIR/$f" ]; then
                cp -p "$BACKUP_DIR/$f" "$ROOT/$f"
            fi
        done
        RESTORED=1
    fi
}

cleanup() {
    local rc=$?
    set +e
    restore_files
    rm -f "$NPMRC_FILE"
    rm -rf "$BACKUP_DIR"
    return "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ─── Подмена версий ───────────────────────────────────────────────────────────
swap_versions() {
    local d f
    for d in "${PKG_DIRS[@]}"; do
        f="$ROOT/packages/$d/package.json"
        node -e '
            const fs = require("fs");
            const file = process.argv[1];
            const version = process.argv[2];
            const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
            if (typeof pkg.version !== "string") {
                console.error("нет поля version: " + file);
                process.exit(1);
            }
            pkg.version = version;
            fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
        ' "$f" "$VERSION"
    done

    f="$ROOT/packages/shared/src/version.ts"
    node -e '
        const fs = require("fs");
        const file = process.argv[1];
        const version = process.argv[2];
        const src = fs.readFileSync(file, "utf8");
        const out = src.replace(
            /(export const SYNTH_VERSION = \x27)[^\x27]*(\x27;)/,
            "$1" + version + "$2"
        );
        if (out === src) {
            console.error("SYNTH_VERSION не найден: " + file);
            process.exit(1);
        }
        fs.writeFileSync(file, out);
    ' "$f" "$VERSION"
}

verify_versions() {
    local d v
    for d in "${PKG_DIRS[@]}"; do
        v="$(node -p "require('$ROOT/packages/$d/package.json').version")"
        [ "$v" = "$VERSION" ] || die "версия packages/$d/package.json = '$v', ожидалась '$VERSION'"
    done
    grep -q "SYNTH_VERSION = '$VERSION'" "$ROOT/packages/shared/src/version.ts" \
        || die "версия в packages/shared/src/version.ts не совпадает с $VERSION"
}

pkg_name() {
    case "$1" in
        synth) printf '%s' "@itphx/synth" ;;
        *) printf '%s' "@itphx/synth-$1" ;;
    esac
}

echo "━━━ publish-beta ━━━"
echo "  Текущая версия: $CURRENT"
echo "  Бета-версия:    $VERSION"
echo "  База:           $BASE"
echo "  Тег:            $TAG"
echo "  Реестр:         $REGISTRY"
[ "$DRY_RUN" = "1" ] && echo "  Режим:          dry-run"
[ "$BUILD" = "0" ] && echo "  Сборка:         пропущена (--no-build)"
[ "$INSTALL" = "0" ] && echo "  Установка:      пропущена (--skip-install)"
echo ""

# ─── Установка зависимостей (до подмены версий) ───────────────────────────────
if [ "$DRY_RUN" = "0" ] && [ "$INSTALL" = "1" ] && [ "$BUILD" = "1" ]; then
    echo "📥 pnpm install --frozen-lockfile ..."
    pnpm install --frozen-lockfile
    echo ""
fi

# ─── Подмена и проверка ───────────────────────────────────────────────────────
echo "🔧 Подстановка версии $VERSION в 8 package.json + version.ts ..."
swap_versions
verify_versions
echo "  ✓ все 8 пакетов и version.ts → $VERSION"
echo ""

# ─── Сборка ───────────────────────────────────────────────────────────────────
if [ "$DRY_RUN" = "0" ] && [ "$BUILD" = "1" ]; then
    echo "🏗  pnpm build ..."
    pnpm build
    [ -f "$ROOT/packages/synth/dist/cli.js" ] || die "после сборки нет packages/synth/dist/cli.js"
    grep -q "$VERSION" "$ROOT/packages/shared/dist/version.js" \
        || die "packages/shared/dist/version.js не содержит $VERSION"
    echo "  ✓ сборка содержит $VERSION"
    echo ""
elif [ "$DRY_RUN" = "0" ] && [ "$BUILD" = "0" ]; then
    echo "⚠ --no-build: публикуется уже собранное. Версия в dist может быть старой"
    echo "  (метаданные пакета будут с $VERSION, но 'synth --version' может показать старую)."
    echo ""
fi

# ─── dry-run: показать план и выйти (trap восстановит версии) ─────────────────
if [ "$DRY_RUN" = "1" ]; then
    echo "  (в dry-run install и build не выполняются)"
    echo ""
    echo "Пакеты (8):"
    for d in "${PKG_DIRS[@]}"; do
        echo "  - $(pkg_name "$d")@$VERSION"
    done
    echo ""
    echo "Команды, которые были бы выполнены:"
    echo "  pnpm publish --access public --registry \"$REGISTRY\" --no-git-checks --tag \"$TAG\""
    echo "      (в каждом packages/<pkg>)"
    echo "  bash scripts/publish-packages.sh \"$REGISTRY\" --tag \"$TAG\""
    for d in "${PKG_DIRS[@]}"; do
        echo "  npm dist-tag add \"$(pkg_name "$d")@$VERSION\" \"$TAG\" --registry \"$REGISTRY\""
    done
    [ "$SMOKE" = "1" ] && echo "  npm i -g --prefix tmp/beta-publish/smoke \"@itphx/synth@$TAG\" --registry \"$REGISTRY\" --no-audit --no-fund"
    echo ""
    echo "━━━ dry-run завершён: публикации не было, версии восстанавливаются ━━━"
    exit 0
fi

# ─── Токен и временный npmrc ──────────────────────────────────────────────────
mkdir -p "$TMP_DIR"
(
    umask 077
    {
        printf '@itphx:registry=%s\n' "$REGISTRY"
        printf '//%s:_authToken=${GITEA_NPM_TOKEN}\n' "$REGISTRY_NOPROTO"
    } > "$NPMRC_FILE"
)
chmod 600 "$NPMRC_FILE"

export NPM_CONFIG_USERCONFIG="$NPMRC_FILE"
export npm_config_userconfig="$NPMRC_FILE"
export GITEA_NPM_TOKEN="$TOKEN"
export NPM_AUTH_TOKEN="$TOKEN"
unset TOKEN
echo "🔑 Токен принят (не выводится); npmrc: ${NPMRC_FILE#"$ROOT"/}"
echo ""

# ─── Публикация ───────────────────────────────────────────────────────────────
echo "🚀 Публикация 8 пакетов @ $VERSION (tag: $TAG) → $REGISTRY"
bash "$ROOT/scripts/publish-packages.sh" "$REGISTRY" --tag "$TAG"
echo ""

# ─── dist-tag для всех 8 + проверка ───────────────────────────────────────────
echo "🏷  Проверка dist-tag '$TAG' для всех пакетов ..."
for d in "${PKG_DIRS[@]}"; do
    name="$(pkg_name "$d")"
    if npm dist-tag add "${name}@${VERSION}" "$TAG" --registry "$REGISTRY" >/dev/null 2>&1; then
        echo "  ✓ $name → $TAG"
    else
        echo "  ⚠ не удалось выставить dist-tag $TAG для $name (проверьте вручную)"
    fi
done

GOT="$(npm view "@itphx/synth@$TAG" version --registry "$REGISTRY" 2>/dev/null || true)"
if [ "$GOT" != "$VERSION" ]; then
    die "dist-tag '$TAG' указывает на '${GOT:-<нет>}', ожидалось '$VERSION'"
fi
echo "  ✓ @itphx/synth@$TAG → $GOT"
echo ""

# ─── Smoke-тест установки ─────────────────────────────────────────────────────
if [ "$SMOKE" = "1" ]; then
    SMOKE_DIR="$TMP_DIR/smoke"
    rm -rf "$SMOKE_DIR"
    echo "🧪 Smoke: npm i -g @itphx/synth@$TAG в $SMOKE_DIR ..."
    npm i -g --prefix "$SMOKE_DIR" "@itphx/synth@$TAG" --registry "$REGISTRY" --no-audit --no-fund
    [ -x "$SMOKE_DIR/bin/synth" ] || die "smoke: не найден $SMOKE_DIR/bin/synth"
    OUT="$("$SMOKE_DIR/bin/synth" --version 2>&1 || true)"
    case "$OUT" in
        *"$VERSION"*) echo "  ✓ synth --version → $OUT" ;;
        *) die "smoke-тест не прошёл: 'synth --version' → '$OUT', ожидалась $VERSION" ;;
    esac
    echo ""
fi

# ─── Итог ─────────────────────────────────────────────────────────────────────
printf '%s\n' "$VERSION" > "$TMP_DIR/version.txt"

echo "━━━ Готово ━━━"
echo "  Версия:    $VERSION"
echo "  Тег:       $TAG"
echo "  Установка: npm i -g @itphx/synth@$TAG --registry $REGISTRY"
echo "  Версия сохранена: tmp/beta-publish/version.txt"
echo ""
if [ "$BUILD" = "1" ]; then
    echo "  ⚠ Исходные версии восстановлены, но dist/ собран с бета-версией."
else
    echo "  ⚠ dist/ не пересобирался (--no-build); исходные версии восстановлены."
fi
echo "    Пересобрать shared и ui под исходную версию:"
echo "      pnpm --filter @itphx/synth-shared build && pnpm --filter @itphx/synth-ui build"
echo "    или запустить скрипт с --restore-dist."

if [ "$RESTORE_DIST" = "1" ]; then
    echo ""
    echo "🔁 --restore-dist: пересборка @itphx/synth-shared и @itphx/synth-ui ..."
    restore_files
    pnpm --filter @itphx/synth-shared build
    pnpm --filter @itphx/synth-ui build
    echo "  ✓ dist пересобран под исходные версии"
fi
