# 0003 - Capture the focus target on open, paste after the menu closes

Status: Accepted

## Context

The history is a standard `PopupMenu`, which takes a modal grab when it opens.
While the grab is held, the keyboard focus belongs to the Shell, not to the
target window. Injected key events go to whatever holds the keyboard focus, so
pasting while the menu is open would type into the Shell, not the application.
The paste must therefore wait until the menu closes and focus returns.

The menu is driven by mouse only (like the on-screen keyboard). Keyboard
navigation (arrows + Enter) was tried but dropped: the Enter that activates an
entry is still physically held when the menu closes, and returning focus while it
is down made the application either swallow the user's next Enter or repeat a
newline. Restricting activation to the pointer removes that entire class of
focus/timing races.

## Decision

- On `open-state-changed(open=true)`, record `global.display.focus_window` as the
  paste target. The modal grab does not change the Meta focus window, so this is
  the application that was focused before the menu opened.
- On activating an entry (mouse click), set the clipboard, promote the entry, and
  remember the target as "pending" only if instant paste is enabled.
- The activated item closes the menu. On `open-state-changed(open=false)`, if a
  paste is pending, wait `PASTE_DELAY_MS` (120 ms) for the modal grab to release
  and the keyboard focus to return to the target, then inject the paste shortcut.

## Consequences

- Mouse selection pastes into the correct window with no held-key artifacts.
- The 120 ms delay is a heuristic for the focus hand-back; it is short enough to
  feel immediate. If a future GNOME changes focus-restoration timing, this is the
  value to revisit.
- Closing the menu without activating an entry (Escape, click-away) leaves the
  pending target unset, so nothing is pasted.
