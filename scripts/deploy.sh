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

usage() {
  cat <<EOF
Usage: $0 [prudence|site|all]

  prudence  — build and deploy Prudence PWA to ${PRUDENCE_REMOTE}
  site      — build and deploy the marketing site to ${SITE_REMOTE}
  all       — both (default)

Required env:
  REMOTE_HOST       — server hostname or IP

Optional env:
  REMOTE_USER       — SSH user (default: root)
  SSH_KEY           — path to SSH private key (default: ~/.ssh/id_ed25519)
  PRUDENCE_REMOTE   — remote webroot for Prudence
  SITE_REMOTE       — remote webroot for the site
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

target="${1:-all}"
case "$target" in
  prudence) deploy_prudence ;;
  site)     deploy_site ;;
  all)      deploy_prudence; deploy_site ;;
  -h|--help) usage ;;
  *) usage; exit 1 ;;
esac
