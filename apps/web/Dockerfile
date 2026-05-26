# syntax=docker/dockerfile:1.7
#
# Build context: the repo root. Build from the root:
#   docker build -f apps/web/Dockerfile -t tix-web:dev .
#
# Two-stage: a node builder produces the Vite `dist/`, then an nginx runtime
# serves the static assets. Unlike the service Dockerfiles, the runtime does
# not carry the monorepo — there is no migration Job to share an image with
# and the web pod only needs the compiled bundle.

ARG NODE_VERSION=24-alpine
ARG PNPM_VERSION=11.2.1
ARG NGINX_VERSION=1.27-alpine

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
RUN pnpm --filter web build

FROM nginx:${NGINX_VERSION} AS runtime
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
