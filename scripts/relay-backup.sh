#!/usr/bin/env bash
# Snapshot the relay's SQLite database to a timestamped backup file.
#
# Uses sqlite3's online .backup command — atomic, no need to stop the relay.
# Reads through the running container so the WAL is correctly checkpointed.
#
# Configuration via environment variables:
#   COMPOSE_DIR       Directory containing docker-compose.yml. Default: /opt/meshwhisper
#   SERVICE           Compose service name. Default: node
#   DB_PATH           DB path inside the container. Default: /data/meshwhisper.db
#   BACKUP_DIR        Host directory to write backups to. Default: /opt/meshwhisper/backups
#   RETAIN            Number of recent backups to keep (older ones deleted). Default: 14
#   COMPRESS          Set to 1 to gzip backups after creation. Default: 1
#
# Typical operator setup: schedule via cron, e.g.
#   0 3 * * * /opt/meshwhisper/repo/scripts/relay-backup.sh >> /var/log/relay-backup.log 2>&1
#
# Recovery procedure is documented in docs/self-hosting.md "Backup and recovery".

set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/meshwhisper}"
SERVICE="${SERVICE:-node}"
DB_PATH="${DB_PATH:-/data/meshwhisper.db}"
BACKUP_DIR="${BACKUP_DIR:-/opt/meshwhisper/backups}"
RETAIN="${RETAIN:-14}"
COMPRESS="${COMPRESS:-1}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_NAME="meshwhisper-${STAMP}.db"
IN_CONTAINER_TMP="/data/.backup-${STAMP}.db"

mkdir -p "${BACKUP_DIR}"

cd "${COMPOSE_DIR}"

echo "==> hot-backup via sqlite3 .backup inside ${SERVICE} container"
docker compose exec -T "${SERVICE}" sqlite3 "${DB_PATH}" ".backup ${IN_CONTAINER_TMP}"

echo "==> copying backup out of the container"
docker compose cp "${SERVICE}:${IN_CONTAINER_TMP}" "${BACKUP_DIR}/${BACKUP_NAME}"

echo "==> removing temporary in-container snapshot"
docker compose exec -T "${SERVICE}" rm "${IN_CONTAINER_TMP}"

if [ "${COMPRESS}" = "1" ]; then
  echo "==> compressing backup"
  gzip -f "${BACKUP_DIR}/${BACKUP_NAME}"
  BACKUP_NAME="${BACKUP_NAME}.gz"
fi

# Rotate: keep the most recent ${RETAIN} backups, delete older.
if [ "${RETAIN}" -gt 0 ]; then
  cd "${BACKUP_DIR}"
  ls -1t meshwhisper-*.db* 2>/dev/null | tail -n +"$((RETAIN + 1))" | while read -r old; do
    echo "==> rotating out ${old}"
    rm -f -- "${old}"
  done
fi

SIZE=$(du -h "${BACKUP_DIR}/${BACKUP_NAME}" | cut -f1)
echo "==> ok: ${BACKUP_DIR}/${BACKUP_NAME} (${SIZE})"
