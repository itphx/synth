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
# НЕТ ни одного RUN: всё, что требует исполнения кода (npm install, corepack,
# chmod, symlink), делается в builder. Это позволяет собрать arm64-образ на
# amd64-раннере без QEMU/binfmt. `${BUILDPLATFORM:-linux/amd64}` — безопасный
# дефолт для kaniko и legacy `docker build` (они не задают этот ARG).
ARG BUILDPLATFORM

FROM --platform=${BUILDPLATFORM:-linux/amd64} node:22-alpine AS builder

ARG SYNTH_VERSION=latest

RUN npm install -g @itphx/synth@${SYNTH_VERSION} \
    && npm cache clean --force

# pnpm (через corepack) нужен в runtime-образе. Готовим его здесь, на платформе
# билдера, и переносим готовые symlink'и + кэш corepack — так в целевой стадии
# не приходится исполнять arm64-код под эмуляцией.
RUN corepack enable && corepack prepare pnpm@latest --activate

# Каталог с symlink'ами для runtime: COPY одиночного symlink разыменовывает его
# (превращает в файл), а COPY каталога — сохраняет ссылки. Абсолютные цели живут
# в целевом образе (node:22-alpine + пакет из builder).
RUN set -eux; \
    mkdir -p /out/bin; \
    ln -s /usr/local/lib/node_modules/@itphx/synth/dist/cli.js /out/bin/synth; \
    ln -s /usr/local/lib/node_modules/corepack/dist/pnpm.js /out/bin/pnpm; \
    ln -s /usr/local/lib/node_modules/corepack/dist/pnpx.js /out/bin/pnpx; \
    ln -s /usr/local/lib/node_modules/corepack/dist/yarn.js /out/bin/yarn; \
    ln -s /usr/local/lib/node_modules/corepack/dist/yarnpkg.js /out/bin/yarnpkg

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

# symlink'и CLI и pnpm/yarn — каталогом (одиночный COPY разыменовывает ссылки).
COPY --from=builder /out/bin/ /usr/local/bin/
COPY --from=builder /root/.cache/node/corepack /root/.cache/node/corepack

EXPOSE 4300

VOLUME ["/var/synth/data"]

ENTRYPOINT ["synth", "serve", "--port", "4300", "--host", "0.0.0.0"]
