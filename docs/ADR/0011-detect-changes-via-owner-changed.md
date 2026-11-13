# 0011 - Detect clipboard changes via MetaSelection owner-changed

Status: Accepted

Supersedes [0005](0005-poll-the-clipboard.md).

## Context

ADR 0005 chose polling on the premise that a Shell extension gets no clipboard
change signal on Wayland. That premise is wrong: Mutter's selection manager,
`global.display.get_selection()` (`Meta.Selection`), emits
`owner-changed(selectionType, source)` whenever a selection gets a new owner.

Every copy creates a new owner, so the signal fires on every change:

- a Wayland client's `set_selection` creates a new data source;
- for X11 clients, Mutter turns each `XFixesSetSelectionOwnerNotify` into a new
  `MetaSelectionSource` (`src/x11/meta-x11-selection.c`), even when the same
  window takes the selection again;
- `St.Clipboard.set_text/set_content` installs a new memory source, so the
  extension's own writes fire it as well;
- an owner going away fires it with a `NULL` source.

`meta_selection_set_owner` returns early only when the very same source object
is set again, which does not happen on a copy.

Polling had a real cost: each tick called `St.Clipboard.get_text`, which
transfers the whole clipboard text into the Shell process and compares it with
the previous value, every 500 ms, even when nothing changed. With a large
clipboard (a copied web page) this is repeated work on the Shell main loop, and
the `max-text-length` threshold does not avoid it because the text has to be
read before it can be measured.

Since commit 20c6f6e the monitor already listened to `owner-changed` and kept
the poll timer only as a fallback.

## Decision

- Detect changes only through `owner-changed`. Remove the poll timer, the
  `poll-interval-ms` setting (schema key, preferences row, README row) and the
  `MIN_POLL_INTERVAL_MS` constants.
- Read only the slot that changed: `Meta.SelectionType.SELECTION_CLIPBOARD`
  maps to `St.ClipboardType.CLIPBOARD`, `SELECTION_PRIMARY` to `PRIMARY`; DND
  owner changes are ignored. The enum is read through GObject introspection, so
  the code does not depend on its numeric values.
- Read PRIMARY only once a selection is finished. A mouse or Shift selection
  replaces PRIMARY on every pointer step (about 50 owner changes for one slow
  mouse selection in kitty), and each would become a history entry. While the
  left button or Shift is held (`global.get_pointer()` modifier mask), a
  100 ms timer waits for the release and then reads PRIMARY once, the same
  acceptance rule Diodon applies (`check_button_state` in
  `libdiodon/primary-clipboard-manager.vala`). The timer exists only during a
  selection and is removed by `stop()`.
- Keep the rest of the pipeline unchanged: seeding the last-seen values on
  `start()`, `markSeen()` / `markSeenImage()` for the extension's own writes,
  synchronization, image reading, the ignore filter and `max-text-length`.

`markSeen()` keeps working although the signal is emitted synchronously inside
`set_text`: the handler only starts an asynchronous `get_text`, whose callback
runs after the caller has recorded the value as seen.

Verified on gnome-45 through gnome-51 in the local mutter checkouts:
`meta_display_get_selection` in `src/meta/display.h`, the `owner-changed`
signal with `(guint, MetaSelectionSource)` in `src/core/meta-selection.c`, and
the `MetaSelectionType` enum (`PRIMARY`, `CLIPBOARD`, `DND`) in
`src/meta/meta-selection-source.h` are identical on every branch. The GJS names
`Meta.SelectionType.SELECTION_PRIMARY` / `SELECTION_CLIPBOARD` were read from a
running GNOME 51 Shell. `shell_global_get_pointer` (`src/shell-global.h`) and
`CLUTTER_BUTTON1_MASK` / `CLUTTER_SHIFT_MASK` (`clutter/clutter-enums.h`) exist
on every branch as well.

## Consequences

- Nothing is read from the clipboard while it does not change; a copy is
  captured without the poll delay.
- The `poll-interval-ms` value stays in users' dconf as an unused key; GSettings
  ignores keys that are no longer in the schema.
- The poll timer mentioned in ADR 0001, 0007 and 0009 no longer exists; the
  monitor now owns a signal connection instead, which `stop()` disconnects.
- If a future Mutter stops emitting `owner-changed` for some source, changes
  from it would be missed instead of picked up late. The risk is low: Mutter
  itself relies on the signal for clipboard persistence
  (`src/core/meta-clipboard-manager.c`), for forwarding the selection to
  Wayland and X11 clients and for remote desktop clipboard sharing.
