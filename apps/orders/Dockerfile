# syntax=docker/dockerfile:1.7
#
# Build context: the repo root. Build from the root:
#   docker build -f apps/orders/Dockerfile -t tix-orders:dev .

ARG NODE_VERSION=26-alpine
ARG PNPM_VERSION=11.2.1

FROM node:${NODE_VERSION} AS base
WORKDIR /repo
RUN apk add --no-cache libc6-compat \
  && npm i -g pnpm@${PNPM_VERSION}
ENV CI=1

FROM base AS builder
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:packages
RUN pnpm --filter orders build

FROM base AS runtime
COPY --from=builder /repo /repo
WORKDIR /repo/apps/orders
EXPOSE 4003
CMD ["node", "dist/index.mjs"]
