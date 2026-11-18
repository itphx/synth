# Образ собирается из опубликованного npm-пакета @itphx/synth.
# Зависимости (@itphx/synth-core, @itphx/synth-ui, @itphx/synth-shared) ставятся как
# транзитивные npm-зависимости глобально, промпты/UI резолвятся оттуда.
#
# Слой хранения (ADR-096/ADR-097): драйвер `@itphx/synth-storage-postgres`
# — optionalDependency ядра, `pg` — optionalDependency драйвера. npm ставит
# optional-зависимости транзитивных пакетов по умолчанию, поэтому
# `storage.backend=postgres` работает без доустановки; `--omit=optional`/
# `--no-optional` здесь использовать НЕЛЬЗЯ (иначе драйвер выкинется из образа).
# В чанки ниже драйвер попадает в @[g-p]* (`@itphx`), `pg` — в [g-p]* — новых
# слоёв не требуется.
#
# Multi-stage: ставим пакет в builder, а в runtime переносим только нужные каталоги.
# Иначе один слой `npm install -g` (npm-кэш + все зависимости) весит ~280 МБ, и
# GitVerse registry отклоняет загрузку такого blob'а с 413 Request Entity Too Large.
# Зависимости раскладываются на чанки, чтобы каждый пушимый слой был небольшим.
#
# multi-arch (amd64/arm64): стадия сборки идёт на платформе билдера
# (`$BUILDPLATFORM`), runtime — на целевой (`$TARGETPLATFORM`, по умолчанию
# берётся из `--platform`, а без buildx — платформа хоста). В runtime-стадии
# НЕТ ни одного RUN: всё, что требует исполнения кода (npm install, corepack
# для шимов yarn, chmod, symlink), делается в builder. Это позволяет собрать arm64-образ на
# amd64-раннере без QEMU/binfmt. `${BUILDPLATFORM:-linux/amd64}` — безопасный
# дефолт для kaniko и legacy `docker build` (они не задают этот ARG).
ARG BUILDPLATFORM

FROM --platform=${BUILDPLATFORM:-linux/amd64} node:22-alpine AS builder

ARG SYNTH_VERSION=latest

# Версия pnpm фиксирована и совпадает с CI (`npm install -g pnpm@12.14.0`
# в .gitverse/workflows/*) и с `packageManager` в package.json репозитория.
ARG PNPM_VERSION=12.14.0

RUN npm install -g @itphx/synth@${SYNTH_VERSION} \
    && npm cache clean --force

# pnpm нужен в runtime-образе (агент собирает чужие проекты). Ставим его через
# npm, а НЕ через corepack: в CI `corepack prepare pnpm@…` отрабатывает с кодом 0,
# но иногда не создаёт кэш `/root/.cache/node/corepack` (поведение нестабильно и
# зависит от окружения) — сборка падала на `cp` этого каталога в HOME. npm-путь
# детерминирован: пакет и бинарь появляются в /usr/local/lib/node_modules всегда.
#
# В pnpm 12 `pnpm` — нативный бинарь из optionalDependencies
# `@pnpm/exe.<platform>-<libc>`, а `bin/pnpm.mjs` (вход, который использует
# corepack) выбирает бинарь по ТЕКУЩЕЙ платформе. Builder всегда amd64
# (`$BUILDPLATFORM`), а runtime может быть arm64 — поэтому кладём оба musl-варианта,
# иначе arm64-образ получил бы x64-бинарь и `pnpm` в нём не запускался бы.
# Плейсхолдеры `pnpm`/`pn`/`pnpx`/`pnx` в корне пакета и вложенную копию
# x64-бинаря (`pnpm/node_modules/@pnpm/exe.linux-x64-musl`, которую создаёт
# optional-зависимость) удаляем: бинарники лежат в общем `/usr/local/lib/node_modules/@pnpm`
# (по одному на архитектуру), нужные имена даёт @pnpm/exe, а /out/bin/pnpm
# указывает на платформенно-независимый wrapper. Иначе x64-бинарь попадал бы в
# слой дважды (~56 МБ лишних).
RUN npm install -g "pnpm@${PNPM_VERSION}" \
    && npm install -g --force "@pnpm/exe.linux-x64-musl@${PNPM_VERSION}" \
    && npm install -g --force "@pnpm/exe.linux-arm64-musl@${PNPM_VERSION}" \
    && rm -f /usr/local/lib/node_modules/pnpm/pnpm \
             /usr/local/lib/node_modules/pnpm/pn \
             /usr/local/lib/node_modules/pnpm/pnpx \
             /usr/local/lib/node_modules/pnpm/pnx \
    && rm -rf /usr/local/lib/node_modules/pnpm/node_modules \
    && chmod +x /usr/local/lib/node_modules/pnpm/bin/pnpm.mjs \
               /usr/local/lib/node_modules/pnpm/bin/pnpx.mjs \
    && npm cache clean --force

