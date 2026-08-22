# syntax=docker/dockerfile:1

# One image, two processes (§8). The web and worker share every package and
# differ only in entrypoint, so building twice would just be two chances for
# them to drift. Pick the process with a variable:
#
#   docker run -e SERVICE=web    … streamarena
#   docker run -e SERVICE=worker … streamarena
#
# A variable rather than a start command, because that is the part a deploy
# platform will let you script. See scripts/start.mjs.

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production


# ── dependencies ────────────────────────────────────────────────────────────
# Manifests only. This layer is the expensive one, and copying it separately
# means it is rebuilt when a dependency changes rather than on every edit.
FROM base AS deps

COPY package.json package-lock.json ./
COPY packages/shared/package.json                packages/shared/
COPY packages/core/package.json                  packages/core/
COPY packages/db/package.json                    packages/db/
COPY packages/kick/package.json                  packages/kick/
COPY packages/catalog/package.json               packages/catalog/
COPY packages/platform/package.json              packages/platform/
COPY packages/games/bonus-hunt/package.json      packages/games/bonus-hunt/
COPY packages/games/slot-tournament/package.json packages/games/slot-tournament/
COPY apps/web/package.json                       apps/web/
COPY apps/worker/package.json                    apps/worker/

# NODE_ENV=production would otherwise drop the dev dependencies, and TypeScript
# is one of them.
RUN npm ci --include=dev


# ── build ───────────────────────────────────────────────────────────────────
FROM deps AS build

# tailwind.config.js is needed by `npm run build` — the stylesheet is compiled
# at build time now, not by a CDN script in the browser.
COPY tsconfig.base.json tsconfig.json tailwind.config.js ./
COPY packages packages
COPY apps apps
COPY scripts scripts

RUN npm run build && npm prune --omit=dev && npm cache clean --force


# ── runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime

# The whole tree, which keeps the workspace symlinks in node_modules pointing at
# the right relative paths. The TypeScript sources ride along at a few hundred
# KB; excluding them would mean maintaining a per-package copy list that breaks
# silently the day someone adds a package. Two directories are load-bearing and
# easy to miss: packages/db/migrations (read at release time, relative to
# migrate.js) and apps/web/public (the dashboard and overlay).
COPY --from=build --chown=node:node /app /app

USER node
EXPOSE 3000

# No HEALTHCHECK here on purpose: the probe belongs with the service definition,
# which knows the port. Both processes answer /healthz (liveness) and /readyz
# (datastore reachable) — the worker included, so one deploy config covers both.
CMD ["node", "scripts/start.mjs"]
