#!/bin/sh
# install-tier-4.sh — tier 4 toolchain'а: MCP-серверы SCM-хостингов.
#
# PROP-082, раздел «Тиры инструментов», tier 4: MCP-серверы github, gitea,
# gitverse, gitlab. В отличие от tier 0–2 это НЕ дистрибутивные пакеты:
# серверы публикуются в npm, поэтому ставятся через npm — но с ЗАФИКСИРОВАННОЙ
# версией и проверкой integrity тарбола (supply-chain — референс PROP-068:
# pin + checksum, «последняя версия» не ставится никогда).
#
# Порядок установки:
#   1) тарбол скачивается напрямую по зафиксированному URL;
#   2) сверяется sha512 (integrity из реестра npm, зафиксированная в таблице);
#   3) только при совпадении — `npm install -g` (зависимости самого сервера npm
#      тоже проверяет по integrity реестра).
# Расхождение контрольной сумты = ошибка сборки (fail-closed).
#
# ТОКЕНЫ ХОСТИНГОВ В ОБРАЗ НЕ ЗАПЕКАЮТСЯ (ADR-076/ADR-036): сервер читает их
# из окружения в рантайме (инъекция при спавне MCP-процесса):
#   GITHUB_PERSONAL_ACCESS_TOKEN — github
#   GITLAB_PERSONAL_ACCESS_TOKEN, GITLAB_API_URL (опц.) — gitlab
#   GITEA_TOKEN, GITEA_API_URL (опц.) — gitea
#   GITVERSE_TOKEN — gitverse
#
# Требования к node: пакеты выбраны так, чтобы работали на node 22 (в образе
# `node:22-alpine`). Кандидаты с `engines.node >= 24` отклонены.

set -eu

# CDPATH= — префиксное присваивание для одной команды, пробел обязателен.
# shellcheck disable=SC1007
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=install-lib.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/install-lib.sh"

# Состав: logical|версия|url_тарбола|sha512_base64
#
#   logical          | версия   | bin в образе
#   -----------------+----------+-------------------
#   mcp-server-github| 2025.4.8 | mcp-server-github
#   mcp-server-gitlab| 2025.4.25| mcp-server-gitlab
#   gitea-mcp        | 2.0.0    | gitea-mcp
#   gitverse-mcp     | 1.1.0    | gitverse-mcp
#
# Соответствие logical → npm-пакет:
#   mcp-server-github → @modelcontextprotocol/server-github (официальный)
#   mcp-server-gitlab → @modelcontextprotocol/server-gitlab (официальный)
#   gitea-mcp        → @boringstudio_org/gitea-mcp (сторонний: официального
#                      MCP-сервера Gitea в реестре npm нет)
#   gitverse-mcp     → @grigoriy-grisha/gitverse-mcp (сторонний: штатный
#                      GitVerse MCP — удалённый HTTP-сервис mcp.gitverse.ru,
#                      stdio-вариант нужен именно как локальный бинарь)
TIER_4_NPM='
mcp-server-github|2025.4.8|https://registry.npmjs.org/@modelcontextprotocol/server-github/-/server-github-2025.4.8.tgz|8N43bQw9MlUB0piTZHK2JMh8kYPKxH57d4Z7Wb8PS4by2MkZ0FzI5xPImg3xumpev82VZw2VWHQJJJYp+WkwEw==
mcp-server-gitlab|2025.4.25|https://registry.npmjs.org/@modelcontextprotocol/server-gitlab/-/server-gitlab-2025.4.25.tgz|IQY57XkHjaIcSOWi+Qs9w8ZZMqhz5YOYOkU3v1CTbHU8rcIm/NhtX4/7XBeFRgXwRpvTuGP+WdnWg+1hH/wJdw==
gitea-mcp|2.0.0|https://registry.npmjs.org/@boringstudio_org/gitea-mcp/-/gitea-mcp-2.0.0.tgz|75pRunAZ/LD+Jw8bLg3YmzPjIuUJZnEkpnMXQMMQQFXTBJheYfIZcxRHpUAyRKiH6c+gTpfYBxDhNqVUKQCGvQ==
gitverse-mcp|1.1.0|https://registry.npmjs.org/@grigoriy-grisha/gitverse-mcp/-/gitverse-mcp-1.1.0.tgz|RmdjgIx8131Gpytst2eVGwbh53el4TbczlPbxaxbXrGHM8oUNZep/We/XTM9LUrm6npAnnyYI6EdA/+cMurnMw==
'

TIER_4_ROWS=$(printf '%s\n' "$TIER_4_NPM")

# Цикл читает из here-doc, а не из пайпа: пайп создаёт subshell, и `exit 1`
# внутри него прервал бы только subshell, а не сборку.
while IFS= read -r tier4_row; do
    [ -n "$tier4_row" ] || continue
    tier4_name=$(printf '%s' "$tier4_row" | cut -d'|' -f1)
    tier4_version=$(printf '%s' "$tier4_row" | cut -d'|' -f2)
    tier4_url=$(printf '%s' "$tier4_row" | cut -d'|' -f3)
    tier4_sha=$(printf '%s' "$tier4_row" | cut -d'|' -f4)
    synth_install_npm_pinned "$tier4_name" "$tier4_version" "$tier4_url" "$tier4_sha"
done <<EOF
$TIER_4_ROWS
EOF
