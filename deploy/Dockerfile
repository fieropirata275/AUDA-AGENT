# AUDA core + AUDA's computer in one isolated container.
# The container *is* AUDA's computer for the `local` driver: its workspace,
# browser profile and database live on the /data volume and survive restarts.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation ca-certificates bash coreutils findutils gzip procps curl git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && npm install --no-save tsx

ENV NODE_ENV=production \
    AUDA_DATA=/data \
    AUDA_PORT=4610 \
    AUDA_CHROMIUM=/usr/bin/chromium

RUN useradd -m -u 1001 auda && mkdir -p /data && chown -R auda /data /app
USER auda
VOLUME ["/data"]
EXPOSE 4610
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost:4610/api/health || exit 1
CMD ["node", "--import", "tsx", "server/src/bin/auda.ts"]
