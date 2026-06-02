# syntax=docker/dockerfile:1.7
#
# Build context: the repo root. Build from the root:
#   docker build -f apps/synthetic/Dockerfile -t tix-synthetic:dev .
#
# Headless probe — no `EXPOSE` because the synthetic has no HTTP server; it runs
# as a CronJob Job to completion. Unlike the other services it is NOT bundled:
# `pnpm -F @tix/synthetic probe` runs `node src/index.ts` under Node's native
# type-stripping, so there's no app `dist/` to build — only the workspace
# packages it imports (@tix/saga-client, @tix/service-runtime) need their dist,
# which `build:packages` produces.

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

FROM base AS runtime
COPY --from=builder /repo /repo
WORKDIR /repo/apps/synthetic
CMD ["pnpm", "-F", "@tix/synthetic", "probe"]
