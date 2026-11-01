#!/bin/sh
# install-tier-5.sh — tier 5 toolchain'а: проверка репозитория.
#
# PROP-082, раздел «Тиры инструментов», tier 5:
#
#   линтеры репозитория: shellcheck (shell-скрипты), yamllint (YAML);
#   инструменты релиза: helm (чарт), hadolint (Dockerfile'ы)
#
# Зачем: проверка артефактов репозитория Synth из агентского шелла:
#   * Helm-чарт `charts/synth` — `helm lint` / `helm template`
#     (тот же сценарий, что в CI: scripts/ci-helm.sh — там helm резолвится
#     по цепочке HELM_BIN → helm в PATH → кэш → зеркала, и helm в PATH —
#     первый источник, поэтому в образе он и нужен);
#   * shell-скрипты репозитория — `shellcheck`;
#   * YAML-манифесты (compose, конфиги, workflow) — `yamllint`;
#   * Dockerfile'ы — `hadolint`.
#
# Тир вынесен из tier 2 (там были helm/shellcheck/yamllint/hadolint): тир 2 —
# это инфраструктурные инструменты для ПРИМЕНЕНИЯ (kubectl, kustomize,
# ansible, opentofu), а тир 5 — инструменты для ПРОВЕРКИ исходников
# репозитория. Проверка нужна в образе `dev` (сборка/линт монорепо) чаще,
# чем ansible, поэтому тир 5 ставится уже в `dev`.
#
# Состав разделён на две части:
#
#   1) ДИСТРИБУТИВНЫЕ пакеты (таблица logical|apk|apt) — есть и в alpine, и в
#      debian, различаются только имена:
#        линтеры репозитория: shellcheck, yamllint.
#
#   2) UPSTREAM-релизы (пин версии + sha256) — инструментов НЕТ в репозиториях
#      дистрибутивов либо их версия должна быть зафиксирована:
#        helm, hadolint.
#      Пин версии + контрольная сумма = supply-chain (референс PROP-068).
#      Состав не зависит от дистрибутива — одна таблица на оба базовых образа
#      (alpine-ветка `dev`/`devops` и debian-ветка `full`).
#
# Скрипт distro-aware: сам выбирает `apk` (alpine) или `apt-get` (debian).
# Идемпотентен, неинтерактивен, без `local` (POSIX sh).

set -eu

# CDPATH= — префиксное присваивание для одной команды, пробел обязателен.
# shellcheck disable=SC1007
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=install-lib.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/install-lib.sh"

# ---------------------------------------------------------------------------
# Часть 1: дистрибутивные пакеты
# ---------------------------------------------------------------------------
#
# Состав: shellcheck, yamllint — имена пакетов в alpine и debian СОВПАДАЮТ
# (в отличие от hard-deps/tier-0/tier-1), поэтому таблица ниже во всех трёх
# колонках одинакова.
#
# (Таблица приведена построчно — в комментарии строка с именем пакета
# «shellcheck» начиналась бы с директивы, которую литер не может разобрать.)
TIER_5_DISTRO='
shellcheck|shellcheck|shellcheck
yamllint|yamllint|yamllint
'

synth_install_tier "$TIER_5_DISTRO"

# ---------------------------------------------------------------------------
# Часть 2: upstream-релизы (пин версии + sha256)
# ---------------------------------------------------------------------------
#
#   logical   | url_amd64                                         | sha256_amd64 | url_arm64                                          | sha256_arm64 | файл
#   ----------+---------------------------------------------------+--------------+---------------------------------------------------+--------------+------
#   helm      | get.helm.sh/helm-v3.22.1-linux-amd64.tar.gz        | 896cf636...  | get.helm.sh/helm-v3.22.1-linux-arm64.tar.gz       | 4c29e286...  | helm
#   hadolint  | github.com/.../hadolint-linux-x86_64              | c7187db9...  | github.com/.../hadolint-linux-arm64              | f6198ef8...  | -
#
# Контрольные суммы — из официальных файлов релизов:
#   helm     — https://get.helm.sh/helm-v3.22.1-linux-<arch>.tar.gz.sha256sum
#   hadolint — checksums.sha256 в релизе hadolint/hadolint
#
# Источники checksum'ов зафиксированы, чтобы ревизор мог перепроверить pin.
TIER_5_UPSTREAM='
helm|https://get.helm.sh/helm-v3.22.1-linux-amd64.tar.gz|896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea|https://get.helm.sh/helm-v3.22.1-linux-arm64.tar.gz|4c29e286b279d170fa048ddfc3e4e83dcd069ca9c52102766ba672d7149e694d|helm
hadolint|https://github.com/hadolint/hadolint/releases/download/v2.15.1/hadolint-linux-x86_64|c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507|https://github.com/hadolint/hadolint/releases/download/v2.15.1/hadolint-linux-arm64|f6198ef8090f404dbb771abfee086eb8c48ac177f30da7fd3510aca35b344b5d|-
'

synth_install_upstream_binaries "$TIER_5_UPSTREAM"
