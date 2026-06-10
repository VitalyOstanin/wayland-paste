# Wayland Paste

A clipboard history manager for GNOME Shell on Wayland. It provides the same
workflow as [Diodon](https://github.com/diodon-dev/diodon) — a searchable history
of recent clipboard entries with paste-on-selection. Diodon itself works fine on
Wayland; the difference is that its auto-paste goes through the Remote Desktop
portal (a permission grant and a persistent screen-sharing indicator), whereas
this is a GNOME Shell extension that pastes in-process, with no portal and no
indicator.

## Table of Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [Settings](#settings)
- [Compatibility](#compatibility)
- [Installation](#installation)
- [Development](#development)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [License](#license)

## Why this exists

This is not a fix for a broken feature: [Diodon](https://github.com/diodon-dev/diodon)
is fully functional on a GNOME Wayland session. The only friction is how its
automatic paste is delivered. Diodon is an X11 application, and on Wayland its
"paste on selection" synthesizes Ctrl+V through a path that GNOME routes via the
Remote Desktop portal — which means a permission grant and a persistent orange
screen-sharing indicator in the top bar while it is active. Not wanting to deal
with that portal machinery is the entire reason this extension exists.

A GNOME Shell extension runs inside the compositor and can synthesize input
through the same in-process virtual device the on-screen keyboard uses. That path
involves no portal, no dialog and no indicator. Wayland Paste reproduces Diodon's
behaviour over that path.

## What it does

- Keeps a history of the most recent clipboard (and, optionally, primary
  selection) entries.
- Shows the history in a top-bar menu, driven by the mouse, with a type-to-filter
  search box.
- On selecting an entry: copies it back to the clipboard and, with instant paste
  enabled, types the paste shortcut into the previously focused window.
- Uses a per-application paste shortcut where needed (terminals paste with
  Shift+Ctrl+V).
- Optionally stores images, synchronizes the clipboard and primary selection, and
  persists the history across sessions.

## Settings

The options mirror Diodon's, with a few Wayland-specific additions.

| Setting                         | Type            | Default      | Diodon equivalent        |
| ------------------------------- | --------------- | ------------ | ------------------------ |
| History size                    | 1-500           | 25           | recent-items-size        |
| Track clipboard                 | on / off        | on           | use-clipboard            |
| Track primary selection         | on / off        | on           | use-primary              |
| Synchronize clipboard & primary | on / off        | off          | synchronize-clipboards   |
| Persist history across sessions | on / off        | on           | keep-clipboard-content   |
| Store images                    | on / off        | off          | add-images               |
| Ignore pattern (regex)          | string          | `^\s+$`      | filter-pattern           |
| Paste on selection              | on / off        | on           | instant-paste            |
| Default paste shortcut          | accelerator     | `<Ctrl>v`    | (implicit)               |
| Per-application paste shortcuts | list            | terminals    | app-paste-keybindings    |
| Show panel indicator            | on / off        | on           | indicator plugin         |
| Open history shortcut           | shortcut        | `<Super>v`   | (Diodon hotkey)          |
| Poll interval (ms)              | 100-5000        | 500          | none (Wayland-specific)  |

Per-application paste shortcuts are one `WM_CLASS|accelerator` per line, for
example `Alacritty|<Shift><Ctrl>v`. Find a window's `WM_CLASS` with Looking Glass
(`Alt+F2`, `lg`) or `xprop`.

## Compatibility

GNOME Shell 45, 46, 47, 48, 49, 50. Designed for Wayland sessions; the paste
mechanism also works on X11 sessions of these versions.

## Installation

From source, into the per-user extensions directory:

```sh
git clone https://github.com/VitalyOstanin/wayland-paste.git
ln -s "$PWD/wayland-paste" \
  ~/.local/share/gnome-shell/extensions/wayland-paste@VitalyOstanin
glib-compile-schemas ~/.local/share/gnome-shell/extensions/wayland-paste@VitalyOstanin/schemas/
```

Then re-login (Wayland) and enable:

```sh
gnome-extensions enable wayland-paste@VitalyOstanin
```

Open the settings with `gnome-extensions prefs wayland-paste@VitalyOstanin`.

## Development

```sh
node --check extension.js
node --check prefs.js
node --check lib/*.js
glib-compile-schemas schemas/
```

`node --check` validates ESM syntax without resolving `gi://` imports. The
upstream GNOME sources are checked out locally for API verification; see
`CLAUDE.md`.

## How it works

- `lib/clipboardMonitor.js` polls `St.Clipboard` because Wayland has no
  clipboard-change signal, and pushes new content into the history.
- `lib/historyStore.js` holds the entries and persists them to
  `~/.local/share/wayland-paste/` (images as files, the rest as `history.json`).
- `lib/indicator.js` is the panel button and the searchable, mouse-driven menu.
- `lib/paster.js` types the paste shortcut through a Clutter virtual input
  device (by evdev keycode, so it is layout-independent), the same mechanism as
  the on-screen keyboard.
- `extension.js` wires these together, records the focus target when the menu
  opens, and injects the paste shortly after the menu closes.

The rationale for each choice is in [docs/ADR](docs/ADR).

## Limitations

- GNOME Shell only (the in-process injection is GNOME-specific).
- Clipboard changes are detected by polling, so there is a small capture latency
  (the poll interval).
- Per-application paste shortcuts match by `WM_CLASS`, not by executable path as
  Diodon does.
- Rich content other than plain text and bitmap images is not stored.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
