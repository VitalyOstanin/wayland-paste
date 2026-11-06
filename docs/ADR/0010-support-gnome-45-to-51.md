# 0010 - Declare and verify support for GNOME 45-51

Status: Accepted

Supersedes [0006](0006-support-gnome-45-to-50.md).

## Context

GNOME 51 was released. Every symbol in the CLAUDE.md API table must be checked
against the new version before it is declared.

## Decision

Add `"51"` to `shell-version`. Verified against gnome-shell and mutter tags 51.0
and 51.1:

- `Main.panel.addToStatusArea()`, `Main.wm.addKeybinding()`/`removeKeybinding()`
  and `PanelMenu.Button` keep their signatures;
- `PopupMenu.PopupBaseMenuItem` became an ES class registered in a static block,
  and `PopupMenu.open()`/`close()` now take a parameter object instead of an
  animation flag. The extension only constructs items and sections, calls
  `addMenuItem()` and `toggle()`, and never passes arguments to `open()` or
  `close()`, so nothing changes for it;
- `src/st/st-clipboard.h` is unchanged;
- `clutter_seat_create_virtual_device()` and
  `clutter_virtual_input_device_notify_key()` are unchanged;
- `MetaDisplay:focus-window`, `meta_window_get_wm_class()` and
  `meta_window_get_wm_class_instance()` are unchanged.

## Consequences

- The same code base covers 45-51 without per-version branching.
- The verification procedure in [CLAUDE.md](../../CLAUDE.md) must be re-run for
  the next GNOME release.
