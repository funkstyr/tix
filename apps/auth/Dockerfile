# syntax=docker/dockerfile:1.7
#
# Build context: the repo root (so the monorepo's pnpm-lock and other
# workspaces resolve). Build from the root:
#   docker build -f apps/auth/Dockerfile -t tix-auth:dev .
#
# The runtime image carries the full monorepo (dev deps included) so the same
# image can run either the service (default CMD) or the migration job
# (`pnpm db:migrate` via Job command override). Optimising the runtime to a
# pnpm-deploy'd, prod-only tree is a follow-up — for the dev kind target,
# image size beats `pnpm deploy` complexity.

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
RUN pnpm --filter auth build

FROM base AS runtime
COPY --from=builder /repo /repo
WORKDIR /repo/apps/auth
EXPOSE 4001
CMD ["node", "dist/index.mjs"]