# Corepack остаётся только ради yarn/yarnpkg (агент работает и с чужими
# проектами): в runtime пробрасываются те же corepack-шимы (`/out/bin/yarn`,
# `/out/bin/yarnpkg`), сам corepack есть в базовом образе. `corepack prepare`
# намеренно НЕ вызываем — его кэш не нужен и на него нельзя опираться; шимы yarn
# при наличии сети докачают нужную версию, как и раньше. Эта строка фиксирует
# шимы в builder (в целевую стадию переносятся явные symlink'и ниже).
RUN corepack enable yarn

# Каталог с symlink'ами для runtime: COPY одиночного symlink разыменовывает его
# (превращает в файл), а COPY каталога — сохраняет ссылки. Абсолютные цели живут
# в целевом образе (node:22-alpine + пакеты из builder). `pnpm`/`pnpx` — на
# wrapper (он сам выбирает нативный бинарь под платформу runtime).
RUN set -eux; \
    mkdir -p /out/bin; \
    ln -s /usr/local/lib/node_modules/@itphx/synth/dist/cli.js /out/bin/synth; \
    ln -s /usr/local/lib/node_modules/pnpm/bin/pnpm.mjs /out/bin/pnpm; \
    ln -s /usr/local/lib/node_modules/pnpm/bin/pnpx.mjs /out/bin/pnpx; \
    ln -s /usr/local/lib/node_modules/corepack/dist/yarn.js /out/bin/yarn; \
    ln -s /usr/local/lib/node_modules/corepack/dist/yarnpkg.js /out/bin/yarnpkg

# Каталоги runtime-пользователя uid 1000 (PROP-137, non-root): HOME и каталог
# данных. Готовятся ЗДЕСЬ, в builder, и переносятся `COPY --chown` — в runtime
# нет ни одного RUN (кросс-сборка arm64 без QEMU), поэтому `mkdir`/`chown` там
# невозможны. Кэш pnpm/store в HOME создаются по требованию: HOME принадлежит
# 1000:1000, а бинарь pnpm уже лежит в образе (сети при первом запуске не нужно).
RUN set -eux; \
    mkdir -p /out/home/.cache /out/data; \
    chown -R 1000:1000 /out/home /out/data

# Раскладываем top-level зависимости по чанкам (по первому символу имени; для
# scope-пакетов — по символу после @). Каждый чанк станет отдельным COPY-слоем.
RUN set -eux; \
    NM=/usr/local/lib/node_modules/@itphx/synth/node_modules; \
    mkdir -p /chunks/1 /chunks/2 /chunks/3 /chunks/4 /chunks/5 /chunks/6; \
    mv "$NM"/[a-f]* /chunks/1/; \
    mv "$NM"/[g-p]* /chunks/2/; \
    mv "$NM"/[q-z]* /chunks/3/; \
    mv "$NM"/@[a-f]* /chunks/4/; \
    mv "$NM"/@[g-p]* /chunks/5/; \
    mv "$NM"/@[q-z]* /chunks/6/

FROM node:22-alpine

