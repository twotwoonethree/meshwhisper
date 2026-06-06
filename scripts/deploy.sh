#!/usr/bin/env bash
# Deploy script for prudence + site to a remote host via rsync over SSH.
#
# Configure with environment variables:
#   REMOTE_HOST       — server hostname or IP (required)
#   REMOTE_USER       — SSH user (default: root)
#   SSH_KEY           — path to SSH private key (default: ~/.ssh/id_ed25519)
#   PRUDENCE_REMOTE   — remote webroot for Prudence PWA
#                       (default: /var/www/prudence.meshwhisper.org)
#   SITE_REMOTE       — remote webroot for the marketing site
#                       (default: /var/www/meshwhisper.org)
#
# These webroot paths must match the nginx server blocks on the host.

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:?set REMOTE_HOST to your server hostname or IP}"
REMOTE_USER="${REMOTE_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PRUDENCE_DIST="$REPO_ROOT/prudence/dist"
PRUDENCE_REMOTE="${PRUDENCE_REMOTE:-/var/www/prudence.meshwhisper.org}"

SITE_DIST="$REPO_ROOT/site/dist"
SITE_REMOTE="${SITE_REMOTE:-/var/www/meshwhisper.org}"

LINKED_DEVICES_DIST="$REPO_ROOT/examples/linked-devices/dist"
LINKED_DEVICES_REMOTE="${LINKED_DEVICES_REMOTE:-/var/www/linked-devices.meshwhisper.org}"

usage() {
  cat <<EOF
Usage: $0 [prudence|site|linked-devices|all]

  prudence         — build and deploy Prudence PWA to ${PRUDENCE_REMOTE}
  site             — build and deploy the marketing site to ${SITE_REMOTE}
  linked-devices   — build and deploy the linked-devices example to ${LINKED_DEVICES_REMOTE}
  all              — prudence + site (default; linked-devices opt-in)

Required env:
  REMOTE_HOST            — server hostname or IP

Optional env:
  REMOTE_USER            — SSH user (default: root)
  SSH_KEY                — path to SSH private key (default: ~/.ssh/id_ed25519)
  PRUDENCE_REMOTE        — remote webroot for Prudence
  SITE_REMOTE            — remote webroot for the site
  LINKED_DEVICES_REMOTE  — remote webroot for the linked-devices example
EOF
}

deploy_prudence() {
  echo "==> Building Prudence"
  (cd "$REPO_ROOT/prudence" && npm run build)
  echo "==> Deploying to ${REMOTE_USER}@${REMOTE_HOST}:${PRUDENCE_REMOTE}"
  rsync -az --delete -e "ssh -i $SSH_KEY" \
    "$PRUDENCE_DIST/" "${REMOTE_USER}@${REMOTE_HOST}:${PRUDENCE_REMOTE}/"
  echo "==> Prudence deployed"
}

deploy_site() {
  echo "==> Building site"
  (cd "$REPO_ROOT/site" && npm run build)
  echo "==> Deploying to ${REMOTE_USER}@${REMOTE_HOST}:${SITE_REMOTE}"
  rsync -az --delete -e "ssh -i $SSH_KEY" \
    "$SITE_DIST/" "${REMOTE_USER}@${REMOTE_HOST}:${SITE_REMOTE}/"
  echo "==> Site deployed"
}

deploy_linked_devices() {
  echo "==> Building linked-devices example"
  (cd "$REPO_ROOT/examples/linked-devices" && npm install && npm run build)
  echo "==> Ensuring ${LINKED_DEVICES_REMOTE} exists"
  ssh -i "$SSH_KEY" "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p ${LINKED_DEVICES_REMOTE}"
  echo "==> Deploying to ${REMOTE_USER}@${REMOTE_HOST}:${LINKED_DEVICES_REMOTE}"
  rsync -az --delete -e "ssh -i $SSH_KEY" \
    "$LINKED_DEVICES_DIST/" "${REMOTE_USER}@${REMOTE_HOST}:${LINKED_DEVICES_REMOTE}/"
  echo "==> linked-devices deployed"
}

target="${1:-all}"
case "$target" in
  prudence)        deploy_prudence ;;
  site)            deploy_site ;;
  linked-devices)  deploy_linked_devices ;;
  all)             deploy_prudence; deploy_site ;;
  -h|--help)       usage ;;
  *) usage; exit 1 ;;
esac
