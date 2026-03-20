#!/usr/bin/env bash
#
# Builds the project in an isolated Node 18 environment managed by nvm.
# If nvm or Node 18 aren’t present, they’re installed on-the-fly.
# The script exits on the first error.

set -euo pipefail

NVM_VERSION="v0.39.5"
NODE_VERSION="18"            # Pin to a specific major, or "18.20.3", etc.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="$PROJECT_ROOT/.build-cache"
FINGERPRINT_FILE="$CACHE_DIR/peerjs-build-input.sha256"
DIST_SENTINEL="$PROJECT_ROOT/dist/peerjs.min.js"

# Keep the build isolated from parent npm workspace/config context.
# This script is often invoked from another monorepo workspace.
unset npm_config_prefix NPM_CONFIG_PREFIX || true
unset npm_config_workspace NPM_CONFIG_WORKSPACE || true
unset npm_config_workspaces NPM_CONFIG_WORKSPACES || true
unset npm_config_include_workspace_root NPM_CONFIG_INCLUDE_WORKSPACE_ROOT || true
export npm_config_workspaces=false
export npm_config_include_workspace_root=false

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

compute_build_fingerprint() {
  local line_hashes=()
  local path

  line_hashes+=("node=$NODE_VERSION")

  for path in package.json package-lock.json tsconfig.json .parcelrc build.sh; do
    if [[ -f "$PROJECT_ROOT/$path" ]]; then
      line_hashes+=("$path:$(sha256_file "$PROJECT_ROOT/$path")")
    fi
  done

  if [[ -d "$PROJECT_ROOT/lib" ]]; then
    while IFS= read -r path; do
      local rel_path="${path#"$PROJECT_ROOT/"}"
      line_hashes+=("$rel_path:$(sha256_file "$path")")
    done < <(find "$PROJECT_ROOT/lib" -type f | LC_ALL=C sort)
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n' "${line_hashes[@]}" | sha256sum | awk '{print $1}'
  else
    printf '%s\n' "${line_hashes[@]}" | shasum -a 256 | awk '{print $1}'
  fi
}

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
# 3. Skip build if inputs are unchanged and artifact already exists
#-----------------------------------------------------------------------------
cd "$PROJECT_ROOT"
mkdir -p "$CACHE_DIR"

CURRENT_FINGERPRINT="$(compute_build_fingerprint)"
if [[ -f "$FINGERPRINT_FILE" && -f "$DIST_SENTINEL" ]]; then
  PREVIOUS_FINGERPRINT="$(<"$FINGERPRINT_FILE")"
  if [[ "$CURRENT_FINGERPRINT" == "$PREVIOUS_FINGERPRINT" ]]; then
    echo "✓ No relevant changes detected, skipping PeerJS build."
    exit 0
  fi
fi

#-----------------------------------------------------------------------------
# 4. Install dependencies (deterministic, no pre-/post-install scripts)
#-----------------------------------------------------------------------------
if [[ -f package-lock.json ]]; then
  npm --workspaces=false --include-workspace-root=false ci --ignore-scripts
else
  npm --workspaces=false --include-workspace-root=false install --ignore-scripts
fi

#-----------------------------------------------------------------------------
# 5. Build the project
#-----------------------------------------------------------------------------
echo "> Running build…"
npm --workspaces=false --include-workspace-root=false run build:raw

printf '%s\n' "$CURRENT_FINGERPRINT" > "$FINGERPRINT_FILE"
echo "✓ Build complete using Node $(node -v)"
