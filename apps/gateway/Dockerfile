# syntax=docker/dockerfile:1.7
#
# Build context: the repo root. Build from the root:
#   docker build -f apps/gateway/Dockerfile -t tix-gateway:dev .

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
RUN pnpm --filter gateway build

FROM base AS runtime
COPY --from=builder /repo /repo
WORKDIR /repo/apps/gateway
EXPOSE 4000
CMD ["node", "dist/index.mjs"]
