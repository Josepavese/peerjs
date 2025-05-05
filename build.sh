#!/usr/bin/env bash
#
# Builds the project in an isolated Node 18 environment managed by nvm.
# If nvm or Node 18 aren’t present, they’re installed on-the-fly.
# The script exits on the first error.

set -euo pipefail

NVM_VERSION="v0.39.5"
NODE_VERSION="18"            # Pin to a specific major, or "18.20.3", etc.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

#-----------------------------------------------------------------------------
# 1. Ensure nvm is installed
#-----------------------------------------------------------------------------
if [[ ! -d "$HOME/.nvm" ]]; then
  echo "› nvm not found – installing $NVM_VERSION…"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | bash
fi

# shellcheck disable=SC1090
source "$HOME/.nvm/nvm.sh"            # load nvm
# shellcheck disable=SC1091
[[ -s "$HOME/.nvm/bash_completion" ]] && source "$HOME/.nvm/bash_completion"

#-----------------------------------------------------------------------------
# 2. Install / use the requested Node version
#-----------------------------------------------------------------------------
if ! nvm ls "$NODE_VERSION" &>/dev/null; then
  echo "› Installing Node $NODE_VERSION…"
  nvm install "$NODE_VERSION"
fi
nvm use "$NODE_VERSION"               # switches only in this shell

#-----------------------------------------------------------------------------
# 3. Install dependencies (deterministic, no pre-/post-install scripts)
#-----------------------------------------------------------------------------
cd "$PROJECT_ROOT"
if [[ -f package-lock.json ]]; then
  npm ci --ignore-scripts
else
  npm install --ignore-scripts
fi

#-----------------------------------------------------------------------------
# 4. Build the project
#-----------------------------------------------------------------------------
echo "> Running build…"
npm run build

echo "✓ Build complete using Node $(node -v)"
