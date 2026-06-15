FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Копируем workspace-конфигурацию
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/ui/package.json packages/ui/tsconfig.json ./packages/ui/

# Устанавливаем зависимости
RUN pnpm install --frozen-lockfile

# Копируем исходный код и собираем
COPY packages/shared/src ./packages/shared/src
COPY packages/core/src ./packages/core/src
COPY packages/core/prompts ./packages/core/prompts
COPY packages/ui/src ./packages/ui/src
COPY packages/ui/index.html packages/ui/vite.config.ts packages/ui/tsconfig.json ./packages/ui/

RUN pnpm --filter @synth/shared build
RUN pnpm --filter @synth/core build
RUN pnpm --filter @synth/ui build

# --- Продакшен-образ ---
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Копируем workspace-конфиг и production-зависимости
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/

RUN pnpm install --frozen-lockfile --prod

# Копируем собранные артефакты
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/ui/dist ./packages/ui/dist

ENV NODE_ENV=production
ENV SYNTH_DATA_DIR=/var/synth/data
ENV SYNTH_CORE_PORT=4300

EXPOSE 4300

VOLUME ["/var/synth/data"]

ENTRYPOINT ["node", "packages/core/dist/main.js", "serve", "--ui", "packages/ui/dist"]
