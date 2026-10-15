#!/usr/bin/env bash
#
# publish-packages.sh — идемпотентная публикация всех 6 пакетов в npm-реестр.
#
# Пропускает версии, которые уже опубликованы (повторные прогоны release
# не падают на "already exists"). Порядок публикации строгий:
#   shared → core → ui → backend → sdk → synth
#
# В конце проверяет, что все 6 версий реально видны в реестре. Если хотя бы
# одной нет — выходит с кодом 1: pnpm печатает "Published" и для staged-
# публикации, которую npm увёл в automated review («Validating»), в реестре
# такой версии ещё нет.
#
# npm отдаёт опубликованную версию с задержкой: публикация проходит
# автоматический review/репликацию, и версия становится видна в реестре через
# 4–6 мин (наблюдалось на 0.10.1). Поэтому бюджет ожидания в фазе проверки —
# 15 мин, а таймаут джобы publish-npmjs в release.yaml — 30 мин.
#
# Использование:
#   ./scripts/publish-packages.sh https://registry.npmjs.org
#   ./scripts/publish-packages.sh https://gitverse.ru/api/packages/itphx/npm/
#   ./scripts/publish-packages.sh https://registry.npmjs.org --verify-only  # только проверка
#
# Переменные окружения:
#   VERSION_OVERRIDE — проверить/опубликовать другую версию (по умолчанию из
#                      packages/synth/package.json); нужен в основном для диагностики.
#   NPM_AUTH_TOKEN   — токен для чтения из реестра; если не задан, берётся из
#                      npmrc (project/.npmrc → userconfig → globalconfig).
#
# Требования: npm-токен уже настроен (npm config _authToken), pnpm установлен.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERIFY_ONLY=0
POSITIONAL=()
for arg in "$@"; do
    case "$arg" in
        --verify-only) VERIFY_ONLY=1 ;;
        *) POSITIONAL+=("$arg") ;;
    esac
done

REGISTRY="${POSITIONAL[0]:?Укажите npm-реестр}"
VERSION="${VERSION_OVERRIDE:-$(node -e "console.log(require('./packages/synth/package.json').version)")}"

# Нормализованный базовый URL без завершающего слэша (GitVerse-реестр передаётся с "/")
REGISTRY_BASE="${REGISTRY%/}"

# --- Токен для чтения из реестра ---
# npm намеренно запрещает `npm config get <//registry/:_authToken>` («option is
# protected»), поэтому читаем значение напрямую из npmrc. Публичные пакеты
# npmjs читаются и без токена; приватные/GitVerse — требуют.
REGISTRY_NOPROTO="${REGISTRY_BASE#http://}"
REGISTRY_NOPROTO="${REGISTRY_NOPROTO#https://}"
REGISTRY_NOPROTO="${REGISTRY_NOPROTO%/}/"

# read_npmrc_secret <suffix> — вернуть значение <suffix> для //<REGISTRY_NOPROTO>:
read_npmrc_secret() {
    local suffix="$1" cfg line val envname
    for cfg in "${ROOT}/.npmrc" "$(npm config get userconfig 2>/dev/null || true)" "$(npm config get globalconfig 2>/dev/null || true)"; do
        [ -n "$cfg" ] && [ -f "$cfg" ] || continue
        line="$(grep -F "//${REGISTRY_NOPROTO}:${suffix}=" "$cfg" 2>/dev/null | head -n1 || true)"
        if [ -n "$line" ]; then
            val="${line#*:${suffix}=}"
            # npmrc может ссылаться на переменную окружения: ${NPM_TOKEN}
            case "$val" in
                '${'*'}')
                    envname="${val#\$\{}"
                    envname="${envname%\}}"
                    val="$(printenv "$envname" 2>/dev/null || true)"
                    ;;
            esac
            val="${val%\"}"; val="${val#\"}"
            val="${val%\'}"; val="${val#\'}"
            if [ -n "$val" ]; then
                printf '%s' "$val"
                return 0
            fi
        fi
    done
    return 1
}

CURL_AUTH=()
if [ -n "${NPM_AUTH_TOKEN:-}" ]; then
    CURL_AUTH=(-H "Authorization: Bearer ${NPM_AUTH_TOKEN}")
else
    AUTH_SCHEME=""
    AUTH_VALUE=""
    if AUTH_VALUE="$(read_npmrc_secret "_authToken")" && [ -n "$AUTH_VALUE" ]; then
        AUTH_SCHEME="Bearer"
    elif AUTH_VALUE="$(read_npmrc_secret "_auth")" && [ -n "$AUTH_VALUE" ]; then
        AUTH_SCHEME="Basic"
    fi
    if [ -n "$AUTH_SCHEME" ]; then
        CURL_AUTH=(-H "Authorization: ${AUTH_SCHEME} ${AUTH_VALUE}")
    fi
fi

