# syntax=docker/dockerfile:1.7
FROM node:22-bookworm AS build

RUN npm install -g pnpm@10.33.0

WORKDIR /vault

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV PNPM_STORE_DIR=/pnpm/store

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/polaris/package.json apps/polaris/package.json
COPY apps/polaris-portal/package.json apps/polaris-portal/package.json
COPY packages/polaris-auth-server/package.json packages/polaris-auth-server/package.json
COPY packages/polaris-shell/package.json packages/polaris-shell/package.json
COPY packages/surface-coding/package.json packages/surface-coding/package.json
COPY packages/surface-wanghai/package.json packages/surface-wanghai/package.json

RUN --mount=type=cache,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter polaris... --filter polaris-portal...

COPY apps/polaris ./apps/polaris
COPY apps/polaris-portal ./apps/polaris-portal
COPY packages/polaris-auth-server ./packages/polaris-auth-server
COPY packages/polaris-shell ./packages/polaris-shell
COPY packages/surface-coding ./packages/surface-coding
COPY packages/surface-wanghai ./packages/surface-wanghai

RUN --mount=type=cache,target=/pnpm/store \
  pnpm run build:surfaces \
  && pnpm --filter polaris run build

FROM node:22-bookworm

WORKDIR /vault

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /vault/node_modules ./node_modules
COPY apps/polaris/package.json apps/polaris/package.json
COPY --from=build /vault/packages/polaris-auth-server ./packages/polaris-auth-server
COPY --from=build /vault/packages/polaris-shell ./packages/polaris-shell
COPY --from=build /vault/packages/surface-coding ./packages/surface-coding
COPY --from=build /vault/packages/surface-wanghai ./packages/surface-wanghai
COPY --from=build /vault/apps/polaris-portal/dist ./apps/polaris-portal/dist
COPY --from=build /vault/apps/polaris/node_modules ./apps/polaris/node_modules
COPY --from=build /vault/apps/polaris/dist ./apps/polaris/dist

EXPOSE 8787

CMD ["node", "apps/polaris/dist/scripts/polaris.js", "server", "8787", "0.0.0.0"]
