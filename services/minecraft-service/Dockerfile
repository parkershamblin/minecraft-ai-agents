# Build context = repo root (npm workspaces need the root lockfile and the
# @civ/events source). Runtime is tsx — no build step for a service whose
# hot path is I/O, keeping the container identical to `task dev`.
FROM node:22-slim
WORKDIR /repo

# Dependency layer: manifests only, cached until a dependency actually changes.
# patches/ must land before npm ci — the root postinstall runs patch-package
# (minecraft-data trail def; test/trailParticleParse.test.ts is the canary).
COPY package.json package-lock.json ./
COPY patches/ patches/
COPY packages/events/package.json packages/events/
COPY services/minecraft-service/package.json services/minecraft-service/
RUN npm ci --no-audit --no-fund

# Source: the contract package (types + schemas) and this service.
COPY packages/events/ packages/events/
COPY services/minecraft-service/ services/minecraft-service/

WORKDIR /repo/services/minecraft-service
EXPOSE 8003
CMD ["npx", "tsx", "src/index.ts"]
