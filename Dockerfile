# syntax=docker/dockerfile:1.7
# Northstar platform API, jobs worker and one-shot migration job — one build, three targets:
#   docker build -f Dockerfile --target api     -t northstar-api .
#   docker build -f Dockerfile --target worker  -t northstar-worker .
#   docker build -f Dockerfile --target migrate -t northstar-migrate .
# Runtime images: Node 22 on Alpine, non-root (uid 1000 "node"), no npm/shell needed at runtime, read-only root FS
# friendly (writes only to /tmp — mount it as tmpfs), HEALTHCHECK via node's fetch (works without curl/wget).
# Pin NODE_IMAGE by digest in CI (e.g. node:22-alpine@sha256:…) for reproducible builds.
ARG NODE_IMAGE=node:22-alpine

# ---- deps: full install (dev deps needed for tsc) ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV CI=true NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

# ---- build: compile src/platform → dist-v2, then drop dev dependencies -------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.nest.json ./
COPY src ./src
RUN npm run build \
 && find dist-v2 -name '*.test.*' -delete \
 && npm prune --omit=dev --ignore-scripts \
 && rm -rf node_modules/.cache

# ---- runtime base shared by api / worker / migrate --------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ARG APP_VERSION=0.0.0
ARG GIT_SHA=""
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    BIND_HOST=0.0.0.0 \
    HOME=/tmp \
    DATA_DIR=/tmp/northstar \
    MAIL_DIR=/tmp/northstar/mail \
    HRM_UPLOAD_PATH=/tmp/northstar/uploads \
    MIGRATIONS_DIR=/app/migrations \
    NODE_OPTIONS=--enable-source-maps
# tini reaps zombies and forwards SIGTERM so graceful shutdown (drain + finish jobs) works as PID 1.
RUN apk add --no-cache tini && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn*
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist-v2 ./dist-v2
COPY --chown=root:root package.json ./
COPY --chown=root:root migrations ./migrations
COPY --chown=root:root db ./db
COPY --chown=root:root scripts/migrate.mjs scripts/bootstrap-production.mjs scripts/smoke-prod.mjs ./scripts/
# Code is owned by root and not writable by the runtime user.
USER node
ENTRYPOINT ["/sbin/tini", "--"]

FROM runtime AS api
ENV BACKEND_V2_PORT=4100
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.BACKEND_V2_PORT||4100)+'/api/v2/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist-v2/platform/main.js"]

FROM runtime AS worker
ENV WORKER_HEALTH_PORT=4190
EXPOSE 4190
HEALTHCHECK --interval=15s --timeout=3s --start-period=45s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||4190)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist-v2/platform/jobs/worker.js"]

# One-shot: applies pending migrations (advisory-locked, checksum-verified) and exits. Needs DATABASE_URL (owner role);
# optional DATABASE_ADMIN_URL + RUNTIME_DB_PASSWORD to (re)create the hrm_runtime role on first install.
FROM runtime AS migrate
HEALTHCHECK NONE
CMD ["node", "scripts/migrate.mjs"]
