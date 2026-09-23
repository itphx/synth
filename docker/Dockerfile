# Образ собирается из опубликованного npm-пакета @itphx/synth.
# Зависимости (@itphx/synth-core, @itphx/synth-ui, @itphx/synth-shared) ставятся как
# транзитивные npm-зависимости глобально, промпты/UI резолвятся оттуда.
#
# Multi-stage: ставим пакет в builder, а в runtime переносим только нужные каталоги.
# Иначе один слой `npm install -g` (npm-кэш + все зависимости) весит ~280 МБ, и
# GitVerse registry отклоняет загрузку такого blob'а с 413 Request Entity Too Large.
# Зависимости раскладываются на чанки, чтобы каждый пушимый слой был небольшим.

FROM node:22-alpine AS builder

ARG SYNTH_VERSION=latest

RUN npm install -g @itphx/synth@${SYNTH_VERSION} \
    && npm cache clean --force

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

RUN corepack enable && corepack prepare pnpm@latest --activate

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

RUN ln -s /usr/local/lib/node_modules/@itphx/synth/dist/cli.js /usr/local/bin/synth

EXPOSE 4300

VOLUME ["/var/synth/data"]

ENTRYPOINT ["synth", "serve", "--port", "4300", "--host", "0.0.0.0"]
