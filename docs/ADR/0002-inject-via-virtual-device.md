# 0002 - Inject paste via the in-process Clutter virtual device

Status: Accepted

## Context

To paste automatically, the chosen entry must be typed (Ctrl+V) into the focused
window. On Wayland there are two ways to synthesize input:

1. The XDG RemoteDesktop portal (D-Bus). This is what external programs such as
   Diodon, CopyQ and xdotool use. GNOME routes it through `gnome-remote-desktop`
   and raises a permission dialog plus a persistent screen-sharing indicator.
2. A Clutter virtual input device created inside the `gnome-shell` process:
   `Clutter.get_default_backend().get_default_seat().create_virtual_device(...)`.

A GNOME Shell extension runs inside the compositor, so it can use option 2. This
is exactly what the on-screen keyboard does (`js/ui/keyboard.js`), and it types
into applications with no portal session and no permission dialog.

Verified present and identical in shape on gnome-45 through gnome-50 (the
on-screen keyboard uses it on every version).

The device offers two ways to send a key: `notify_keyval(time, keyval, state)`
and `notify_key(time, evcode, state)`. `notify_keyval` reverse-maps the keyval to
a keycode *in the current keyboard group only* (mutter:
`pick_keycode_for_keyval_in_current_group`). Under a non-Latin layout (e.g.
Russian) the keyval for `v` has no keycode in the active group, so the press is
dropped (`No keycode found for keyval ... in current group`) and nothing pastes.

## Decision

Inject the paste shortcut with an in-process Clutter virtual keyboard device, the
same mechanism as the on-screen keyboard. Send keys by **evdev hardware keycode**
via `notify_key` — the physical key position, which is layout-independent, just
like physically pressing Ctrl+V. Press the modifiers, press the key, then release
in reverse order, using `GLib.get_monotonic_time()` as the event time (the OSK
uses `get_current_event_time() * 1000`, but that returns 0 outside an event
handler, and paste is injected from a timer). The keyval-to-evdev tables are in
`lib/paster.js`.

## Consequences

- No Remote Desktop dialog and no orange screen-sharing indicator, unlike an
  external clipboard manager on Wayland.
- Paste works under any keyboard layout, because the receiving toolkit matches the
  accelerator against the group-0 (Latin) keysym of the hardware key.
- The mechanism is GNOME-specific; the extension cannot work outside GNOME Shell.
- It depends on private compositor API stability; verified across 45-50 and
  re-checked when adding a version (see [0006](0006-support-gnome-45-to-50.md)).
