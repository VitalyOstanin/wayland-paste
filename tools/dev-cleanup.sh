#!/usr/bin/env bash
# Remove dev copies created by tools/dev-reload.sh and restore the canonical
# extension, without requiring a re-login.
#
# Usage:
#   tools/dev-cleanup.sh
# then paste the printed one-liner into Looking Glass to disable the last dev
# copy and re-activate the canonical extension in the running session.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTDIR="$HOME/.local/share/gnome-shell/extensions"
CANONICAL="wayland-paste@VitalyOstanin"
STATE="$SRC/tools/.dev-state"

LAST_UUID=""
if [[ -f "$STATE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE"
  LAST_UUID="${DEV_UUID:-}"
fi

# Remove dev dirs on disk.
shopt -s nullglob
for d in "$EXTDIR"/wayland-paste-dev*@VitalyOstanin; do
  rm -rf "$d"
done
shopt -u nullglob

# Clean enabled-extensions: drop dev uuids, ensure canonical is listed.
python3 - "$CANONICAL" <<'PY'
import subprocess, sys, ast
canonical = sys.argv[1]
cur = subprocess.check_output(
    ["gsettings", "get", "org.gnome.shell", "enabled-extensions"]).decode().strip()
lst = ast.literal_eval(cur) if cur and cur != "@as []" else []
lst = [u for u in lst if not u.startswith("wayland-paste-dev")]
if canonical not in lst:
    lst.append(canonical)
val = "[" + ", ".join("'%s'" % x for x in lst) + "]"
subprocess.check_call(
    ["gsettings", "set", "org.gnome.shell", "enabled-extensions", val])
PY

# Keep the monotonic dev counter (DEV_IDX): GJS caches imported modules by
# directory URI for the whole login session, so a dev UUID must never be reused
# until the next re-login. Clear only the "previous live copy" marker.
if [[ -f "$STATE" ]]; then
  cat > "$STATE" <<EOF
DEV_IDX=${DEV_IDX:-0}
DEV_UUID=
EOF
fi

disable_part=""
[[ -n "$LAST_UUID" ]] && disable_part="try{M._callExtensionDisable('$LAST_UUID');}catch(e){}"

cat <<EOF

==> Dev copies removed from disk; enabled-extensions cleaned.

Paste this into Looking Glass to disable the last dev copy and re-activate the
canonical extension in the running session (or just re-login):

const M=Main.extensionManager;${disable_part}M._callExtensionEnable('$CANONICAL');
EOF
