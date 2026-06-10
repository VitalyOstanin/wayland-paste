# CLAUDE.md

Guidance for AI agents and contributors working on this extension.

## Table of Contents

- [Project overview](#project-overview)
- [Hard constraint: GNOME 45-50](#hard-constraint-gnome-45-50)
- [No Remote Desktop dialog: the core mechanism](#no-remote-desktop-dialog-the-core-mechanism)
- [API surface used](#api-surface-used)
- [Files](#files)
- [Procedure: verify against a GNOME version](#procedure-verify-against-a-gnome-version)
- [Syntax check and schema](#syntax-check-and-schema)
- [Manual testing](#manual-testing)

## Project overview

`wayland-paste` is a clipboard history manager for GNOME Shell on Wayland that
reproduces [Diodon](https://github.com/diodon-dev/diodon)'s workflow. The
rationale for each decision (mirroring Diodon, in-process input injection, the
focus/paste timing, polling, cleanup, the reused shortcut picker) is recorded in
[docs/ADR](docs/ADR). Read the ADRs before changing how pasting or change
detection works.

## Hard constraint: GNOME 45-50

`metadata.json` declares `shell-version` 45 through 50. Every change MUST keep
the extension working across all of them. GNOME's API is not stable across major
versions, so any use of a Meta/Shell/Clutter/St symbol must be verified against
each declared version. Do not assume a symbol exists just because it works on the
locally installed version. Use feature detection, not version-number branching.

## No Remote Desktop dialog: the core mechanism

The reason this is an extension and not an app: a Shell extension runs inside the
`gnome-shell` process and can synthesize input with a Clutter virtual device,
exactly as the on-screen keyboard does (`js/ui/keyboard.js`). That path does not
open an XDG RemoteDesktop portal session, so no permission dialog and no
screen-sharing indicator appear. An external app (Diodon, CopyQ) only has the
portal path and therefore triggers the dialog. See
[docs/ADR/0002](docs/ADR/0002-inject-via-virtual-device.md).

## API surface used

| Symbol                                                        | Source      | Tier  | Notes                                            |
| ------------------------------------------------------------- | ----------- | ----- | ------------------------------------------------ |
| `Extension`, `getSettings()`                                  | gnome-shell | 45-50 | `js/extensions/extension.js`                     |
| `Main.panel.addToStatusArea`, `Main.wm.addKeybinding/removeKeybinding` | gnome-shell | 45-50 | panel + keybinding registration         |
| `PanelMenu.Button`, `PopupMenu.*`                             | gnome-shell | 45-50 | menu, sections, items, separator                 |
| `St.Clipboard` `get_text` / `set_text` / `get_content` / `set_content` / `get_mimetypes` | st (gnome-shell) | 45-50 | verified in `src/st/st-clipboard.h` |
| `St.ClipboardType.CLIPBOARD` / `PRIMARY`                      | st          | 45-50 | selection kinds                                  |
| `Clutter` virtual device: `get_default_backend().get_default_seat().create_virtual_device(InputDeviceType.KEYBOARD_DEVICE)` | mutter | 45-50 | used by the on-screen keyboard |
| `virtualDevice.notify_key(time, evcode, Clutter.KeyState.PRESSED/RELEASED)` | mutter | 45-50 | injection by evdev keycode (layout-independent); time = `GLib.get_monotonic_time()` |
| `global.display.focus_window`, `window.get_wm_class()` / `get_wm_class_instance()` | mutter | 45-50 | paste target + per-app match |
| `Meta.KeyBindingFlags`, `Shell.ActionMode`                    | mutter/shell| 45-50 | keybinding flags/modes                           |
| `Gtk.ShortcutLabel`, `Gtk.EventControllerKey`, `Gtk.accelerator_*` | gtk4 (prefs) | 45-50 | shortcut picker in prefs only            |

The injection and clipboard symbols were verified on every branch 45-50 via the
local checkouts (the on-screen keyboard uses `create_virtual_device` /
`notify_keyval` on all of them — we use `notify_key` from the same device for
layout-independent paste; `st-clipboard.h` exposes the five clipboard methods on
45 and 50).

## Files

- `extension.js` — wiring, focus capture, paste timing, keybinding, cleanup.
- `prefs.js` — Adwaita preferences; `ShortcutRow` capture picker (from
  mute-all-mics) for the menu hotkey.
- `lib/historyStore.js` — history entries and on-disk persistence (no Shell deps).
- `lib/clipboardMonitor.js` — clipboard polling, filter, synchronization.
- `lib/paster.js` — Clutter virtual device, accelerator parsing, per-app match.
- `lib/indicator.js` — panel button + searchable menu (mouse-driven, type-to-filter).
- `schemas/` — GSettings schema.
- `stylesheet.css` — search entry, thumbnail and list styling.
- `docs/ADR/` — architecture decision records.

## Procedure: verify against a GNOME version

Upstream sources are checked out locally with `gnome-45` … `gnome-50` branches:

- `/home/vyt/devel/gnome/gnome-shell`
- `/home/vyt/devel/gnome/mutter`

Use `git grep <ref>` without switching the working tree:

```sh
cd /home/vyt/devel/gnome/gnome-shell
# injection mechanism (used by the on-screen keyboard)
for v in 45 46 47 48 49 50; do
  echo "=== gnome-$v ==="
  git grep -nE 'create_virtual_device|notify_keyval' origin/gnome-$v -- js/ui/keyboard.js | head
done
# clipboard methods
for v in 45 50; do
  echo "=== gnome-$v ==="
  git grep -hE 'st_clipboard_(get_text|set_text|get_content|set_content|get_mimetypes)' \
    origin/gnome-$v -- src/st/st-clipboard.h | sort -u
done
```

## Syntax check and schema

```sh
node --check extension.js
node --check prefs.js
node --check lib/historyStore.js lib/clipboardMonitor.js lib/paster.js lib/indicator.js
glib-compile-schemas schemas/
```

`node --check` validates ESM syntax without resolving `gi://` imports.

## Manual testing

1. Symlink the repo into `~/.local/share/gnome-shell/extensions/` and compile the
   schema there.
2. Re-login (Wayland) and `gnome-extensions enable wayland-paste@VitalyOstanin`.
3. Copy several pieces of text; open the menu from the panel icon or the
   shortcut; confirm the history fills, newest first.
4. Type in the search box to filter; select entries with the mouse.
5. With instant paste on, focus a text field, open the menu, choose an entry, and
   confirm it is typed into the field. Repeat in a terminal and confirm
   Shift+Ctrl+V is used (no characters lost, no newline run).
6. Confirm no Remote Desktop dialog and no orange screen-sharing indicator appear.
7. Toggle primary tracking, synchronization, images, and the ignore pattern;
   confirm each behaves.
8. Disable the extension; confirm the panel icon disappears, the shortcut stops
   working, and `journalctl -b /usr/bin/gnome-shell -p warning` shows no leaked
   sources or errors.
