# MeshWhisper Node
# Single-container deployment for relay, push forwarding, media storage, and prekey directory.
#
# Build:
#   docker build -t meshwhisper-node .
#
# Run (dev):
#   docker run -p 8080:8080 \
#     -e BASE_URL=https://msg.myapp.com \
#     -e PUSH_WEBHOOK_URL=http://push:4000/notify \
#     meshwhisper-node
#
# Run (production — mount a volume for the SQLite database):
#   docker run -p 8080:8080 \
#     -v meshwhisper_data:/data \
#     -e DB_PATH=/data/meshwhisper.db \
#     -e BASE_URL=https://msg.myapp.com \
#     -e PUSH_WEBHOOK_URL=http://push:4000/notify \
#     meshwhisper-node

# ---- Build stage ----
# Needs python3/make/g++ to compile better-sqlite3 native bindings.
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ---- Runtime stage ----
# Copy compiled node_modules from builder so better-sqlite3 .node binary
# is included without needing build tools in the final image.
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy compiled deps and built output from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Create data directory for SQLite database and set ownership.
# sqlite (CLI) is added so operators can run the documented hot-backup
# procedure via `docker compose exec node sqlite3 /data/meshwhisper.db
# ".backup /data/backup-DATE.db"` without spawning a sidecar container.
RUN apk add --no-cache sqlite && \
    mkdir -p /data && \
    addgroup -S meshwhisper && \
    adduser -S meshwhisper -G meshwhisper && \
    chown meshwhisper:meshwhisper /data

USER meshwhisper

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8080}/health || exit 1

CMD ["node", "dist/index.js"]
