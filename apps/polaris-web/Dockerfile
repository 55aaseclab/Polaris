# syntax=docker/dockerfile:1.7
FROM node:22-bookworm AS build

RUN corepack enable \
  && corepack prepare pnpm@10.33.0 --activate

WORKDIR /workspace

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV PNPM_STORE_DIR=/pnpm/store

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/polaris/package.json apps/polaris/package.json
COPY apps/polaris-web/package.json apps/polaris-web/package.json

RUN --mount=type=cache,target=/pnpm/store \
  pnpm install --no-frozen-lockfile --filter polaris-web...

COPY apps/polaris-web ./apps/polaris-web

ARG VITE_POLARIS_API_BASE=/api
ARG VITE_PASEO_APP_BASE_URL=http://localhost/paseo
ARG VITE_CLERK_PUBLISHABLE_KEY=

ENV NODE_ENV=production
ENV VITE_POLARIS_API_BASE=${VITE_POLARIS_API_BASE}
ENV VITE_PASEO_APP_BASE_URL=${VITE_PASEO_APP_BASE_URL}
ENV VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY}

RUN --mount=type=cache,target=/pnpm/store \
  pnpm --filter polaris-web run build

FROM nginx:1.27-alpine

COPY apps/polaris-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/polaris-web/dist /usr/share/nginx/html

EXPOSE 80
