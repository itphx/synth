#!/usr/bin/env bash
#
# docker-auth-gitea.sh — авторизация docker-клиента в реестр Gitea
# (`git.itphx.ru`) для kaniko/CLI.
#
# Реестр Gitea приватный: без авторизации push не проходит. Скрипт пишет
# `config.json` в каталог `DOCKER_CONFIG` — так делает и kaniko (переменная
# `DOCKER_CONFIG` указывает на каталог с config.json), и `docker push`.
#
# Переменные окружения:
#   GITEA_TOKEN    — токен Gitea с правом на container registry (обязателен);
#   GITEA_USER     — логин Gitea (по умолчанию itphx);
#   GITEA_REGISTRY — хост реестра (по умолчанию git.itphx.ru);
#   DOCKER_CONFIG  — каталог конфигурации Docker (по умолчанию $PWD/.docker-gitea).
#
# Секрет не печатается в лог: в config.json попадает base64-пара
# «логин:токен» (файл с правами 0600).
#
# Если токен не задан — **fail-closed** с понятным сообщением: молчаливый
# пропуск публикации выглядел бы как успешный релиз без образов.

set -euo pipefail

if [[ -z "${GITEA_TOKEN:-}" ]]; then
  echo "docker-auth-gitea.sh: GITEA_TOKEN не задан — публикация в реестр Gitea невозможна" >&2
  echo "  в CI: секрет GV_GITEA_TOKEN; локально: переменная GITEA_TOKEN" >&2
  exit 1
fi

OWNER="${GITEA_USER:-itphx}"
REGISTRY="${GITEA_REGISTRY:-git.itphx.ru}"
CONFIG_DIR="${DOCKER_CONFIG:-$PWD/.docker-gitea}"

mkdir -p "$CONFIG_DIR"

AUTH="$(printf '%s' "$OWNER:$GITEA_TOKEN" | base64 | tr -d '\n')"
printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$REGISTRY" "$AUTH" > "$CONFIG_DIR/config.json"
chmod 600 "$CONFIG_DIR/config.json"

echo "Docker-авторизация записана: $CONFIG_DIR/config.json (реестр $REGISTRY, пользователь $OWNER)"
