#!/usr/bin/env bash
# Deploy script for prudence + site to the live host.
#
# The webroot paths must match nginx server blocks:
#   prudence.meshwhisper.org → /var/www/prudence.meshwhisper.org/
#   meshwhisper.org          → /var/www/meshwhisper.org/
#
# These paths are NOT obvious — there is also a stale /var/www/prudence
# directory that is not served. Do not deploy there.

set -euo pipefail

REMOTE_USER=root
REMOTE_HOST=157.180.50.60
SSH_KEY="${SSH_KEY:-$HOME/.ssh/hetzner_ex44}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PRUDENCE_DIST="$REPO_ROOT/prudence/dist"
PRUDENCE_REMOTE="/var/www/prudence.meshwhisper.org"

SITE_DIST="$REPO_ROOT/site/dist"
SITE_REMOTE="/var/www/meshwhisper.org"

usage() {
  cat <<EOF
Usage: $0 [prudence|site|all]

  prudence  — build and deploy Prudence PWA to ${PRUDENCE_REMOTE}
  site      — build and deploy the marketing site to ${SITE_REMOTE}
  all       — both (default)

Env:
  SSH_KEY   — path to the SSH key (default ~/.ssh/hetzner_ex44)
EOF
}

deploy_prudence() {
  echo "==> Building Prudence"
  (cd "$REPO_ROOT/prudence" && npm run build)
  echo "==> Deploying to ${PRUDENCE_REMOTE}"
  rsync -az --delete -e "ssh -i $SSH_KEY" \
    "$PRUDENCE_DIST/" "${REMOTE_USER}@${REMOTE_HOST}:${PRUDENCE_REMOTE}/"
  echo "==> Prudence deployed: https://prudence.meshwhisper.org"
}

deploy_site() {
  echo "==> Building site"
  (cd "$REPO_ROOT/site" && npm run build)
  echo "==> Deploying to ${SITE_REMOTE}"
  rsync -az --delete -e "ssh -i $SSH_KEY" \
    "$SITE_DIST/" "${REMOTE_USER}@${REMOTE_HOST}:${SITE_REMOTE}/"
  echo "==> Site deployed: https://meshwhisper.org"
}

target="${1:-all}"
case "$target" in
  prudence) deploy_prudence ;;
  site)     deploy_site ;;
  all)      deploy_prudence; deploy_site ;;
  -h|--help) usage ;;
  *) usage; exit 1 ;;
esac
