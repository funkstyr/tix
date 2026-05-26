# syntax=docker/dockerfile:1.7
#
# Build context: the repo root. Build from the root:
#   docker build -f apps/tickets/Dockerfile -t tix-tickets:dev .
#
# Mirrors apps/auth/Dockerfile — the runtime image carries the full monorepo
# so the same image can run either the service (default CMD) or the migration
# Job (`pnpm db:migrate` via Job command override).

ARG NODE_VERSION=24-alpine
ARG PNPM_VERSION=11.2.1

FROM node:${NODE_VERSION} AS base
WORKDIR /repo
RUN apk add --no-cache libc6-compat \
  && corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate
ENV CI=1

FROM base AS builder
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:packages
RUN pnpm --filter tickets build

FROM base AS runtime
COPY --from=builder /repo /repo
WORKDIR /repo/apps/tickets
EXPOSE 4002
CMD ["node", "dist/index.mjs"]