# Идентификатор сборки (SYNTH_BUILD_ID): commit sha в CI, локально —
# git short sha (+`-dirty`). Отдаётся в GET /health (`build`), чтобы PWA
# замечала пересборку той же semver; пусто — неизвестно (фоллбек на версию).
ARG SYNTH_BUILD_ID=""
ENV SYNTH_BUILD_ID=$SYNTH_BUILD_ID

# OCI-метки: org.opencontainers.image.source связывает пакет в GHCR с
# репозиторием-источником (иначе GitHub Packages не показывает связь и
# унаследованные права доступа). Для GitVerse-сборки (kaniko) метки инертны.
LABEL org.opencontainers.image.source="https://github.com/itphx/synth"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.title="Synth"
LABEL org.opencontainers.image.description="Synth standalone core: CLI + embedded HTTP API and web UI."

ENV NODE_ENV=production
ENV SYNTH_DATA_DIR=/var/synth/data

# Сам пакет: package.json (нужен для резолва @itphx/synth) и собранный CLI.
COPY --from=builder /usr/local/lib/node_modules/@itphx/synth/package.json /usr/local/lib/node_modules/@itphx/synth/package.json
COPY --from=builder /usr/local/lib/node_modules/@itphx/synth/dist /usr/local/lib/node_modules/@itphx/synth/dist

# Зависимости чанками — каждый COPY даёт отдельный небольшой слой.
COPY --from=builder /chunks/1/ /usr/local/lib/node_modules/@itphx/synth/node_modules/
COPY --from=builder /chunks/2/ /usr/local/lib/node_modules/@itphx/synth/node_modules/
COPY --from=builder /chunks/3/ /usr/local/lib/node_modules/@itphx/synth/node_modules/
COPY --from=builder /chunks/4/ /usr/local/lib/node_modules/@itphx/synth/node_modules/
COPY --from=builder /chunks/5/ /usr/local/lib/node_modules/@itphx/synth/node_modules/
COPY --from=builder /chunks/6/ /usr/local/lib/node_modules/@itphx/synth/node_modules/

# pnpm: wrapper (`bin/pnpm.mjs` + `dist/`) и нативные бинарни для обеих
# поддерживаемых архитектур (linux musl x64/arm64). `/usr/local/bin/pnpm` —
# symlink на wrapper, он сам выбирает бинарь по платформе runtime, поэтому один
# и тот же слой годится и для amd64, и для arm64. Сети при запуске не нужно.
COPY --from=builder /usr/local/lib/node_modules/pnpm /usr/local/lib/node_modules/pnpm
COPY --from=builder /usr/local/lib/node_modules/@pnpm /usr/local/lib/node_modules/@pnpm

# symlink'и CLI и pnpm/yarn — каталогом (одиночный COPY разыменовывает ссылки).
# `/usr/local/bin` и `/usr/local/lib/node_modules` world-readable/executable, под
# uid 1000 работают без правки.
COPY --from=builder /out/bin/ /usr/local/bin/

# HOME пользователя uid 1000 (PROP-137): кэш pnpm и `~/.config` должны
# быть writable — иначе pnpm/агентские утилиты падают с EACCES на /root.
COPY --from=builder --chown=1000:1000 /out/home /home/synth
ENV HOME=/home/synth

# Каталог данных: принадлежит 1000:1000. При первом создании named volume Docker
# копирует ownership/содержимое ИЗ ОБРАЗА, поэтому новый том сразу доступен на
# запись. Существующий root-том нужно один раз перевести (`chown -R 1000:1000`)
# — docs/MAINTENANCE.md, раздел «Переход на non-root (PROP-137)».
COPY --from=builder --chown=1000:1000 /out/data /var/synth/data

EXPOSE 4300

VOLUME ["/var/synth/data"]

# Non-root (PROP-137 Ф1): root допустим только на этапе сборки образа.
USER 1000

ENTRYPOINT ["synth", "serve", "--port", "4300", "--host", "0.0.0.0"]
