# TODO

Deferred tasks, not critical to functionality.

## Contents

- [Verified findings, no action](#verified-findings-no-action)

## Verified findings, no action

project-check findings (2026-06-10), dismissed after reading the gnome-shell /
mutter sources on the `gnome-50` branch:

- **Synchronous `St.Clipboard.get_mimetypes()` on every poll tick** is not a
  blocking round-trip: `st_clipboard_get_mimetypes` →
  `meta_selection_get_mimetypes` → `meta_selection_source_wayland_get_mimetypes`
  returns a `g_list_copy_deep` of the already in-memory list of mimetype strings.
  This is a cheap local copy of a few strings; rewriting it as an async
  `get_content` chain is not needed (it would add more main-loop callbacks).
- **Thumbnail loading on the render thread** — see above: loading the `St.Icon` /
  `Gio.FileIcon` happens on a thread pool, not on the main loop; there is no jank.