echo "━━━ publish-packages ━━━"
echo "  Реестр:   $REGISTRY"
echo "  Версия:   $VERSION"
[ "$VERIFY_ONLY" = "1" ] && echo "  Режим:    только проверка (--verify-only)"
echo ""

PUBLISHED=0
SKIPPED=0

for pkg in shared core ui backend sdk synth; do
    if [ "$pkg" = "synth" ]; then
        NAME="@itphx/synth"
    else
        NAME="@itphx/synth-$pkg"
    fi

    if [ "$VERIFY_ONLY" = "1" ]; then
        :
    elif pnpm view "$NAME@$VERSION" version --registry "$REGISTRY" >/dev/null 2>&1; then
        echo "  ✓ $NAME@$VERSION уже опубликован — пропускаем"
        SKIPPED=$((SKIPPED + 1))
    else
        echo "  📦 $NAME@$VERSION → $REGISTRY"
        (cd "packages/$pkg" && pnpm publish --access public --registry "$REGISTRY" --no-git-checks)
        PUBLISHED=$((PUBLISHED + 1))
    fi
done

if [ "$VERIFY_ONLY" != "1" ]; then
    echo ""
    echo "━━━ Готово: опубликовано $PUBLISHED, пропущено $SKIPPED ━━━"
fi

# --- Проверка, что версии реально доступны в реестре ---
# pnpm может напечатать "Published", но версия останется в automated review
# («Validating») и будет отдавать 404. npm публикует версию с задержкой
# (автоматический review/репликация; наблюдалось 4–6 мин), поэтому ждём
# появления с ретраями и бюджетом 15 мин (VERIFY_TIMEOUT), а не 2 мин.

http_code() {
    local code
    code="$(curl -s --compressed -o /dev/null -w '%{http_code}' --max-time 25 "${CURL_AUTH[@]}" "$1" 2>/dev/null)" || code="000"
    printf '%s' "$code"
}

version_available() {
    local name="$1" path url
    path="${name/@/}"
    path="${path//\//%2F}"

    # Основной путь: GET <registry>/@<scope>%2F<name>/<version>
    if [ "$(http_code "${REGISTRY_BASE}/@${path}/${VERSION}")" = "200" ]; then
        return 0
    fi

    # Fallback: некоторые реестры (например, GitVerse) не отдают per-version
    # endpoint (всегда 404), но отдают packument со списком versions.
    url="${REGISTRY_BASE}/@${path}"
    curl -s --compressed --max-time 25 "${CURL_AUTH[@]}" "$url" 2>/dev/null \
        | PKG_VERSION="$VERSION" node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(b);if(j&&j.versions&&j.versions[process.env.PKG_VERSION]){process.exit(0)}}catch{}process.exit(1)})'
}

VERIFY_PACKAGES=(shared core ui backend sdk synth)
VERIFY_TIMEOUT=900   # общий бюджет ожидания, с (npm отдаёт версию с задержкой 4–6 мин)
VERIFY_DELAY=15      # шаг опроса, с

echo ""
echo "Проверка версии $VERSION в $REGISTRY (до ~${VERIFY_TIMEOUT} с, шаг ${VERIFY_DELAY} с)..."

DEADLINE=$(( $(date +%s) + VERIFY_TIMEOUT ))
attempt=0
while :; do
    attempt=$((attempt + 1))
    MISSING=()
    for pkg in "${VERIFY_PACKAGES[@]}"; do
        if [ "$pkg" = "synth" ]; then
            NAME="@itphx/synth"
        else
            NAME="@itphx/synth-$pkg"
        fi
        version_available "$NAME" || MISSING+=("$NAME")
    done

    if [ ${#MISSING[@]} -eq 0 ]; then
        echo "  ✓ Все ${#VERIFY_PACKAGES[@]} пакетов версии $VERSION подтверждены в реестре"
        exit 0
    fi

    REMAINING=$(( DEADLINE - $(date +%s) ))
    if [ "$REMAINING" -le 0 ]; then
        break
    fi
    if [ "$REMAINING" -gt "$VERIFY_DELAY" ]; then
        REMAINING="$VERIFY_DELAY"
    fi
    echo "  попытка $attempt: ещё не видны: ${MISSING[*]} — пауза ${REMAINING}с"
    sleep "$REMAINING"
done

echo ""
echo "✗ ОШИБКА: версия $VERSION не подтверждена в $REGISTRY для пакетов:"
for name in "${MISSING[@]}"; do
    echo "   - $name@$VERSION"
done
echo ""
echo "  Возможные причины:"
echo "   • npm увёл публикацию в automated review — в веб-интерфейсе реестра версия"
echo "     показана как «Validating», пока не пройдёт проверку (доступна 404)."
echo "     Дождитесь одобрения и перезапустите релиз — публикация идемпотентна."
echo "   • Публикация ещё не отреплицирована в реестр (сетевой/репликационный лаг)."
echo "   • Нет прав на чтение пакета/версии в реестре (проверьте токен)."
exit 1
