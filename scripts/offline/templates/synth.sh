#!/bin/sh
# Synth launcher (offline-бандл). Запускает bundled Node, без зависимости от PATH.
set -eu

SELF=$0
# Разрешаем symlink launcher (~/.local/bin/synth -> .../current/bin/synth).
if command -v readlink >/dev/null 2>&1; then
  RESOLVED=$(readlink -f "$SELF" 2>/dev/null || true)
  [ -n "$RESOLVED" ] && SELF=$RESOLVED
fi
ROOT=$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd)

if [ -x "$ROOT/runtime/node/bin/node" ]; then
  PATH="$ROOT/runtime/node/bin:$ROOT/tools:$PATH"
  export PATH
  exec "$ROOT/runtime/node/bin/node" "$ROOT/app/dist/cli.js" "$@"
fi

echo "Повреждён offline-бандл Synth: не найден $ROOT/runtime/node/bin/node" >&2
exit 1
