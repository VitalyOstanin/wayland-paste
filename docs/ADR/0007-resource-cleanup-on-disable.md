# 0007 - Restore all touched state on disable

Status: Accepted

## Context

GNOME requires extensions to fully undo their effects in `disable()` (used on
lock screen, logout, and updates). Leaks of timers, key controllers, keybindings
or virtual devices cause warnings and degraded sessions.

## Decision

`disable()` reverses everything `enable()` did, in order:

- disconnect the settings `changed` handler;
- remove the `toggle-menu` keybinding;
- remove any pending paste timeout source;
- stop the clipboard poll timer;
- save the history if persistence is enabled, then drop the store;
- dispose the Clutter virtual input device (`Paster.destroy()`);
- destroy the panel indicator (which tears down its menu, search entry and the
  prefs-side key controller is on the prefs window, not here);
- null all references.

The poll timer, paste timeout, keybinding and virtual device are the resources
that would otherwise outlive the extension.

## Consequences

- Clean enable/disable cycles with no leaked sources or input devices.
- Persistence happens at disable time (and on clear), not continuously.
