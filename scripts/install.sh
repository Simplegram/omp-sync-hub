#!/usr/bin/env bash
# omp-sync-hub – one-step Linux/macOS client installer (git-based)
# Usage:
#   curl -sL https://raw.githubusercontent.com/Simplegram/omp-sync-hub/main/scripts/install.sh | bash
#   ./scripts/install.sh git@github.com:Simplegram/omp-agent-config.git

set -euo pipefail

GIT_URL="${1:-}"
if [[ -z "$GIT_URL" ]]; then
    read -rp "Enter your agent config git URL (e.g. git@github.com:user/repo.git): " GIT_URL
fi

AGENT_DIR="${HOME}/.omp/agent"
EXT_DIR="${AGENT_DIR}/extensions"
ENV_FILE="${AGENT_DIR}/.env"
EXT_FILE="${EXT_DIR}/omp-sync.ts"

mkdir -p "$EXT_DIR"

# Write .env
printf 'OMP_GIT_URL=%s\n' "$GIT_URL" > "$ENV_FILE"
echo "  [OK] Wrote $ENV_FILE"

# Install extension: local repo first, then download
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_EXT="${SCRIPT_DIR}/../extension/omp-sync.ts"
if [[ -f "$REPO_EXT" ]]; then
    cp "$REPO_EXT" "$EXT_FILE"
    echo "  [OK] Copied extension from local repo to $EXT_FILE"
else
    RAW_URL="https://raw.githubusercontent.com/Simplegram/omp-sync-hub/main/extension/omp-sync.ts"
    echo "  Downloading extension from $RAW_URL ..."
    curl -sL "$RAW_URL" -o "$EXT_FILE"
    echo "  [OK] Downloaded extension to $EXT_FILE"
fi

echo ""
echo "========================================"
echo "  omp-sync-hub client installed"
echo "========================================"
echo ""
echo "  Git URL   : $GIT_URL"
echo "  Agent dir : $AGENT_DIR"
echo "  .env file : $ENV_FILE"
echo "  Extension : $EXT_FILE"
echo ""
echo "  On next omp launch, the extension will:"
echo "   - init git repo in $AGENT_DIR if needed"
echo "   - write .gitignore (excludes .env, agent.db, sessions, memories)"
echo "   - pull configs on session_start, push on turn_end/shutdown"
echo ""
echo "  Use /sync [push|pull|status|test] inside omp for manual sync."
echo ""
