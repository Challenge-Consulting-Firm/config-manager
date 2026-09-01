# syntax=docker/dockerfile:1.7

# ---- Stage 1: build the React SPA + BFF ----
FROM node:24-slim AS build
WORKDIR /app

# Install pnpm with the npm bundled in the Node image. corepack is deliberately
# not used: Node 26 images no longer ship it, so the next LTS bump would break
# this layer (#73). Version must match package.json#packageManager.
RUN npm i -g pnpm@9.0.0

# Install workspace manifests + lockfile first for better layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/bff/package.json apps/bff/
COPY apps/bff/scripts apps/bff/scripts
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/

RUN pnpm install --frozen-lockfile

# Copy the rest of the source.
COPY . .

# Build the React SPA, then bundle the BFF (which also copies SPA assets).
RUN pnpm --filter @config-manager/web build
RUN pnpm --filter @config-manager/bff build

# ---- Stage 2: runtime ----
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Same as the build stage: no corepack. Version must match package.json#packageManager.
RUN npm i -g pnpm@9.0.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/bff/package.json apps/bff/
COPY packages/shared/package.json packages/shared/

# Install only production deps for the BFF (and workspace symlinks).
RUN pnpm install --prod --frozen-lockfile

# The BFF is a self-contained esbuild bundle; only the built output + SPA
# assets are needed at runtime.
COPY --from=build /app/apps/bff/dist apps/bff/dist
COPY --from=build /app/apps/bff/public apps/bff/public

# Run as the unprivileged `node` user shipped with the official image so a
# container breakout does not start with uid 0.
USER node

EXPOSE 3000
CMD ["node", "apps/bff/dist/index.js"]
