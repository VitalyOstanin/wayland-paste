#!/usr/bin/env bash
# Reload the extension's current code into the RUNNING GNOME Shell session
# without a re-login.
#
# Why this is needed: GNOME Shell caches an extension's ES modules by directory
# URI. Re-importing the same UUID returns the cached (old) code, and bumping
# metadata.json version only triggers "you need to log out". The workaround is to
# load the code under a brand-new UUID each time (a throwaway "dev copy"), so its
# module URIs are fresh.
#
# Usage:
#   tools/dev-reload.sh
# then paste the printed one-liner into Looking Glass (Alt+F2 -> "lg" ->
# Evaluator tab). Run the one-liner ONCE.
#
# The canonical wayland-paste@VitalyOstanin is disabled in-session only (its
# enabled-extensions entry is preserved, so a normal re-login restores it). Dev
# copies are throwaway: this script removes previous ones on each run, and
# `tools/dev-cleanup.sh` (or a re-login) clears the last one.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTDIR="$HOME/.local/share/gnome-shell/extensions"
CANONICAL="wayland-paste@VitalyOstanin"
STATE="$SRC/tools/.dev-state"

# 1. Validate the source before copying anything.
echo "==> Compiling schema and checking syntax in $SRC"
glib-compile-schemas "$SRC/schemas"
for f in extension.js prefs.js lib/*.js; do
  node --check "$SRC/$f"
done

# 2. Next index + previous dev uuid (for the snippet to disable it).
PREV_UUID=""
IDX=1
if [[ -f "$STATE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE"
  PREV_UUID="${DEV_UUID:-}"
  IDX=$(( ${DEV_IDX:-0} + 1 ))
fi
NEW_UUID="wayland-paste-dev${IDX}@VitalyOstanin"
NEW_DIR="$EXTDIR/$NEW_UUID"

# 3. Remove stale dev copies on disk, but KEEP the previous one ($PREV_UUID):
#    it may still be loaded/enabled in the running shell, and deleting its dir
#    would remove its compiled schema and break the disable/rebase that the next
#    Looking Glass snippet performs (enable() would fail with "Schema ... could
#    not be found"). The previous copy is deleted on the run after next, once it
#    has been superseded and disabled.
shopt -s nullglob
for d in "$EXTDIR"/wayland-paste-dev*@VitalyOstanin; do
  [[ -n "$PREV_UUID" && "$(basename "$d")" == "$PREV_UUID" ]] && continue
  rm -rf "$d"
done
shopt -u nullglob

# 4. Copy the current code into the new dev dir and rewrite its UUID + name.
mkdir -p "$NEW_DIR/lib" "$NEW_DIR/schemas"
cp "$SRC"/extension.js "$SRC"/prefs.js "$NEW_DIR"/
[[ -f "$SRC/stylesheet.css" ]] && cp "$SRC/stylesheet.css" "$NEW_DIR"/
cp "$SRC"/lib/*.js "$NEW_DIR"/lib/
cp "$SRC"/schemas/*.xml "$SRC"/schemas/gschemas.compiled "$NEW_DIR"/schemas/
jq --arg u "$NEW_UUID" --arg n "Wayland Paste (dev ${IDX})" \
  '.uuid=$u | .name=$n' "$SRC"/metadata.json > "$NEW_DIR"/metadata.json

# 4b. Make GObject type names unique per dev copy. GJS derives a GType name from
# the file path + class name (e.g. "Gjs_lib_indicator_WaylandPasteIndicator"),
# NOT from the uuid/dir. GType names are process-global and survive disable, so a
# dev copy would collide with the canonical extension's already-registered type.
# Suffix the project's GObject class names (WaylandPaste*) with the dev index so
# each load registers a distinct GType. Export names (ClipboardIndicator,
# ShortcutRow) are untouched, so imports keep working.
sed -E -i "s/class (WaylandPaste[A-Za-z0-9]+)/class \1Dev${IDX}/g" \
  "$NEW_DIR"/extension.js "$NEW_DIR"/prefs.js "$NEW_DIR"/lib/*.js

# 5. Keep enabled-extensions tidy: drop stale dev uuids, ensure the canonical is
#    still listed (so a plain re-login restores good state).
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

# 6. Persist state for the next run.
cat > "$STATE" <<EOF
DEV_IDX=$IDX
DEV_UUID=$NEW_UUID
EOF

# 7. Print the Looking Glass one-liner.
disable_list="'$CANONICAL'"
[[ -n "$PREV_UUID" ]] && disable_list="$disable_list,'$PREV_UUID'"

cat <<EOF

==> Dev copy ready: $NEW_DIR

Paste this ONCE into Looking Glass (Alt+F2 -> lg -> Evaluator tab):

const M=Main.extensionManager;[$disable_list].forEach(u=>{try{M._callExtensionDisable(u);}catch(e){}});const uuid='$NEW_UUID';M.createExtensionObject(uuid,Gio.File.new_for_path('$NEW_DIR'),2);M._callExtensionInit(uuid).then(ok=>ok&&M._callExtensionEnable(uuid));

After testing, run tools/dev-cleanup.sh (or just re-login) to restore the
canonical extension.
EOF
