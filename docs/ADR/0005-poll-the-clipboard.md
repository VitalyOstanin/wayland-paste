# 0005 - Poll the clipboard (no Wayland change signal)

Status: Accepted

## Context

On X11, Diodon learns of clipboard changes from selection-owner notifications.
Wayland exposes no clipboard-change signal to a Shell extension: `St.Clipboard`
offers `get_text` / `get_content` / `get_mimetypes` / `set_text` / `set_content`,
but no "owner-changed" event. Other GNOME clipboard managers (for example
Clipboard Indicator) poll for the same reason.

## Decision

Poll `St.Clipboard` on a timer (`poll-interval-ms`, default 500 ms) in
`lib/clipboardMonitor.js`. Read CLIPBOARD and/or PRIMARY per the `use-clipboard`
/ `use-primary` settings, compare against the last seen value to detect changes,
apply the ignore filter, and push new content into the history. When the
extension sets the clipboard itself (on paste or on synchronization), it calls
`markSeen()` so the write is not recorded as a new entry.

## Consequences

- There is a small capture latency (up to one interval) and a small, bounded CPU
  cost. The interval is user-configurable.
- Image polling reads clipboard content only when `add-images` is on and the
  available mime types include an image, to avoid copying large buffers on every
  tick.
- `St.Clipboard.get_text/get_content/get_mimetypes/set_text/set_content` were
  verified present on gnome-45 and gnome-50 (`src/st/st-clipboard.h`).
