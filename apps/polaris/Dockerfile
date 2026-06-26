# syntax=docker/dockerfile:1.7
FROM node:22-bookworm AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

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
  pnpm install --no-frozen-lockfile --filter polaris...

COPY apps/polaris ./apps/polaris
COPY apps/polaris-web/scripts ./apps/polaris-web/scripts

RUN pnpm --filter polaris run build
RUN rm -rf /prod \
  && mkdir -p /prod \
  && cp -R apps/polaris/dist /prod/dist \
  && cp -R apps/polaris-web/scripts /prod/polaris-web-scripts \
  && cp apps/polaris/package.json /prod/package.json \
  && pnpm install --prod --no-frozen-lockfile --dir /prod

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /prod/package.json ./package.json
COPY --from=build /prod/node_modules ./node_modules
COPY --from=build /prod/dist ./apps/polaris/dist
COPY --from=build /prod/polaris-web-scripts ./apps/polaris-web/scripts

EXPOSE 8787

CMD ["node", "apps/polaris/dist/scripts/polaris.js", "portal", "8787", "0.0.0.0"]
