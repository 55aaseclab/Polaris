# syntax=docker/dockerfile:1.7
FROM node:22-bookworm AS build

RUN npm install -g pnpm@10.33.0

WORKDIR /workspace

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV PNPM_STORE_DIR=/pnpm/store

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/polaris/package.json apps/polaris/package.json
COPY packages/polaris-auth-server/package.json packages/polaris-auth-server/package.json

RUN --mount=type=cache,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter polaris...

COPY apps/polaris ./apps/polaris
COPY packages/polaris-auth-server ./packages/polaris-auth-server

RUN --mount=type=cache,target=/pnpm/store \
  pnpm --filter polaris run build

FROM node:22-bookworm

WORKDIR /workspace

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /workspace/node_modules ./node_modules
COPY apps/polaris/package.json apps/polaris/package.json
COPY --from=build /workspace/packages/polaris-auth-server ./packages/polaris-auth-server
COPY --from=build /workspace/apps/polaris/node_modules ./apps/polaris/node_modules
COPY --from=build /workspace/apps/polaris/dist ./apps/polaris/dist

EXPOSE 8787

CMD ["node", "apps/polaris/dist/scripts/polaris.js", "server", "8787", "0.0.0.0"]
