#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/zcast-player"
CUSTOM_DIR="/opt/zignage/zcast-player"

# Ensure parent exists
mkdir -p /opt/zignage

# Symlink to standardized path
ln -sfn "$APP_DIR" "$CUSTOM_DIR" || true

# CLI convenience symlink
ln -sfn "$APP_DIR/zcast-player" /usr/local/bin/zcast-player || true

# Ensure packaged fallback manifest exists if copied by extraResources
if [ -d "$APP_DIR/resources/mock" ] && [ ! -f "$APP_DIR/resources/mock/manifest.json" ]; then
  echo '{}' > "$APP_DIR/resources/mock/manifest.json"
fi

echo "[postinst] zcast-player installed at $APP_DIR (symlinked at $CUSTOM_DIR)"
