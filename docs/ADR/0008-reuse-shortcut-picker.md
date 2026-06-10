# 0008 - Reuse the mute-all-mics shortcut picker for the menu hotkey

Status: Accepted

## Context

The menu can be opened with a configurable shortcut (`toggle-menu`). Editing a
shortcut as raw accelerator text is error-prone. The author's `mute-all-mics`
extension already has an interactive capture picker (`ShortcutRow`) that behaves
like the one in GNOME Settings: click the row, press the combination, with
Backspace to clear and Escape to cancel, plus the GNOME Settings validation rules
(a bare letter/digit needs a modifier).

## Decision

Reuse that `ShortcutRow` pattern in `prefs.js` for the `toggle-menu` key: a
self-contained `Adw.ActionRow` with a `Gtk.ShortcutLabel`, a clear button, and a
`Gtk.EventControllerKey` in the capture phase attached to the window root. The
`hotkey-initialized` seeding logic specific to mute-all-mics is dropped, since
there is no stock shortcut to seed from.

The per-application paste shortcuts (`paste-keybindings`) and the default paste
accelerator (`default-paste-keybinding`) remain plain text fields: they are GTK
accelerator strings injected into other apps, not Shell keybindings captured from
the user, and the per-app list pairs each accelerator with a `WM_CLASS`.

## Consequences

- The menu hotkey is set the same way as in GNOME Settings and the author's other
  extensions.
- The validation rules are duplicated from mute-all-mics (which took them from
  night-theme-switcher); a fix in one should be mirrored.
