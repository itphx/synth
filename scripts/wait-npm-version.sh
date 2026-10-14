#!/usr/bin/env bash
#
# wait-npm-version.sh — ожидание доступности версии @itphx/* в npmjs.org.
#
# Зачем: джоба publish-npmjs завершается раньше, чем версия становится видна
# в registry (репликация занимает минуты), из-за чего kaniko-сборка
# standalone-образа падает с ETARGET (npm install -g @itphx/synth@<version>).
#
# Использование:
#   scripts/wait-npm-version.sh <version> [attempts] [delay_sec]
#
# Переменные окружения:
#   NPM_REGISTRY — реестр (по умолчанию https://registry.npmjs.org)
#   NPM_PACKAGES — список пакетов через пробел

set -u

VERSION="${1:-}"
ATTEMPTS="${2:-40}"
DELAY="${3:-10}"
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
PACKAGES="${NPM_PACKAGES:-@itphx/synth @itphx/synth-core @itphx/synth-shared @itphx/synth-ui @itphx/synth-backend @itphx/synth-sdk}"

if [ -z "$VERSION" ]; then
  echo "Использование: $0 <version> [attempts] [delay_sec]" >&2
  exit 1
fi

echo "Ожидание версии $VERSION в $REGISTRY (до $((ATTEMPTS * DELAY)) c)"

for attempt in $(seq 1 "$ATTEMPTS"); do
  missing=""
  for pkg in $PACKAGES; do
    uri="${pkg/@/}"
    uri="${uri//\//%2F}"
    code=$(curl -s -o /dev/null -w '%{http_code}' "$REGISTRY/@$uri/$VERSION")
    if [ "$code" != "200" ]; then
      missing="$missing $pkg(HTTP $code)"
    fi
  done
  if [ -z "$missing" ]; then
    echo "OK: версия $VERSION доступна во всех пакетах (попытка $attempt)"
    exit 0
  fi
  echo "попытка $attempt/$ATTEMPTS: ещё нет:$missing — пауза ${DELAY}c"
  sleep "$DELAY"
done

echo "ОШИБКА: версия $VERSION не появилась в $REGISTRY за $((ATTEMPTS * DELAY)) c" >&2
exit 1
