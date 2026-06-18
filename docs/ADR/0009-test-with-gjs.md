# 0009 - Run unit tests under gjs, without a node test framework

Status: Accepted

## Context

`HistoryStore` (`lib/historyStore.js`) carries logic worth testing in isolation:
deduplication of identical entries, eviction once the history is full, and the
load-time deduplication in `_parse` that guards against a `load()`/polling race
duplicating a persisted entry.

The module is not plain JavaScript. It imports `gi://GLib` and `gi://Gio` at the
top level, calls `Gio._promisify(...)` on import, and uses `GLib.get_real_time()`
in the code paths under test. These `gi://` specifiers are resolved by `gjs`, the
GNOME JavaScript interpreter; they do not resolve under Node.js. A Node-based
runner such as vitest or jest cannot import the module without mocking the entire
GNOME platform layer, and the project has no `package.json` — it is a GNOME Shell
extension, not a Node package, so adding a Node toolchain would introduce a
dependency and build step that nothing else here needs.

## Decision

Test under `gjs`, the same interpreter that runs the extension. Tests live in
`tests/*.test.js` as ESM modules that import the real `lib/` modules and assert
with a small in-file `check()` helper (no test framework). `tests/run.sh`
executes every test file with `gjs -m` and fails the run if any file exits
non-zero.

Tests cover only the text and JSON-parse paths of `HistoryStore`, which touch no
disk (file I/O happens only in `save`/`load` and when writing image entries), so
a run leaves no files behind.

## Consequences

- The code is exercised in the environment it actually runs in; no GNOME
  platform mocking and no node/npm toolchain.
- No assertion library, fixtures, watch mode, or coverage reporting — the helper
  is deliberately minimal. Richer tooling would mean reintroducing a Node layer
  or building a gjs harness, neither of which the current scope justifies.
- Logic that depends on disk or live clipboard state (image file writes, the
  monitor's polling) is not unit-tested here; it is verified by the manual
  functional run before publishing.
- Running the tests requires `gjs` on `PATH` (already present wherever GNOME
  Shell runs); `tests/run.sh` reports a clear error if it is missing.
