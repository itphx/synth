#!/bin/sh
# install-tier-2.sh — tier 2 toolchain'а: инфраструктура и devops.
#
# PROP-082, раздел «Тиры инструментов», tier 2:
#
#   kubectl, kustomize, ansible (+ansible-lint), terraform/opentofu
#
# Зачем: инфраструктурные задачи агента — применить манифесты, собрать
#   kustomize-оверлей, прогнать ansible-playbook.
#
# ВНИМАНИЕ: helm, shellcheck, yamllint и hadolint ВЫНЕСЕНЫ в tier 5
#   (docker/install-tier-5.sh). Причина — разные задачи: tier 2 — это
#   инструменты ПРИМЕНЕНИЯ инфраструктуры, а helm/shellcheck/yamllint/
#   hadolint — инструменты ПРОВЕРКИ исходников репозитория Synth (чарт
#   `charts/synth`, shell-скрипты, YAML-манифесты, Dockerfile'ы). Проверка
#   нужна уже в образе `dev` (линт/сборка монорепо), поэтому тир 5 ставится
#   в `dev`, а `devops` и `full` наследуют его вместе с `dev`.
#
# Состав разделён на две части:
#
#   1) ДИСТРИБУТИВНЫЕ пакеты (таблица logical|apk|apt) — есть и в alpine, и в
#      debian, различаются только имена:
#        ansible, ansible-lint.
#
#   2) UPSTREAM-релизы (пин версии + sha256) — инструментов НЕТ в репозиториях
#      дистрибутивов либо их версия должна быть зафиксирована:
#        kubectl, kustomize, opentofu (terraform).
#      Причина — версии этих инструментов привязаны к целевому кластеру/
#      проекту (PROP-082, «Открытые вопросы»), а дистрибутивные пакеты их
#      версию не контролируют. Пин + контрольная сумма = supply-chain
#      (референс PROP-068). Состав не зависит от дистрибутива — одна таблица
#      на оба базовых образа (alpine-ветка `devops` и debian-ветка шага 5).
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
# Состав: ansible, ansible-lint — имена пакетов в alpine и debian СОВПАДАЮТ
# (в отличие от hard-deps/tier-0/tier-1), поэтому таблица ниже во всех трёх
# колонках одинакова.
#
# (Таблица приведена построчно — по строке на пакет, как в остальных тирах.)
TIER_2_DISTRO='
ansible|ansible|ansible
ansible-lint|ansible-lint|ansible-lint
'

synth_install_tier "$TIER_2_DISTRO"

# ---------------------------------------------------------------------------
# Часть 2: upstream-релизы (пин версии + sha256)
# ---------------------------------------------------------------------------
#
#   logical   | url_amd64                                         | sha256_amd64 | url_arm64                                          | sha256_arm64 | файл
#   ----------+---------------------------------------------------+--------------+---------------------------------------------------+--------------+------
#   kubectl   | dl.k8s.io/release/v1.37.1/bin/linux/amd64/kubectl | 65691ff7...  | dl.k8s.io/release/v1.37.1/bin/linux/arm64/kubectl | ff749f4b...  | -
#   kustomize | github.com/.../kustomize_v5.8.3_linux_amd64.tar.gz| cb9e3119...  | github.com/.../kustomize_v5.8.3_linux_arm64.tar.gz| 9867b764... | kustomize
#   tofu      | github.com/.../tofu_1.13.1_linux_amd64.tar.gz      | 378ada19...  | github.com/.../tofu_1.13.1_linux_arm64.tar.gz    | 9c1ef375...  | tofu
#
# Контрольные суммы — из официальных файлов релизов:
#   kubectl   — https://dl.k8s.io/release/v1.37.1/bin/linux/<arch>/kubectl.sha256
#   kustomize — checksums.txt в релизе kubernetes-sigs/kustomize
#   opentofu  — tofu_1.13.1_SHA256SUMS в релизе opentofu/opentofu
#
# Источники checksum'ов зафиксированы, чтобы ревизор мог перепроверить pin.
TIER_2_UPSTREAM='
kubectl|https://dl.k8s.io/release/v1.37.1/bin/linux/amd64/kubectl|65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8|https://dl.k8s.io/release/v1.37.1/bin/linux/arm64/kubectl|ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7|-
kustomize|https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.8.3/kustomize_v5.8.3_linux_amd64.tar.gz|cb9e31198d3f63b44848bd0afc4c8efc56e6cfef9c93a4a39a211940e6decd61|https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.8.3/kustomize_v5.8.3_linux_arm64.tar.gz|9867b76482cfc6d25b546abc1d2b5a32bd137505aba640649b4b378f64f6d68f|kustomize
tofu|https://github.com/opentofu/opentofu/releases/download/v1.13.1/tofu_1.13.1_linux_amd64.tar.gz|378ada19d4bc70c43732004e8159be771b23b9a5afdf059e5f8a2b3fa2c70a69|https://github.com/opentofu/opentofu/releases/download/v1.13.1/tofu_1.13.1_linux_arm64.tar.gz|9c1ef375aa1852db0b2888aa921b640c71f8140d4682aa4fec99378a64fa7dc3|tofu
'

synth_install_upstream_binaries "$TIER_2_UPSTREAM"

# OpenTofu — FOSS-продолжение HashiCorp Terraform (бинарь называется `tofu`).
# Симлинк `terraform` нужен для привычного интерфейса (команды и формат
# конфигурации/стейтов совместимы); `terraform version` при этом честно
# печатает «OpenTofu». Сам HashiCorp Terraform (лицензия BUSL) в образ не
# кладём.
ln -sf /usr/local/bin/tofu /usr/local/bin/terraform
