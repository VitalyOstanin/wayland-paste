# TODO

Deferred tasks, not critical to functionality.

## Contents

- [Performance](#performance)
- [Verified findings, no action](#verified-findings-no-action)

## Performance

- **Incremental history menu update.** Currently `ClipboardIndicator._rebuild`
  calls `removeAll()` and recreates every Clutter actor in the list; `refresh()`
  while the menu is open is now debounced (a burst of changes coalesces into one
  rebuild), but the cost of a single rebuild with `history-size` up to 500
  remains. Switch to a diff update (add/remove only the changed items) instead of
  a full rebuild. File: `lib/indicator.js`.
- **Pre-built image thumbnails.** `lib/indicator.js` builds an `St.Icon` from a
  `Gio.FileIcon` pointing at the full-size image file. Loading is asynchronous on
  a thread pool (mutter `st_texture_cache` → `load_pixbuf_thread`), so the main
  loop is not blocked — this is not a stall, just extra worker work: a full-size
  file is decoded for a 48px icon. Build and cache a downscaled thumbnail when an
  image is added and load the icon from it.

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
