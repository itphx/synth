# Образ собирается из опубликованного npm-пакета @itphx/synth.
# Зависимости (@itphx/core, @itphx/ui, @itphx/shared) ставятся как
# транзитивные npm-зависимости глобально, промпты/UI резолвятся оттуда.
FROM node:22-alpine

ARG SYNTH_VERSION=latest

RUN corepack enable && corepack prepare pnpm@latest --activate

RUN npm install -g @itphx/synth@${SYNTH_VERSION}

ENV NODE_ENV=production
ENV SYNTH_DATA_DIR=/var/synth/data

EXPOSE 4300

VOLUME ["/var/synth/data"]

ENTRYPOINT ["synth", "serve", "--port", "4300", "--host", "0.0.0.0"]
