# syntax=docker/dockerfile:1.7

FROM node:22-bookworm AS build

ARG VITE_PASEO_APP_BASE_URL=/welcome
ARG VITE_BASE_PATH=/landing/

RUN npm install -g pnpm@10.33.0

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/landing-page/package.json apps/landing-page/package.json

RUN --mount=type=cache,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter landing-page...

COPY apps/landing-page ./apps/landing-page

ENV VITE_PASEO_APP_BASE_URL=${VITE_PASEO_APP_BASE_URL}
ENV VITE_BASE_PATH=${VITE_BASE_PATH}

RUN --mount=type=cache,target=/pnpm/store \
  pnpm --filter landing-page run build

FROM node:22

RUN npm install -g serve@14

WORKDIR /opt/landing-page

COPY --from=build /workspace/apps/landing-page/dist ./dist

EXPOSE 5173

CMD ["sh", "-lc", "exec serve -s dist -l 5173"]
