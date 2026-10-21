#!/bin/sh
# install-tier-2.sh — tier 2 toolchain'а: инфраструктура и devops.
#
# PROP-082, раздел «Тиры инструментов», tier 2:
#
#   kubectl, helm, kustomize, ansible (+ansible-lint), terraform/opentofu,
#   yamllint, shellcheck, hadolint
#
# Зачем: инфраструктурные задачи агента — применить манифесты, собрать
#   kustomize-оверлей, прогнать ansible-playbook, проверить Dockerfile
#   (hadolint), yaml (yamllint) и shell-скрипты (shellcheck).
#
# Состав разделён на две части:
#
#   1) ДИСТРИБУТИВНЫЕ пакеты (таблица logical|apk|apt) — есть и в alpine, и в
#      debian, различаются только имена:
#        ansible, ansible-lint, yamllint, shellcheck.
#
#   2) UPSTREAM-релизы (пин версии + sha256) — инструментов НЕТ в репозиториях
#      дистрибутивов либо их версия должна быть зафиксирована:
#        kubectl, helm, kustomize, opentofu (terraform), hadolint.
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
# Состав: ansible, ansible-lint, yamllint, shellcheck — имена пакетов в
# alpine и debian СОВПАДАЮТ (в отличие от hard-deps/tier-0/tier-1), поэтому
# таблица ниже во всех трёх колонках одинакова.
#
# (Таблица приведена построчно — в комментарии строка с именем пакета
# «shellcheck» начиналась бы с директивы, которую литер не может разобрать.)
TIER_2_DISTRO='
ansible|ansible|ansible
ansible-lint|ansible-lint|ansible-lint
yamllint|yamllint|yamllint
shellcheck|shellcheck|shellcheck
'

synth_install_tier "$TIER_2_DISTRO"

# ---------------------------------------------------------------------------
# Часть 2: upstream-релизы (пин версии + sha256)
# ---------------------------------------------------------------------------
#
#   logical   | url_amd64                                         | sha256_amd64 | url_arm64                                          | sha256_arm64 | файл
#   ----------+---------------------------------------------------+--------------+---------------------------------------------------+--------------+------
#   kubectl   | dl.k8s.io/release/v1.37.1/bin/linux/amd64/kubectl | 65691ff7...  | dl.k8s.io/release/v1.37.1/bin/linux/arm64/kubectl | ff749f4b...  | -
#   helm      | get.helm.sh/helm-v3.22.1-linux-amd64.tar.gz          | 896cf636...  | get.helm.sh/helm-v3.22.1-linux-arm64.tar.gz       | 4c29e286...  | helm
#   kustomize | github.com/.../kustomize_v5.8.3_linux_amd64.tar.gz| cb9e3119...  | github.com/.../kustomize_v5.8.3_linux_arm64.tar.gz| 9867b764... | kustomize
#   tofu      | github.com/.../tofu_1.13.1_linux_amd64.tar.gz      | 378ada19...  | github.com/.../tofu_1.13.1_linux_arm64.tar.gz    | 9c1ef375...  | tofu
#   hadolint  | github.com/.../hadolint-linux-x86_64              | c7187db9...  | github.com/.../hadolint-linux-arm64              | f6198ef8...  | -
#
# Контрольные суммы — из официальных файлов релизов:
#   kubectl   — https://dl.k8s.io/release/v1.37.1/bin/linux/<arch>/kubectl.sha256
#   helm      — https://get.helm.sh/helm-v3.22.1-linux-<arch>.tar.gz.sha256sum
#   kustomize — checksums.txt в релизе kubernetes-sigs/kustomize
#   opentofu  — tofu_1.13.1_SHA256SUMS в релизе opentofu/opentofu
#   hadolint  — checksums.sha256 в релизе hadolint/hadolint
#
# Источники checksum'ов зафиксированы, чтобы ревизор мог перепроверить pin.
TIER_2_UPSTREAM='
kubectl|https://dl.k8s.io/release/v1.37.1/bin/linux/amd64/kubectl|65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8|https://dl.k8s.io/release/v1.37.1/bin/linux/arm64/kubectl|ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7|-
helm|https://get.helm.sh/helm-v3.22.1-linux-amd64.tar.gz|896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea|https://get.helm.sh/helm-v3.22.1-linux-arm64.tar.gz|4c29e286b279d170fa048ddfc3e4e83dcd069ca9c52102766ba672d7149e694d|helm
kustomize|https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.8.3/kustomize_v5.8.3_linux_amd64.tar.gz|cb9e31198d3f63b44848bd0afc4c8efc56e6cfef9c93a4a39a211940e6decd61|https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.8.3/kustomize_v5.8.3_linux_arm64.tar.gz|9867b76482cfc6d25b546abc1d2b5a32bd137505aba640649b4b378f64f6d68f|kustomize
tofu|https://github.com/opentofu/opentofu/releases/download/v1.13.1/tofu_1.13.1_linux_amd64.tar.gz|378ada19d4bc70c43732004e8159be771b23b9a5afdf059e5f8a2b3fa2c70a69|https://github.com/opentofu/opentofu/releases/download/v1.13.1/tofu_1.13.1_linux_arm64.tar.gz|9c1ef375aa1852db0b2888aa921b640c71f8140d4682aa4fec99378a64fa7dc3|tofu
hadolint|https://github.com/hadolint/hadolint/releases/download/v2.15.1/hadolint-linux-x86_64|c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507|https://github.com/hadolint/hadolint/releases/download/v2.15.1/hadolint-linux-arm64|f6198ef8090f404dbb771abfee086eb8c48ac177f30da7fd3510aca35b344b5d|-
'

synth_install_upstream_binaries "$TIER_2_UPSTREAM"

# OpenTofu — FOSS-продолжение HashiCorp Terraform (бинарь называется `tofu`).
# Симлинк `terraform` нужен для привычного интерфейса (команды и формат
# конфигурации/стейтов совместимы); `terraform version` при этом честно
# печатает «OpenTofu». Сам HashiCorp Terraform (лицензия BUSL) в образ не
# кладём.
ln -sf /usr/local/bin/tofu /usr/local/bin/terraform
