# MeshWhisper Node
# Single-container deployment for relay, push forwarding, media storage, and prekey directory.
#
# Build:
#   docker build -t meshwhisper-node .
#
# Run:
#   docker run -p 443:8080 \
#     -e PORT=8080 \
#     -e BASE_URL=https://msg.myapp.com \
#     -e PUSH_WEBHOOK_URL=https://your-push-server/notify \
#     meshwhisper-node

FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build


FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Non-root user for security
RUN addgroup -S meshwhisper && adduser -S meshwhisper -G meshwhisper
USER meshwhisper

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8080}/health || exit 1

CMD ["node", "dist/index.js"]
