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

# Таймауты запроса. Без них зависший TCP-коннект к реестру (соединение
# устанавливается, а ответ не приходит) держит скрипт ВЕЧНО — так случилось
# на релизном прогоне 0.11.3: curl без --max-time не вернулся, и шаг
# «Ожидание доступности версии в npmjs» висел дольше лимита джобы.
CURL_MAX_TIME="${CURL_MAX_TIME:-25}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-10}"
# Общий бюджет ожидания независимо от числа попыток: не даёт шагу висеть дольше
# отведённого времени при медленном реестре.
TOTAL_BUDGET="${TOTAL_BUDGET:-400}"

if [ -z "$VERSION" ]; then
  echo "Использование: $0 <version> [attempts] [delay_sec]" >&2
  exit 1
fi

echo "Ожидание версии $VERSION в $REGISTRY (до $((ATTEMPTS * DELAY)) c, общий бюджет ${TOTAL_BUDGET} c)"

DEADLINE=$(( $(date +%s) + TOTAL_BUDGET ))
for attempt in $(seq 1 "$ATTEMPTS"); do
  missing=""
  for pkg in $PACKAGES; do
    uri="${pkg/@/}"
    uri="${uri//\//%2F}"
    code=$(curl -s -o /dev/null -w '%{http_code}' \
      --max-time "$CURL_MAX_TIME" --connect-timeout "$CURL_CONNECT_TIMEOUT" \
      "$REGISTRY/@$uri/$VERSION" 2>/dev/null) || code="000"
    if [ "$code" != "200" ]; then
      missing="$missing $pkg(HTTP $code)"
    fi
  done
  if [ -z "$missing" ]; then
    echo "OK: версия $VERSION доступна во всех пакетах (попытка $attempt)"
    exit 0
  fi
  REMAINING=$(( DEADLINE - $(date +%s) ))
  if [ "$REMAINING" -le 0 ]; then
    echo "ОШИБКА: исчерпан общий бюджет ожидания (${TOTAL_BUDGET} c); ещё нет:$missing" >&2
    exit 1
  fi
  if [ "$REMAINING" -gt "$DELAY" ]; then
    REMAINING="$DELAY"
  fi
  echo "попытка $attempt/$ATTEMPTS: ещё нет:$missing — пауза ${REMAINING}c"
  sleep "$REMAINING"
done

echo "ОШИБКА: версия $VERSION не появилась в $REGISTRY за $((ATTEMPTS * DELAY)) c" >&2
exit 1
